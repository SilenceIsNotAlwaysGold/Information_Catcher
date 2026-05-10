// Pulse Helper — service worker
// 职责：
//   1. 维持到 Pulse 服务器的 WebSocket 长连接（chrome.alarms 心跳保活，绕开 SW 30s 闲置回收）
//   2. 收到 task 后调度 content script / fetch hook 执行
//   3. popup ↔ background 用 chrome.runtime.onMessage 通信
//
// 任务消息协议（服务器 → 扩展）:
//   { id: "uuid", type: "echo|xhs.search|douyin.search|...", payload: {...}, deadline_ts: 1700000000 }
// 结果回传（扩展 → 服务器）:
//   { id: "uuid", ok: true|false, data: {...}, error: "..." }

const HEARTBEAT_ALARM = "pulse_heartbeat";
const RECONNECT_ALARM = "pulse_reconnect";

// ===== 全局状态（service worker 重启时丢失，重连时重建）=====
let ws = null;
let connected = false;
let serverUrl = "";
let token = "";
let lastTaskLog = []; // popup 展示，最多 10 条

// 与 popup.js 的 cleanServerUrl 保持一致：剥掉 path、查询串、重复 protocol 残留
// 找第二次出现的 http(s):// 是关键 —— 字符类贪婪匹配会吃掉 "https" 五个字母停不住
function cleanServerUrl(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  const protoMatch = s.match(/^(https?:\/\/)/i);
  const proto = protoMatch[1].toLowerCase();
  let rest = s.slice(protoMatch[1].length);
  const dup = rest.search(/https?:\/\//i);
  if (dup >= 0) {
    rest = rest.slice(0, dup);
    rest = rest.replace(/(https?)$/i, "");
  }
  rest = rest.split(/[/?#]/)[0];
  rest = rest.replace(/[.\-]+$/, "");
  if (!/^[A-Za-z0-9\-._]+(?::\d+)?$/.test(rest)) return "";
  return proto + rest;
}

async function loadConfig() {
  const cfg = await chrome.storage.local.get(["serverUrl", "token"]);
  const cleaned = cleanServerUrl(cfg.serverUrl);
  // 如果 storage 里的值是脏的（含重复 protocol / 多余 path），写回清洗后的值
  if (cleaned && cleaned !== cfg.serverUrl) {
    try { await chrome.storage.local.set({ serverUrl: cleaned }); } catch {}
    console.log("[pulse] cleaned dirty serverUrl:", cfg.serverUrl, "→", cleaned);
  }
  serverUrl = cleaned;
  token = cfg.token || "";
}

function logTask(entry) {
  lastTaskLog.unshift({ ...entry, ts: Date.now() });
  lastTaskLog = lastTaskLog.slice(0, 20);
  chrome.storage.local.set({ lastTaskLog });
}

function notifyPopup(action, data = {}) {
  chrome.runtime.sendMessage({ from: "bg", action, data }).catch(() => {
    // popup 未打开时报错，忽略即可
  });
}

// ===== WebSocket 管理 =====
function buildWsUrl() {
  if (!serverUrl || !token) return "";
  // 双保险：建 ws 那一刻再洗一次 serverUrl，杜绝任何脏数据漏过来
  const cleaned = cleanServerUrl(serverUrl);
  if (!cleaned) return "";
  if (cleaned !== serverUrl) {
    console.warn("[pulse] runtime sanitize serverUrl:", serverUrl, "→", cleaned);
    serverUrl = cleaned;
    try { chrome.storage.local.set({ serverUrl: cleaned }); } catch {}
  }
  const u = new URL(cleaned);
  const proto = u.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${u.host}/api/extension/ws?token=${encodeURIComponent(token)}`;
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  const url = buildWsUrl();
  if (!url) {
    console.warn("[pulse] no serverUrl/token, skip connect");
    return;
  }
  console.log("[pulse] connecting to", url);
  try {
    ws = new WebSocket(url);
  } catch (e) {
    console.error("[pulse] ws constructor failed", e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    connected = true;
    console.log("[pulse] ws connected");
    notifyPopup("status", { connected: true });
    // 注册扩展实例信息
    sendEnvelope({
      type: "hello",
      ua: navigator.userAgent,
      ext_version: chrome.runtime.getManifest().version,
    });
    chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 }); // 30s
  };

  ws.onmessage = async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (e) {
      console.warn("[pulse] non-json msg", ev.data);
      return;
    }
    if (msg.type === "pong") return;
    if (msg.type === "task") {
      await handleTask(msg.task);
    }
  };

  ws.onerror = (e) => {
    console.warn("[pulse] ws error", e?.message || e);
  };

  ws.onclose = (ev) => {
    connected = false;
    // 打出 close code / reason / wasClean 以便诊断
    console.log("[pulse] ws closed", {
      code: ev?.code,
      reason: ev?.reason,
      wasClean: ev?.wasClean,
    });
    notifyPopup("status", { connected: false });
    chrome.alarms.clear(HEARTBEAT_ALARM);
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  // 5 秒后重连（alarm 最低 0.083 = 5s 在 chrome 138+ 才放开，老版本最低 1min；用 setTimeout 兜底）
  setTimeout(() => connect(), 5000);
}

function sendEnvelope(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(obj));
    return true;
  } catch (e) {
    console.warn("[pulse] send failed", e);
    return false;
  }
}

// ===== Alarms（保活 + 重连）=====
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendEnvelope({ type: "ping", ts: Date.now() });
    } else {
      connect();
    }
  } else if (alarm.name === RECONNECT_ALARM) {
    connect();
  }
});

// ===== 任务执行 =====
async function handleTask(task) {
  const { id, type, payload } = task || {};
  console.log("[pulse] task", id, type, payload);
  logTask({ id, type, status: "running" });
  notifyPopup("task", { id, type, status: "running" });

  let result;
  try {
    result = await dispatchTask(type, payload || {});
    sendEnvelope({ type: "result", id, ok: true, data: result });
    logTask({ id, type, status: "done" });
    notifyPopup("task", { id, type, status: "done" });
  } catch (e) {
    const msg = e?.message || String(e);
    console.error("[pulse] task failed", id, type, msg, e?.debug);
    sendEnvelope({
      type: "result",
      id,
      ok: false,
      error: msg,
      debug: e?.debug || null,
    });
    logTask({ id, type, status: "failed", error: msg });
    notifyPopup("task", { id, type, status: "failed", error: msg });
  }
}

// 任务派发表（每种 type 一个执行器）
async function dispatchTask(type, payload) {
  if (type === "echo") {
    return { echoed: payload };
  }
  if (type === "ping_browser") {
    // 发个桌面通知，证明扩展活着
    chrome.notifications.create("", {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: "Pulse Helper",
      message: payload.message || "ping",
    });
    return { ok: true };
  }
  if (type === "xhs.search") {
    return await runXhsSearch(payload);
  }
  if (type === "douyin.search") {
    return await runDouyinSearch(payload);
  }
  if (type === "xhs.creator_posts") {
    return await runXhsCreatorPosts(payload);
  }
  if (type === "douyin.creator_posts") {
    return await runDouyinCreatorPosts(payload);
  }
  if (type === "xhs.fetch_comments") {
    return await runXhsFetchComments(payload);
  }
  if (type === "douyin.fetch_comments") {
    return await runDouyinFetchComments(payload);
  }
  if (type === "douyin.live_status") {
    return await runDouyinLiveStatus(payload);
  }
  if (type === "xhs.note_detail") {
    return await runXhsNoteDetail(payload);
  }
  if (type === "douyin.note_detail") {
    return await runDouyinNoteDetail(payload);
  }
  if (type === "xhs.publish" || type === "douyin.publish") {
    return await runPublishTask(type, payload);
  }
  throw new Error(`unknown task type: ${type}`);
}

// ===== XHS 搜索任务 =====
//
// 流程：
//   1. 开一个非活动 tab，URL = about:blank（先 inject hook 再导航，确保 hook 早于 React 应用）
//   2. 用 chrome.scripting.executeScript 把 page_hook.js 注入 main world
//      把 content/xhs.js 注入 isolated world (虽然 manifest 静态注入也行，但动态更可控)
//   3. tab.update 跳到真实搜索 URL
//   4. content/xhs.js 收到 background 的 capture_xhs 指令开始捕获 fetch
//   5. 滚动几下触发懒加载 + 翻页
//   6. 等到 timeout 或捕获到至少 N 条，回收数据，关 tab
//
// payload 字段:
//   keyword: 必填
//   min_likes: 过滤低赞作品（默认 0）
//   timeout_ms: 默认 25000
//   pages: 滚动触发翻页次数（默认 2）

async function runXhsSearch(payload) {
  const keyword = String(payload?.keyword || "").trim();
  if (!keyword) throw new Error("keyword required");
  const minLikes = Number(payload?.min_likes || 0);
  const timeoutMs = Math.max(8000, Number(payload?.timeout_ms || 25000));
  const pages = Math.max(1, Math.min(5, Number(payload?.pages || 2)));

  // hook 由 manifest content_scripts 在 document_start 自动注入到 MAIN world，
  // content/xhs.js 在 document_idle 注入到 isolated world —— 这里不需要再 executeScript。
  const url = `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(keyword)}&source=web_explore_feed&type=51`;
  const { tabId, windowId } = await openWorkerTab(url);

  try {
    // 等导航完成（content/xhs.js 也在 idle 时已经注入好）
    await waitForTabComplete(tabId, 15000);
    // 给 React 应用一点点时间初始化
    await sleep(800);

    // 触发 content 开始捕获 — 用宽 pattern 覆盖小红书可能的几种搜索接口路径
    let resp;
    try {
      resp = await chrome.tabs.sendMessage(tabId, {
        from: "bg",
        action: "capture_xhs",
        urlPattern: ["/search/notes", "/search/general", "/search/feed", "/search/items"],
        timeout_ms: timeoutMs,
        min_hits: 1,
      });
    } catch (e) {
      // content script 没注入成功（罕见，例如页面是 chrome:// 或 about: error）
      throw new Error(`content script not ready: ${e?.message || e}`);
    }

    // 边等边滚（在主等待 promise 内并行触发懒加载）
    (async () => {
      for (let i = 0; i < pages; i++) {
        try {
          await chrome.tabs.sendMessage(tabId, { from: "bg", action: "scroll", dy: 1200 });
        } catch {}
        await sleep(2500);
      }
    })().catch(() => {});

    // resp 是 captureFor 的返回（同步链路下其实滚动还在异步进行，captureFor 内部会等够 timeout）
    // 重新发一遍 capture 让滚动后的数据都收齐？不，captureFor 已经在收，等它结束就行
    // 拿到 tab 当前真实 URL（用于诊断是否被重定向到 /login）
    let finalUrl = "";
    try {
      const t = await chrome.tabs.get(tabId);
      finalUrl = t.url || "";
    } catch {}

    if (!resp || (!resp.ok && (resp.hits?.length || 0) === 0)) {
      const code = classifyFailure(resp, finalUrl);
      const err = new Error(code);
      err.debug = {
        seen_urls: resp?.seen_urls || [],
        final_tab_url: finalUrl,
      };
      throw err;
    }

    const notes = extractXhsNotes(resp.hits || []);
    const filtered = notes.filter((n) => (n.liked_count || 0) >= minLikes);
    return {
      keyword,
      raw_hits: (resp.hits || []).length,
      total: notes.length,
      filtered_count: filtered.length,
      notes: filtered,
      seen_urls_sample: (resp.seen_urls || []).slice(-30),
    };
  } finally {
    await closeWorkerWindow(windowId);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ===== 抓取用 worker tab 创建：绕过后台 tab Timer Throttling =====
//
// 为什么不用 chrome.tabs.create({active:false}):
//   后台 hidden tab 在 Chrome 里会被 Timer Throttling — setTimeout/setInterval
//   被降到 1/min。SPA 内部用 setTimeout 触发的 fetch 会被推迟，导致 hook
//   30 秒等不到 search/notes / user_posted 接口。
//
// 解决：用 chrome.windows.create 开一个独立的 minimized + unfocused popup 窗口，
// 这种窗口里的 tab 不被节流，SPA 全速运行。用户视觉上不会被打扰（最小化）。
//
// 返回 { tabId, windowId }，后续 finally 用 chrome.windows.remove(windowId) 关掉。
// 全局复用一个 worker window，避免每次抓取都新开窗口闪用户屏幕。
// 抓取流程：
//   1. 检查 _workerWindow 是否还存在且活着 → 是，update({focused:true,url}) 复用
//   2. 不存在或已关闭 → 创建新 popup window
//   3. 抓完不关闭，update({state:"minimized"}) 转后台（用户视觉上是 dock 里一个小图标）
let _workerWindow = null;  // {windowId, tabId}

async function _isWindowAlive(windowId) {
  if (!windowId) return false;
  try {
    await chrome.windows.get(windowId);
    return true;
  } catch { return false; }
}

// 安全 bounds：800x550 足够小，在常见显示器（含 13" 笔记本）都能容纳 ≥50% 可见区
const SAFE_BOUNDS = { left: 80, top: 80, width: 800, height: 550 };

async function openWorkerTab(url) {
  // 复用：worker window 还在 → 先恢复成 normal+focused 状态，再 navigate 新 URL。
  // 顺序很重要：如果在 minimized 状态下 navigate，SPA 会被 timer throttling 拦住。
  if (_workerWindow && await _isWindowAlive(_workerWindow.windowId)) {
    try {
      // 1. 先恢复 + 显式拉回安全 bounds，避免 Chrome 用旧 bounds（可能在屏幕外）校验失败
      await chrome.windows.update(_workerWindow.windowId, {
        focused: true, state: "normal", ...SAFE_BOUNDS,
      });
      // 2. 等一帧让窗口状态切换生效
      await sleep(150);
      // 3. 再导航 tab
      await chrome.tabs.update(_workerWindow.tabId, { url, active: true });
      return { tabId: _workerWindow.tabId, windowId: _workerWindow.windowId };
    } catch (e) {
      // 旧 worker window 不可恢复（bounds 失败 / tab 已挂）→ 销毁后重建
      try { await chrome.windows.remove(_workerWindow.windowId); } catch {}
      _workerWindow = null;
    }
  }
  // 新建：focused=true 让 SPA 不被 throttle 跑通首屏；
  // 走过的弯路：minimized/屏幕外/active:false 都被 timer throttling 拦住或 API 拒绝。
  let win;
  try {
    win = await chrome.windows.create({
      url, type: "popup", focused: true, ...SAFE_BOUNDS,
    });
  } catch (e) {
    // 极端情况下 bounds 还是被拒（屏幕分辨率太小），让 Chrome 自己决定位置
    win = await chrome.windows.create({ url, type: "popup", focused: true });
  }
  const tab = win.tabs && win.tabs[0];
  if (!tab) throw new Error("failed to create worker window");
  _workerWindow = { windowId: win.id, tabId: tab.id };
  return { tabId: tab.id, windowId: win.id };
}

// 抓完不真正关掉，转后台 minimize。下次抓取时 focus 复活。
async function closeWorkerWindow(windowId) {
  if (!windowId) return;
  try {
    // minimize 而非 remove —— 复用，避免每次都开新窗口
    await chrome.windows.update(windowId, { state: "minimized" });
  } catch {
    // window 已经被用户关掉了，重置
    if (_workerWindow && _workerWindow.windowId === windowId) {
      _workerWindow = null;
    }
  }
}

// 把抓取失败原因归类为后端能翻译的稳定 code。优先级：
//   captcha_required > login_required > no_response_captured
// 后端 `_translate_extension_error()` 据此给用户友好中文提示。
function classifyFailure(resp, finalUrl) {
  if (resp?.error === "captcha_required") return "captcha_required";
  const u = String(finalUrl || "").toLowerCase();
  if (u.includes("/login") || u.includes("redirectpath=") || u.includes("/sign_in")) {
    return "login_required";
  }
  return resp?.error || "no_response_captured";
}

// 宽松版 ready 检测：
//   - 不要求 tab status='complete'（SPA 轮询/直播流永远不 complete）
//   - 不强制 content script ping 成功
//   - 至多等 timeoutMs，能 ping 通就提前 resolve；ping 不通也 resolve（让后续 capture 自己 try）
//   - 永远不 reject —— 抓不到的最差结果是 capture 阶段超时，错误提示更精准
function waitForTabReady(tabId, timeoutMs = 18000) {
  return new Promise((resolve) => {
    const start = Date.now();
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      resolve();
    };
    const tryPing = async () => {
      if (resolved) return;
      try {
        const resp = await chrome.tabs.sendMessage(tabId, { from: "bg", action: "__ping" });
        if (resp?.pong || resp?.ok) {
          // ping 通了，再多给 1.5 秒让 SPA 跑首屏 fetch
          setTimeout(done, 1500);
          return;
        }
      } catch {
        // 还没注入，下个 tick 重试
      }
      if (Date.now() - start >= timeoutMs) {
        // 超时，无脑放行（capture 阶段会自己处理）
        done();
        return;
      }
      setTimeout(tryPing, 600);
    };
    // 启动后等 1 秒再首次 ping，给 content_script 一点注入时间
    setTimeout(tryPing, 1000);
  });
}

// 兼容旧调用点
function waitForTabComplete(tabId, timeoutMs) {
  return waitForTabReady(tabId, timeoutMs || 18000);
}

function extractXhsNotes(hits) {
  const out = [];
  const seen = new Set();
  for (const h of hits) {
    const body = h.body || {};
    // /api/sns/web/v1/search/notes 返回 {data: {items: [{id, model_type:"note", note_card:{...}}, ...]}}
    const items = body?.data?.items || [];
    for (const item of items) {
      const note = item.note_card || item;
      const noteId = item.id || note.id || note.note_id;
      if (!noteId || seen.has(noteId)) continue;
      seen.add(noteId);

      const interact = note.interact_info || {};
      const cover = note.cover || {};
      const user = note.user || {};
      out.push({
        note_id: String(noteId),
        title: (note.display_title || note.title || "").slice(0, 200),
        liked_count: parseCount(interact.liked_count),
        cover_url: cover.url_default || cover.url_pre || cover.url || "",
        author: user.nick_name || user.nickname || "",
        author_id: user.user_id || user.userId || "",
        xsec_token: item.xsec_token || note.xsec_token || "",
        note_type: note.type || "normal",
        url: `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=${item.xsec_token || ""}&xsec_source=app_share`,
      });
    }
  }
  return out;
}

// ===== 抖音搜索任务 =====
async function runDouyinSearch(payload) {
  const keyword = String(payload?.keyword || "").trim();
  if (!keyword) throw new Error("keyword required");
  const minLikes = Number(payload?.min_likes || 0);
  const timeoutMs = Math.max(8000, Number(payload?.timeout_ms || 30000));
  const pages = Math.max(1, Math.min(5, Number(payload?.pages || 2)));

  const url = `https://www.douyin.com/search/${encodeURIComponent(keyword)}?type=video`;
  const { tabId, windowId } = await openWorkerTab(url);

  try {
    await waitForTabComplete(tabId, 18000);
    await sleep(1200); // 抖音 React 应用初始化稍慢

    let resp;
    try {
      resp = await chrome.tabs.sendMessage(tabId, {
        from: "bg",
        action: "capture_douyin",
        timeout_ms: timeoutMs,
        min_hits: 1,
      });
    } catch (e) {
      throw new Error(`douyin content script not ready: ${e?.message || e}`);
    }

    (async () => {
      for (let i = 0; i < pages; i++) {
        try {
          await chrome.tabs.sendMessage(tabId, { from: "bg", action: "scroll", dy: 1500 });
        } catch {}
        await sleep(2800);
      }
    })().catch(() => {});

    let finalUrl = "";
    try { finalUrl = (await chrome.tabs.get(tabId)).url || ""; } catch {}

    if (!resp || (!resp.ok && (resp.hits?.length || 0) === 0)) {
      const code = classifyFailure(resp, finalUrl);
      const err = new Error(code);
      err.debug = { seen_urls: resp?.seen_urls || [], final_tab_url: finalUrl };
      throw err;
    }

    const items = extractDouyinItems(resp.hits || []);
    const filtered = items.filter((n) => (n.liked_count || 0) >= minLikes);
    return {
      keyword,
      raw_hits: (resp.hits || []).length,
      total: items.length,
      filtered_count: filtered.length,
      notes: filtered,
      seen_urls_sample: (resp.seen_urls || []).slice(-30),
    };
  } finally {
    await closeWorkerWindow(windowId);
  }
}

function extractDouyinItems(hits) {
  const out = [];
  const seen = new Set();
  for (const h of hits) {
    const body = h.body || {};
    // /aweme/v1/web/general/search/single 返回 {data: [{aweme_info: {...}}, ...]}
    // /aweme/v1/web/search/item 返回 {data: [...]} 或 {aweme_list: [...]}
    const items = body.data || body.aweme_list || [];
    for (const item of items) {
      const aweme = item.aweme_info || item.aweme || item;
      if (!aweme || typeof aweme !== "object") continue;
      const aid = aweme.aweme_id || aweme.awemeId || aweme.id;
      if (!aid || seen.has(aid)) continue;
      seen.add(aid);

      const stats = aweme.statistics || {};
      const author = aweme.author || {};
      const video = aweme.video || {};
      const cover = video.cover || video.origin_cover || {};
      const coverList = cover.url_list || [];
      const play = video.play_addr || {};
      const playList = play.url_list || [];

      out.push({
        aweme_id: String(aid),
        title: (aweme.desc || "").slice(0, 200),
        liked_count: parseCount(stats.digg_count),
        collected_count: parseCount(stats.collect_count),
        comment_count: parseCount(stats.comment_count),
        author: author.nickname || author.nick_name || "",
        author_id: author.uid || author.sec_uid || "",
        cover_url: coverList[0] || "",
        video_url: playList[0] || "",
        note_type: "video",
        url: `https://www.iesdouyin.com/share/video/${aid}/`,
      });
    }
  }
  return out;
}

// ===== 博主追新（xhs / 抖音）=====
//
// xhs：URL 形如 https://www.xiaohongshu.com/user/profile/{uid}
//      拦 /api/sns/web/v1/user_posted
// 抖音：URL 形如 https://www.douyin.com/user/{sec_uid}
//      拦 /aweme/v1/web/aweme/post

async function runXhsCreatorPosts(payload) {
  const url = String(payload?.url || "").trim();
  if (!url) throw new Error("url required");
  const { tabId, windowId } = await openWorkerTab(url);
  try {
    await waitForTabComplete(tabId, 15000);
    await sleep(800);
    const resp = await chrome.tabs.sendMessage(tabId, {
      from: "bg",
      action: "capture_xhs",
      // 同时拦帖子列表 + 博主元信息（粉丝数 / 获赞 / 头像在 user/otherinfo）
      urlPattern: ["/v1/user_posted", "/v1/feed", "/user/otherinfo"],
      timeout_ms: payload?.timeout_ms || 25000,
      min_hits: 1,
    });
    let finalUrl = "";
    try { finalUrl = (await chrome.tabs.get(tabId)).url || ""; } catch {}
    let { posts, profile } = extractXhsCreatorPosts(resp?.hits || []);
    let ssrDebug = null;
    // XHR 完全没拿到时不要立刻 throw —— 博主主页大多 SSR 不发 user_posted XHR，
    // 先尝试从 window.__INITIAL_STATE__ 读 SSR 数据，能拿到就当成功。
    // SSR 兜底：博主主页大多 SSR，user/otherinfo XHR 不一定发。
    // 让 content 透 window.__INITIAL_STATE__.user 出来，从中补 profile + 缺封面的 posts。
    try {
      const ssrResp = await chrome.tabs.sendMessage(tabId, {
        from: "bg", action: "get_initial_state", timeout_ms: 2000,
      });
      const ssrUser = ssrResp?.data;
      ssrDebug = ssrResp?.debug || null;
      if (ssrUser) {
        const ssr = extractXhsCreatorFromSsr(ssrUser);
        // profile：缺什么补什么（XHR 拿到的优先）
        profile = {
          ...ssr.profile,
          ...Object.fromEntries(Object.entries(profile || {}).filter(([, v]) => v)),
        };
        // posts：以 XHR 抓到的为主；XHR 一无所获时用 SSR；
        // 都有时按 post_id 合并，SSR 字段补缺（封面/标题）
        if (ssr.posts.length) {
          if (posts.length === 0) {
            posts = ssr.posts;
          } else {
            const byId = new Map(posts.map((p) => [p.post_id, p]));
            for (const sp of ssr.posts) {
              const ex = byId.get(sp.post_id);
              if (!ex) {
                byId.set(sp.post_id, sp);
              } else {
                if (!ex.cover_url && sp.cover_url) ex.cover_url = sp.cover_url;
                if (!ex.title && sp.title) ex.title = sp.title;
                if (!ex.liked_count && sp.liked_count) ex.liked_count = sp.liked_count;
              }
            }
            posts = Array.from(byId.values());
          }
        }
      }
    } catch (e) {
      console.warn("[pulse] xhs SSR fallback failed:", e?.message || e);
    }
    // XHR + SSR 都拿不到任何东西才算失败
    if (posts.length === 0 && !(profile && profile.creator_name)) {
      const code = classifyFailure(resp, finalUrl);
      const e = new Error(code);
      e.debug = { seen_urls: resp?.seen_urls || [], final_tab_url: finalUrl };
      throw e;
    }
    return {
      url, raw_hits: (resp?.hits || []).length, total: posts.length, posts,
      profile,
      ssr_debug: ssrDebug,
      seen_urls_sample: (resp?.seen_urls || []).slice(-30),
    };
  } finally {
    await closeWorkerWindow(windowId);
  }
}

// 从 window.__INITIAL_STATE__.user 子树解析博主 profile + 笔记列表
// 小红书结构（不同版本路径有差异）：
//   user.userPageData.basicInfo: { nickname, imageb, desc, ... }
//   user.userPageData.interactions: [{ type:"fans"|"follows"|"interaction", count:"1.2万" }]
//   user.notes: [[{id, displayTitle, cover:{urlDefault}, interactInfo:{likedCount}, ...}, ...], ...]
function extractXhsCreatorFromSsr(state) {
  const out = { profile: {}, posts: [] };
  if (!state || typeof state !== "object") return out;
  // 1. 找 basicInfo / interactions
  const upd = state.userPageData || state;
  const basic = upd.basicInfo || state.basicInfo || {};
  const interactions = upd.interactions || state.interactions || basic.interactions || [];
  const interMap = {};
  for (const it of interactions) {
    if (it && it.type) interMap[String(it.type).toLowerCase()] = it.count;
  }
  out.profile = {
    creator_name: basic.nickname || state.nickname || "",
    avatar_url: basic.imageb || basic.images?.[0] || basic.avatar || state.imageb || "",
    followers_count: parseCount(interMap.fans || basic.fans),
    following_count: parseCount(interMap.follows || basic.follows),
    likes_count: parseCount(interMap.interaction || basic.interactions || basic.interactions_count),
    notes_count: parseCount(basic.notes || upd.notes_count || state.notesNum),
    desc: (basic.desc || state.desc || "").slice(0, 200),
  };
  // 2. 笔记列表（二维或一维）
  const candidates = [upd.notes, upd.feeds, state.notes, state.feeds];
  let flat = [];
  for (const arr of candidates) {
    if (!arr) continue;
    if (Array.isArray(arr)) {
      for (const x of arr) {
        if (Array.isArray(x)) flat.push(...x);
        else if (x && typeof x === "object") flat.push(x);
      }
    }
    if (flat.length) break;
  }
  for (const n of flat) {
    const noteId = n.id || n.noteId || n.note_id;
    if (!noteId) continue;
    const cover = n.cover?.urlDefault || n.cover?.url_default || n.cover?.url || n.coverUrl || "";
    const inter = n.interactInfo || n.interact_info || {};
    out.posts.push({
      post_id: String(noteId),
      title: (n.displayTitle || n.title || "").slice(0, 200),
      url: `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=${n.xsecToken || n.xsec_token || ""}`,
      xsec_token: n.xsecToken || n.xsec_token || "",
      cover_url: cover,
      liked_count: parseCount(inter.likedCount || inter.liked_count),
      note_type: n.type === "video" ? "video" : "normal",
      creator_name: out.profile.creator_name,
    });
  }
  return out;
}

function extractXhsCreatorPosts(hits) {
  const out = [];
  const seen = new Set();
  let profile = {};

  for (const h of hits) {
    const url = h.url || "";
    const body = h.body || {};

    // 1) /user/otherinfo → 博主元信息（粉丝、获赞、头像、简介、性别等）
    if (url.includes("/user/otherinfo")) {
      const data = body?.data || body || {};
      const interactions = data.interactions || data.interaction_info || [];
      const interMap = {};
      for (const it of interactions) {
        if (it && it.type) interMap[String(it.type).toLowerCase()] = it.count;
      }
      profile = {
        creator_name: data.nickname || data.basic_info?.nickname || profile.creator_name || "",
        avatar_url:
          data.images?.[0] ||
          data.imageb ||
          data.basic_info?.imageb ||
          data.basic_info?.images?.[0] ||
          profile.avatar_url || "",
        followers_count: parseCount(interMap.fans || data.fans || data.basic_info?.fans),
        following_count: parseCount(interMap.follows || data.follows),
        likes_count: parseCount(interMap.interaction || data.interactions_count),
        notes_count: parseCount(data.notes || data.basic_info?.notes),
        desc: (data.desc || data.basic_info?.desc || "").slice(0, 200),
      };
      continue;
    }

    // 2) /v1/user_posted → 帖子列表（原逻辑）
    const notes = body?.data?.notes || body?.notes || [];
    for (const n of notes) {
      if (!n || typeof n !== "object") continue;
      const nid = n.note_id || n.id;
      if (!nid || seen.has(nid)) continue;
      seen.add(nid);
      const tok = n.xsec_token || "";
      const user = n.user || {};
      const cover = n.cover || {};
      // user_posted 里 user 通常只有 nickname + image；先 fallback 给 profile
      if (!profile.creator_name && (user.nick_name || user.nickname || user.name)) {
        profile.creator_name = user.nick_name || user.nickname || user.name;
      }
      if (!profile.avatar_url && (user.image || user.images)) {
        profile.avatar_url = user.image || user.images;
      }
      out.push({
        post_id: String(nid),
        url: `https://www.xiaohongshu.com/explore/${nid}?xsec_token=${tok}&xsec_source=app_share`,
        title: (n.display_title || n.title || "").slice(0, 200),
        creator_name: user.nick_name || user.nickname || user.name || "",
        published_at: parseInt(n.time || n.create_time || 0) || 0,
        xsec_token: tok,
        cover_url: cover.url_default || cover.url_pre || "",
        liked_count: parseCount(n.interact_info?.liked_count),
      });
    }
  }
  return { posts: out, profile };
}

async function runDouyinCreatorPosts(payload) {
  const url = String(payload?.url || "").trim();
  if (!url) throw new Error("url required");
  const { tabId, windowId } = await openWorkerTab(url);
  try {
    await waitForTabComplete(tabId, 18000);
    await sleep(1200);
    const resp = await chrome.tabs.sendMessage(tabId, {
      from: "bg",
      action: "capture_douyin",
      urlPattern: ["/aweme/v1/web/aweme/post", "/aweme/v1/web/user/profile"],
      timeout_ms: payload?.timeout_ms || 25000,
      min_hits: 1,
    });
    let finalUrl = "";
    try { finalUrl = (await chrome.tabs.get(tabId)).url || ""; } catch {}
    if (!resp || (!resp.ok && (resp.hits?.length || 0) === 0)) {
      const code = classifyFailure(resp, finalUrl);
      const e = new Error(code);
      e.debug = { seen_urls: resp?.seen_urls || [], final_tab_url: finalUrl };
      throw e;
    }
    const { posts, profile } = extractDouyinCreatorPosts(resp.hits || []);
    return {
      url, raw_hits: (resp.hits || []).length, total: posts.length, posts,
      profile,
      seen_urls_sample: (resp.seen_urls || []).slice(-30),
    };
  } finally {
    await closeWorkerWindow(windowId);
  }
}

function extractDouyinCreatorPosts(hits) {
  const out = [];
  const seen = new Set();
  let profile = {};
  for (const h of hits) {
    const url = h.url || "";
    const body = h.body || {};

    // 抖音 user/profile/other 接口（粉丝、获赞、头像、签名）
    if (url.includes("/aweme/v1/web/user/profile")) {
      const u = body.user || body.user_info || {};
      profile = {
        creator_name: u.nickname || profile.creator_name || "",
        avatar_url:
          u.avatar_larger?.url_list?.[0] ||
          u.avatar_thumb?.url_list?.[0] ||
          profile.avatar_url || "",
        followers_count: parseCount(u.follower_count),
        following_count: parseCount(u.following_count),
        likes_count: parseCount(u.total_favorited),
        notes_count: parseCount(u.aweme_count),
        desc: (u.signature || "").slice(0, 200),
      };
      continue;
    }

    const list = body.aweme_list || [];
    for (const aw of list) {
      if (!aw || typeof aw !== "object") continue;
      const aid = aw.aweme_id || aw.awemeId;
      if (!aid || seen.has(aid)) continue;
      seen.add(aid);
      const author = aw.author || {};
      // 兜底从 author 拿头像
      if (!profile.creator_name && author.nickname) profile.creator_name = author.nickname;
      if (!profile.avatar_url) {
        profile.avatar_url =
          author.avatar_larger?.url_list?.[0] ||
          author.avatar_thumb?.url_list?.[0] || "";
      }
      out.push({
        post_id: String(aid),
        url: `https://www.douyin.com/video/${aid}`,
        title: (aw.desc || "").slice(0, 200),
        creator_name: author.nickname || "",
        published_at: parseInt(aw.create_time || 0) || 0,
        cover_url: aw.video?.cover?.url_list?.[0] || "",
        liked_count: parseCount(aw.statistics?.digg_count),
      });
    }
  }
  return { posts: out, profile };
}

// ===== 评论拉取（xhs / 抖音）=====
//
// xhs:    打开 /explore/{note_id}?xsec_token=...，hook /api/sns/web/v2/comment/page
// 抖音:   打开 /video/{aweme_id}，hook /aweme/v1/web/comment/list

async function runXhsFetchComments(payload) {
  const noteId = String(payload?.note_id || "").trim();
  const xsec = payload?.xsec_token || "";
  if (!noteId) throw new Error("note_id required");
  const url = `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=${xsec}&xsec_source=app_share`;

  const { tabId, windowId } = await openWorkerTab(url);
  try {
    await waitForTabComplete(tabId, 15000);
    await sleep(1200);
    const resp = await chrome.tabs.sendMessage(tabId, {
      from: "bg",
      action: "capture_xhs",
      urlPattern: ["/comment/page", "/comment/list"],
      timeout_ms: payload?.timeout_ms || 20000,
      min_hits: 1,
    });
    let finalUrl = "";
    try { finalUrl = (await chrome.tabs.get(tabId)).url || ""; } catch {}
    if (!resp || (!resp.ok && (resp.hits?.length || 0) === 0)) {
      const e = new Error(resp?.error || "xhs.fetch_comments capture failed");
      e.debug = { seen_urls: resp?.seen_urls || [], final_tab_url: finalUrl };
      throw e;
    }
    const comments = extractXhsComments(resp.hits || []);
    return { note_id: noteId, total: comments.length, comments };
  } finally {
    await closeWorkerWindow(windowId);
  }
}

function extractXhsComments(hits) {
  const out = [];
  const seen = new Set();
  for (const h of hits) {
    const arr = h.body?.data?.comments || h.body?.comments || [];
    for (const c of arr) {
      if (!c || typeof c !== "object") continue;
      const cid = c.id || c.comment_id;
      if (!cid || seen.has(cid)) continue;
      seen.add(cid);
      const user = c.user_info || c.user || {};
      out.push({
        comment_id: String(cid),
        content: (c.content || "").slice(0, 1000),
        author: user.nickname || user.nick_name || "",
        author_id: user.user_id || user.id || "",
        liked_count: parseCount(c.like_count || c.liked_count),
        created_at: parseInt(c.create_time || c.time || 0) || 0,
      });
    }
  }
  return out;
}

async function runDouyinFetchComments(payload) {
  const aid = String(payload?.aweme_id || payload?.note_id || "").trim();
  if (!aid) throw new Error("aweme_id required");
  const url = `https://www.douyin.com/video/${aid}`;
  const { tabId, windowId } = await openWorkerTab(url);
  try {
    await waitForTabComplete(tabId, 18000);
    await sleep(1500);
    const resp = await chrome.tabs.sendMessage(tabId, {
      from: "bg",
      action: "capture_douyin",
      urlPattern: ["/aweme/v1/web/comment/list"],
      timeout_ms: payload?.timeout_ms || 20000,
      min_hits: 1,
    });
    let finalUrl = "";
    try { finalUrl = (await chrome.tabs.get(tabId)).url || ""; } catch {}
    if (!resp || (!resp.ok && (resp.hits?.length || 0) === 0)) {
      const e = new Error(resp?.error || "douyin.fetch_comments capture failed");
      e.debug = { seen_urls: resp?.seen_urls || [], final_tab_url: finalUrl };
      throw e;
    }
    const comments = extractDouyinComments(resp.hits || []);
    return { aweme_id: aid, total: comments.length, comments };
  } finally {
    await closeWorkerWindow(windowId);
  }
}

function extractDouyinComments(hits) {
  const out = [];
  const seen = new Set();
  for (const h of hits) {
    const arr = h.body?.comments || [];
    for (const c of arr) {
      if (!c || typeof c !== "object") continue;
      const cid = c.cid || c.comment_id;
      if (!cid || seen.has(cid)) continue;
      seen.add(cid);
      const user = c.user || {};
      out.push({
        comment_id: String(cid),
        content: (c.text || "").slice(0, 1000),
        author: user.nickname || "",
        author_id: user.uid || user.sec_uid || "",
        liked_count: parseCount(c.digg_count),
        created_at: parseInt(c.create_time || 0) || 0,
      });
    }
  }
  return out;
}

// ===== 抖音直播状态 =====
async function runDouyinLiveStatus(payload) {
  const liveUrl = String(payload?.live_url || "").trim();
  if (!liveUrl) throw new Error("live_url required");
  const { tabId, windowId } = await openWorkerTab(liveUrl);
  try {
    await waitForTabComplete(tabId, 15000);
    await sleep(2000);
    const resp = await chrome.tabs.sendMessage(tabId, {
      from: "bg",
      action: "capture_douyin",
      urlPattern: ["/webcast/room/web/enter", "/webcast/room/info"],
      timeout_ms: payload?.timeout_ms || 12000,
      min_hits: 1,
    });
    if (!resp || (!resp.ok && (resp.hits?.length || 0) === 0)) {
      const e = new Error(resp?.error || "douyin.live_status capture failed");
      e.debug = { seen_urls: resp?.seen_urls || [] };
      throw e;
    }
    // 取最后一个 enter/info 响应里的房间信息
    const last = (resp.hits || []).slice(-1)[0]?.body || {};
    const room = last?.data?.data?.[0] || last?.data?.room || last?.data || {};
    return {
      live_url: liveUrl,
      online_count: parseCount(room.user_count || room.user_count_str || 0),
      title: room.title || "",
      status: room.status || 0,  // 2=直播中, 4=已结束
    };
  } finally {
    await closeWorkerWindow(windowId);
  }
}

// ===== 笔记详情补全（cookie-only 字段：desc / images / video / 私密笔记）=====

async function runXhsNoteDetail(payload) {
  const noteId = String(payload?.note_id || "").trim();
  const xsec = payload?.xsec_token || "";
  if (!noteId) throw new Error("note_id required");
  const url = `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=${xsec}&xsec_source=app_share`;
  const { tabId, windowId } = await openWorkerTab(url);
  try {
    await waitForTabComplete(tabId, 15000);
    await sleep(800);

    // XHS 笔记详情数据有两种来源：__INITIAL_STATE__ 内嵌 JSON / feed 接口
    // 优先走 fetch hook 拿 feed，再 fallback 抓 DOM 里的 INITIAL_STATE
    const resp = await chrome.tabs.sendMessage(tabId, {
      from: "bg",
      action: "capture_xhs",
      urlPattern: ["/v1/feed", "/v2/feed"],
      timeout_ms: payload?.timeout_ms || 15000,
      min_hits: 1,
    });

    let detail = null;
    if (resp?.ok && resp.hits?.length) {
      detail = extractXhsNoteDetail(resp.hits, noteId);
    }
    // fallback: 从 DOM 里取 __INITIAL_STATE__
    if (!detail) {
      try {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId },
          func: (id) => {
            const m = document.body?.innerHTML?.match(/window\.__INITIAL_STATE__=(\{[\s\S]*?\})<\/script>/);
            if (!m) return null;
            try {
              const state = JSON.parse(m[1].replace(/undefined/g, '""'));
              return state?.note?.noteDetailMap?.[id]?.note || null;
            } catch { return null; }
          },
          args: [noteId],
        });
        if (result) detail = normalizeXhsNote(result);
      } catch {}
    }

    if (!detail) {
      const e = new Error("xhs.note_detail no data");
      e.debug = { seen_urls: resp?.seen_urls || [] };
      throw e;
    }
    return { note_id: noteId, ...detail };
  } finally {
    await closeWorkerWindow(windowId);
  }
}

