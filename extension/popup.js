// popup ↔ background 通信
const $ = (id) => document.getElementById(id);

// 检查当前是不是独立窗口模式（detached）
const IS_DETACHED = new URLSearchParams(location.search).get("detached") === "1";

async function rpc(action, payload = {}, timeoutMs = 1500) {
  // SW 可能在异步过程中被回收，sendResponse 永远不来 —— 必须超时兜底，
  // 否则任何 await rpc(...) 都可能让 popup 卡死
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    const timer = setTimeout(() => finish({ _timeout: true }), timeoutMs);
    try {
      chrome.runtime.sendMessage({ from: "popup", action, ...payload }, (resp) => {
        clearTimeout(timer);
        finish(resp || {});
      });
    } catch (e) {
      clearTimeout(timer);
      finish({});
    }
  });
}

function renderStatus({ connected, serverUrl, hasToken }) {
  const dot = $("status-dot");
  const text = $("status-text");
  dot.classList.remove("on", "off");
  if (connected) {
    dot.classList.add("on");
    text.textContent = "已连接";
  } else if (serverUrl && hasToken) {
    dot.classList.add("off");
    text.textContent = "未连接";
  } else if (serverUrl && !hasToken) {
    dot.classList.add("off");
    text.textContent = "缺 Token";
  } else if (!serverUrl && hasToken) {
    dot.classList.add("off");
    text.textContent = "缺地址";
  } else {
    text.textContent = "未配置";
  }
  // 回显已保存的值（保留用户输入优先）
  if (serverUrl && !$("server-url").value) $("server-url").value = serverUrl;
  if (hasToken) {
    $("token").placeholder = "已设置（输入新 token 覆盖）";
  } else {
    $("token").placeholder = "在 TrendPulse 仪表盘 → 我的浏览器扩展 获取";
  }
}

function renderTasks(tasks) {
  const list = $("task-list");
  if (!tasks || tasks.length === 0) {
    list.innerHTML = '<div class="empty">暂无任务</div>';
    return;
  }
  list.innerHTML = tasks.map((t) => {
    const ts = new Date(t.ts).toLocaleTimeString();
    const cls = t.status || "running";
    const err = t.error ? ` title="${escapeHtml(t.error)}"` : "";
    return `<div class="task"${err}>
      <span class="type">${escapeHtml(t.type || "?")}</span>
      <span class="status ${cls}">${cls}</span>
      <span style="color:#aaa;font-size:10px">${ts}</span>
    </div>`;
  }).join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// 直接从 chrome.storage 读真实数据（解决 SW 销毁导致 background 内存状态丢失的问题）
async function readStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      ["serverUrl", "token", "lastTaskLog", "lastMpAuthSync", "mpAuthDebug"],
      (items) => resolve(items || {}),
    );
  });
}