function normalizeXhsNote(note) {
  const interact = note.interact_info || note.interactInfo || {};
  const images = (note.image_list || note.imageList || [])
    .map((img) => {
      const list = img.info_list || img.infoList || [];
      const wb = list.find((x) => (x.image_scene || x.imageScene) === "WB_DFT");
      return wb?.url || list[0]?.url || img.url_default || img.url || "";
    })
    .filter(Boolean);
  const video = note.video || {};
  const stream = video.media?.stream || {};
  let videoUrl = "";
  for (const k of ["h264", "h265", "av1"]) {
    const arr = stream[k];
    if (Array.isArray(arr) && arr[0]) {
      videoUrl = arr[0].master_url || arr[0].masterUrl || (arr[0].backup_urls || arr[0].backupUrls || [""])[0] || "";
      if (videoUrl) break;
    }
  }
  return {
    title: (note.title || note.display_title || "").slice(0, 200),
    desc: (note.desc || "").slice(0, 5000),
    liked_count: parseCount(interact.liked_count || interact.likedCount),
    collected_count: parseCount(interact.collected_count || interact.collectedCount),
    comment_count: parseCount(interact.comment_count || interact.commentCount),
    share_count: parseCount(interact.share_count || interact.shareCount),
    images,
    video_url: videoUrl,
    cover_url: note.cover?.url_default || note.cover?.url || images[0] || "",
    note_type: note.type || "normal",
  };
}

function extractXhsNoteDetail(hits, targetId) {
  for (const h of hits) {
    const items = h.body?.data?.items || [];
    for (const it of items) {
      if (it.id !== targetId && it.note_id !== targetId) continue;
      const note = it.note_card || it.note || it;
      if (note) return normalizeXhsNote(note);
    }
  }
  return null;
}

async function runDouyinNoteDetail(payload) {
  const aid = String(payload?.aweme_id || payload?.note_id || "").trim();
  if (!aid) throw new Error("aweme_id required");
  const url = `https://www.douyin.com/video/${aid}`;
  const { tabId, windowId } = await openWorkerTab(url);
  try {
    await waitForTabComplete(tabId, 18000);
    await sleep(1500);
    const resp = await chrome.tabs.sendMessage(tabId, {
      from: "bg",
      action: "capture_douyin",
      urlPattern: ["/aweme/v1/web/aweme/detail"],
      timeout_ms: payload?.timeout_ms || 15000,
      min_hits: 1,
    });
    if (!resp?.ok || !resp.hits?.length) {
      const e = new Error(resp?.error || "douyin.note_detail no data");
      e.debug = { seen_urls: resp?.seen_urls || [] };
      throw e;
    }
    let detail = null;
    for (const h of resp.hits) {
      const aweme = h.body?.aweme_detail || h.body?.aweme;
      if (aweme && (aweme.aweme_id === aid || aweme.awemeId === aid)) {
        detail = normalizeDouyinAweme(aweme);
        break;
      }
    }
    if (!detail) {
      const e = new Error("douyin.note_detail aweme not matched");
      e.debug = { seen_urls: resp?.seen_urls || [] };
      throw e;
    }
    return { aweme_id: aid, ...detail };
  } finally {
    await closeWorkerWindow(windowId);
  }
}