function fmtAgo(ts) {
  if (!ts) return "未同步";
  const diff = Math.max(0, Date.now() - ts);
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

function renderMpAuth(last, debug) {
  const el = $("mp-auth-status");
  if (!el) return;
  let main = "";
  let bg = "#f8fafc", bd = "#e2e8f0", fg = "#64748b";
  if (last && last.ok) {
    bg = "#f0fdf4"; bd = "#86efac"; fg = "#166534";
    main = `✅ 凭证已同步 · ${fmtAgo(last.ts)}（30 分钟内有效）`;
  } else if (last && !last.ok) {
    bg = "#fef2f2"; bd = "#fca5a5"; fg = "#991b1b";
    main = `❌ 同步失败 · ${fmtAgo(last.ts)}${last.error ? "：" + last.error.slice(0, 60) : ""}`;
  } else {
    main = "尚未同步。打开公众号文章后滑到底部，触发阅读数加载。";
  }

  // 诊断行：展示扩展看到了多少 mp 请求 + 最近一条带凭证字段的 URL
  let diag = "";
  if (debug) {
    const seen = debug.totalSeen || 0;
    if (seen === 0) {
      diag = "\n（暂未观察到 mp.weixin.qq.com 请求 — 请检查扩展是否加载了 v0.5.0）";
    } else if (!debug.recentUrls || debug.recentUrls.length === 0) {
      diag = `\n（看到 ${seen} 次 mp 请求，但都没有 uin/key/pass_ticket 字段。请滑到文章底部触发阅读量加载。）`;
    } else {
      const last5 = debug.recentUrls.slice(0, 3).map((r) => `${r.path} → ${r.fields.join(",")}`);
      diag = `\n看到 ${seen} 次 mp 请求，最近带凭证的：\n` + last5.join("\n");
    }
  }
  el.style.background = bg;
  el.style.borderColor = bd;
  el.style.color = fg;
  el.style.whiteSpace = "pre-line";
  el.textContent = main + diag;
}

async function refresh() {
  const [stored, state] = await Promise.all([readStorage(), rpc("get_state")]);
  const merged = {
    connected: !!state.connected,
    serverUrl: stored.serverUrl || state.serverUrl || "",
    hasToken: !!(stored.token || (state.hasToken)),
    tasks: stored.lastTaskLog || state.tasks || [],
  };
  renderStatus(merged);
  renderTasks(merged.tasks);
  renderMpAuth(stored.lastMpAuthSync, stored.mpAuthDebug);
}

// 严格清洗服务器地址：只保留 protocol + host[:port]，丢掉所有 path / 重复 protocol 残留
// 例：
//   "https://x.com/"                   → "https://x.com"
//   "  https://x.com/api  "            → "https://x.com"
//   "https://x.comhttps://x.com"       → "https://x.com"  ← 这次的脏数据元凶
//   "x.com:8080"                       → "https://x.com:8080"
function cleanServerUrl(input) {
  let s = String(input || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  const protoMatch = s.match(/^(https?:\/\/)/i);
  const proto = protoMatch[1].toLowerCase();
  let rest = s.slice(protoMatch[1].length);
  // 关键修复：找第二次出现的 http(s):// —— 那里之后全是脏数据
  const dup = rest.search(/https?:\/\//i);
  if (dup >= 0) {
    rest = rest.slice(0, dup);
    // 末尾可能残留无 :// 的 "http" / "https"
    rest = rest.replace(/(https?)$/i, "");
  }
  // 切掉 path / query / fragment
  rest = rest.split(/[/?#]/)[0];
  // 末尾的标点
  rest = rest.replace(/[.\-]+$/, "");
  // 合法 host[:port] 校验
  if (!/^[A-Za-z0-9\-._]+(?::\d+)?$/.test(rest)) return "";
  return proto + rest;
}

$("save").addEventListener("click", async () => {
  const serverUrl = cleanServerUrl($("server-url").value);
  const token = $("token").value.trim();
  if (!serverUrl) {
    alert("服务器地址格式不正确，示例：https://your-tunnel.trycloudflare.com");
    return;
  }
  // 把清洗后的值回填到输入框，让用户看到实际生效的 URL
  $("server-url").value = serverUrl;

  $("save").textContent = "保存中…";
  $("save").disabled = true;
  try {
    // 1) 直接写 chrome.storage（稳定 API，永远 resolve）
    const patch = { serverUrl };
    if (token) patch.token = token;
    await new Promise((resolve) => chrome.storage.local.set(patch, resolve));
    $("token").value = "";

    // 2) 通知 background 重连（fire-and-forget，rpc 自带 1.5s 超时不会卡）
    rpc("set_config", patch).catch(() => {});

    // 3) 立即刷新 UI（refresh 调用的 rpc 也有超时兜底）
    await refresh();
  } finally {
    $("save").textContent = "保存并连接";
    $("save").disabled = false;
  }
});

$("reconnect").addEventListener("click", async () => {
  await rpc("reconnect");
  setTimeout(refresh, 1200);
});

$("disconnect").addEventListener("click", async () => {
  await rpc("disconnect");
  await refresh();
});

// 「独立窗口」按钮：开一个不会 blur 关闭的常驻窗口
$("detach").addEventListener("click", async () => {
  if (IS_DETACHED) return;
  try {
    await chrome.windows.create({
      url: chrome.runtime.getURL("popup.html?detached=1"),
      type: "popup",
      width: 380,
      height: 580,
    });
    window.close(); // 关掉当前 popup
  } catch (e) {
    alert("无法打开独立窗口: " + e.message);
  }
});

// 独立窗口模式下不显示「独立窗口」按钮（避免无限套娃）
if (IS_DETACHED) {
  $("detach").style.display = "none";
  document.title = "TrendPulse Helper（常驻配置）";
}

// 接收 background 主动推送的状态变化
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.from !== "bg") return;
  refresh();
});

// 独立窗口里持续轮询状态（普通 popup 因为 blur 即关闭，不需要轮询）
if (IS_DETACHED) {
  setInterval(refresh, 3000);
}

refresh();

// ── 版本显示 + 升级提示 ──────────────────────────────────────────────────────
// 显示当前扩展 version；连上服务器后拉服务端推荐版本号，对比给出"建议更新"提示。
function compareSemver(a, b) {
  const pa = String(a).split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

(async function showVersionAndCheckUpdate() {
  const cur = chrome.runtime.getManifest().version;
  $("ext-version").textContent = `v${cur}`;

  // 取已配置的服务器地址，如果有就拉版本端点
  const { serverUrl } = await new Promise((r) =>
    chrome.storage.local.get(["serverUrl"], r),
  );
  if (!serverUrl) return;

  const link = $("dashboard-link");
  if (link) link.href = `${serverUrl.replace(/\/$/, "")}/dashboard/extension`;

  try {
    const r = await fetch(`${serverUrl.replace(/\/$/, "")}/api/extension/version`, {
      cache: "no-store",
    });
    if (!r.ok) return;
    const data = await r.json();
    const recommended = String(data?.recommended || "");
    if (!recommended) return;
    if (compareSemver(cur, recommended) >= 0) return;
    const banner = $("update-banner");
    banner.style.display = "block";
    banner.innerHTML =
      `🔔 有新版扩展可用：<b>v${recommended}</b>（当前 v${cur}）。 ` +
      `<a href="${serverUrl.replace(/\/$/, "")}/dashboard/extension" target="_blank" ` +
      `style="color:#9a3412; text-decoration:underline; font-weight:600;">前往下载</a>`;
  } catch {
    // 服务端没接此端点也没关系
  }
})();