function normalizeDouyinAweme(aweme) {
  const stats = aweme.statistics || {};
  const author = aweme.author || {};
  const video = aweme.video || {};
  const cover = video.cover || video.origin_cover || {};
  const play = video.play_addr || {};
  return {
    title: (aweme.desc || "").slice(0, 200),
    desc: (aweme.desc || "").slice(0, 5000),
    liked_count: parseCount(stats.digg_count),
    collected_count: parseCount(stats.collect_count),
    comment_count: parseCount(stats.comment_count),
    share_count: parseCount(stats.share_count),
    cover_url: cover.url_list?.[0] || "",
    images: [],
    video_url: play.url_list?.[0] || "",
    note_type: "video",
    author: author.nickname || "",
  };
}

// ===== 发布任务（占位 - 需要在用户的发布平台 origin 模拟操作）=====
//
// xhs:    https://creator.xiaohongshu.com/publish/publish
// douyin: https://creator.douyin.com/creator-micro/content/upload
//
// P7.5 实际工作量大（每个平台的发布表单 DOM 不同，且会改版），
// 这里先打通基础流程，content_scripts 在对应 creator 域内实施详细操作。
async function runPublishTask(type, payload) {
  const platform = type.split(".")[0];
  const targets = {
    xhs: "https://creator.xiaohongshu.com/publish/publish",
    douyin: "https://creator.douyin.com/creator-micro/content/upload",
  };
  const url = targets[platform];
  if (!url) throw new Error(`unknown publish platform ${platform}`);

  // 让 content/publish_<platform>.js 完成具体填表 + 提交（active:true 让用户能看到/介入）
  const { tabId, windowId } = await openWorkerTab(url);
  try {
    await waitForTabComplete(tabId, 20000);
    await sleep(2000);
    const resp = await chrome.tabs.sendMessage(tabId, {
      from: "bg",
      action: `publish_${platform}`,
      payload,
    });
    if (!resp?.ok) {
      throw new Error(resp?.error || `publish_${platform} failed`);
    }
    return resp.data || { ok: true };
  } finally {
    // 发布 tab 保留 active 让用户能看到结果（不自动关）
    // try { await chrome.tabs.remove(tabId); } catch {}
  }
}

function parseCount(v) {
  if (v == null) return 0;
  if (typeof v === "number") return Math.floor(v);
  const s = String(v).replace(/,/g, "").trim();
  if (!s) return 0;
  if (s.endsWith("万") || s.endsWith("w") || s.endsWith("W")) {
    const n = parseFloat(s.slice(0, -1));
    return isNaN(n) ? 0 : Math.floor(n * 10000);
  }
  const n = parseFloat(s);
  return isNaN(n) ? 0 : Math.floor(n);
}


// ===== popup ↔ bg RPC =====
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.from !== "popup") return;
  (async () => {
    if (msg.action === "get_state") {
      sendResponse({
        connected,
        serverUrl,
        hasToken: !!token,
        tasks: lastTaskLog,
      });
    } else if (msg.action === "set_config") {
      // 只覆盖明确传入的字段：popup 在用户没输入新 token 时不会传 token，
      // 此时保留原值（避免每次保存把 token 抹成空字符串）
      const patch = {};
      if (typeof msg.serverUrl === "string") patch.serverUrl = msg.serverUrl;
      if (typeof msg.token === "string" && msg.token) patch.token = msg.token;
      if (Object.keys(patch).length) await chrome.storage.local.set(patch);
      await loadConfig();
      // 重连（fire-and-forget，让 popup 立刻收到响应）
      try { ws?.close(); } catch (e) {}
      connect();
      sendResponse({ ok: true });
    } else if (msg.action === "disconnect") {
      try { ws?.close(); } catch (e) {}
      ws = null;
      connected = false;
      sendResponse({ ok: true });
    } else if (msg.action === "reconnect") {
      try { ws?.close(); } catch (e) {}
      connect();
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: "unknown action" });
    }
  })();
  return true; // keep channel open for async sendResponse
});

// ===== 启动 =====
chrome.runtime.onInstalled.addListener(async () => {
  await loadConfig();
  connect();
});
chrome.runtime.onStartup.addListener(async () => {
  await loadConfig();
  connect();
});

// SW 冷启动时也尝试连一次（onInstalled/onStartup 在某些时机不触发）
loadConfig().then(connect);

// popup 直接写 storage 后兜底重连（RPC 路径失败也不影响）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (!("serverUrl" in changes) && !("token" in changes)) return;
  loadConfig().then(() => {
    try { ws?.close(); } catch (e) {}
    connect();
  });
});
