// content/xhs.js — 注入到 xiaohongshu.com 的 isolated world
// 职责：作为 page world (main hook) 与 background (service worker) 之间的桥梁
//
// background → content（chrome.runtime.onMessage）:
//   {from:"bg", action:"capture_xhs", op:"search|creator", urlPattern:"...", timeout_ms:30000}
// content → page（window.postMessage）:
//   {__pulse:"control", action:"start", urlPattern:...}
// page → content（window.postMessage）:
//   {__pulse:"data", hits:[{url,body},...]}
// content → background（sendResponse）:
//   {ok:true, hits:[...]}

console.log("[pulse-content] xhs content script loaded");

const collectedHits = [];
let collectedSeenUrls = [];
let captureActive = false;
let pendingSeenResolver = null;
// 风控信号：page hook 看到 redcaptcha / verify URL 时通过 postMessage 通知
let captchaSignal = null; // null 或 { url }

window.addEventListener("message", (e) => {
  if (e.source !== window) return;
  const m = e.data;
  if (!m) return;
  if (m.__pulse === "data") {
    if (!captureActive) return;
    for (const h of m.hits || []) {
      collectedHits.push(h);
    }
  } else if (m.__pulse === "seen_urls") {
    collectedSeenUrls = m.urls || [];
    if (pendingSeenResolver) {
      pendingSeenResolver(collectedSeenUrls);
      pendingSeenResolver = null;
    }
  } else if (m.__pulse === "signal" && m.kind === "captcha") {
    if (captureActive) captchaSignal = { url: m.url || "" };
  }
});

async function drainSeenUrls(timeoutMs = 1500) {
  return new Promise((resolve) => {
    pendingSeenResolver = resolve;
    window.postMessage({ __pulse: "control", action: "drain_urls" }, "*");
    setTimeout(() => {
      if (pendingSeenResolver) {
        pendingSeenResolver(collectedSeenUrls);
        pendingSeenResolver = null;
      }
    }, timeoutMs);
  });
}

function startCapture(urlPattern) {
  captureActive = true;
  collectedHits.length = 0;
  captchaSignal = null;
  window.postMessage({ __pulse: "control", action: "start", urlPattern }, "*");
}

function stopCapture() {
  captureActive = false;
  window.postMessage({ __pulse: "control", action: "stop" }, "*");
}

// 自动滚到底循环：capture 期间持续触发懒加载
// 小红书 search/notes XHR 必须滚到接近底部才发，单次滚 1200px 远远不够
let _autoScrollTimer = null;
function startAutoScroll() {
  stopAutoScroll();
  _autoScrollTimer = setInterval(() => {
    try {
      // 滚到底（document.scrollingElement 兜底，覆盖部分容器）
      const el = document.scrollingElement || document.documentElement;
      el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
      // 偶尔回顶再滚到底，刺激 IntersectionObserver
      if (Math.random() < 0.15) {
        setTimeout(() => el.scrollTo({ top: 0, behavior: "auto" }), 50);
      }
    } catch {}
  }, 1200);
}
function stopAutoScroll() {
  if (_autoScrollTimer) clearInterval(_autoScrollTimer);
  _autoScrollTimer = null;
}

// SSR 兜底：window.__INITIAL_STATE__ 在 main world，content script 在 isolated world
// 拿不到。让 page_hook 中转读出 state.user 子树。
let _initialStateResolver = null;
window.addEventListener("message", (e) => {
  if (e.source !== window) return;
  if (e.data?.__pulse === "initial_state" && _initialStateResolver) {
    _initialStateResolver({ data: e.data.data || null, debug: e.data.debug || null });
    _initialStateResolver = null;
  }
});
async function readInitialStateUser(timeoutMs = 1500) {
  return new Promise((resolve) => {
    _initialStateResolver = resolve;
    window.postMessage({ __pulse: "control", action: "read_initial_state" }, "*");
    setTimeout(() => {
      if (_initialStateResolver) { _initialStateResolver({ data: null, debug: null }); _initialStateResolver = null; }
    }, timeoutMs);
  });
}

// DOM 兜底 —— 用户截图确认 selector 是 .user-interactions
// 容器内文本形如："122 关注 631 粉丝 1677 获赞与收藏"
function readDomCreatorStats() {
  const out = {
    fans_text: "", interactions_text: "", notes_text: "", follows_text: "",
    creator_name: "", debug: {},
  };
  try {
    const NUM = "([0-9][0-9.,]*\\s*[万亿wWkK]?)";
    const scope = document.querySelector(".user-interactions");
    const scopeText = scope ? (scope.textContent || "").trim()
                            : (document.body?.innerText || "").slice(0, 2000);
    out.debug.scope_text = scopeText.slice(0, 200);
    const labels = {
      follows_text: ["关注"],
      fans_text: ["粉丝"],
      interactions_text: ["获赞与收藏", "获赞", "总获赞", "总点赞"],
    };
    for (const [field, ls] of Object.entries(labels)) {
      for (const lab of ls) {
        // 注意：JS \b 对中文字符不生效（中文是 non-word），不要加 \b
        const re = new RegExp(`${NUM}\\s*${lab}`);
        const m = re.exec(scopeText);
        if (m && m[1]) { out[field] = m[1].trim(); break; }
      }
    }
    // 笔记数：直接用 DOM 上实际加载的 .note-item 数量（read_dom_stats 调用前会等懒加载稳定）
    // 之前优先取 tab 文字会命中"笔记 14"这种 badge 误差值，远小于实际数。
    const items = document.querySelectorAll("section.note-item");
    if (items.length) out.notes_text = String(items.length);

    // ─── creator_name DOM 提取 ──────────────────────────────────────────
    // 之前完全靠 XHR 的 data.nickname / n.user.nickname，但 XHR 不一定发或
    // 字段会变（折叠/转发场景 n.user 可能不是页面博主），就拿到错的名字。
    // DOM 是用户实际看到的标题，最可靠。多套选择器 + meta + title 兜底。
    const nameCandidates = [];
    const sels = [
      ".user-info .user-name",
      ".user-info .nickname",
      ".user-nickname-content",
      ".user-info-wrapper .user-name",
      ".profile-info .name",
      ".user-info [class*='nick']",
      ".user-info [class*='name']",
      ".user-basic-info .name",
      "h1[class*='user']",
    ];
    for (const s of sels) {
      const el = document.querySelector(s);
      const t = el ? (el.textContent || "").trim() : "";
      if (t && t.length <= 50) { nameCandidates.push({ src: "sel:" + s, val: t }); break; }
    }
    // meta og:title 多为「XXX 的小红书」，扒掉后缀
    const og = document.querySelector('meta[property="og:title"]')
      || document.querySelector('meta[name="og:title"]');
    if (og) {
      const t = String(og.getAttribute("content") || "")
        .replace(/[ \-—]*\s*小红书.*$/u, "")
        .replace(/的小红书$/u, "")
        .trim();
      if (t) nameCandidates.push({ src: "og:title", val: t });
    }
    // document.title 类似「XXX 的小红书」/「XXX - 小红书」
    if (document.title) {
      const t = document.title
        .replace(/[ \-—]*\s*小红书.*$/u, "")
        .replace(/的小红书$/u, "")
        .trim();
      if (t && t.length <= 50 && !/^(用户主页|小红书)$/.test(t)) {
        nameCandidates.push({ src: "doc.title", val: t });
      }
    }
    out.debug.name_candidates = nameCandidates.slice(0, 5);
    if (nameCandidates.length) out.creator_name = nameCandidates[0].val;
  } catch (e) {
    out.debug.error = String(e?.message || e);
  }
  return out;
}

// 直接从 DOM 抓作品列表（含封面 + xsec_token）
function readDomCreatorPosts() {
  const posts = [];
  try {
    for (const item of document.querySelectorAll("section.note-item")) {
      let noteId = "", xsecToken = "";
      for (const a of item.querySelectorAll("a[href]")) {
        const href = a.getAttribute("href") || "";
        const m = href.match(/\/(?:explore|profile\/[^/]+)\/([a-f0-9]{24})/);
        if (m) {
          noteId = m[1];
          const tm = href.match(/xsec_token=([^&]+)/);
          if (tm && !xsecToken) xsecToken = decodeURIComponent(tm[1]);
          if (xsecToken) break;
        }
      }
      if (!noteId) continue;
      const img = item.querySelector("img");
      const footer = item.querySelector(".footer, [class*='footer']");
      let title = footer ? (footer.textContent || "").trim() : "";
      if (!title) title = (item.textContent || "").trim().split("\n")[0].trim();
      const likeEl = item.querySelector("[class*='like']");
      const likedText = likeEl ? (likeEl.textContent || "").trim() : "";
      posts.push({
        post_id: noteId,
        xsec_token: xsecToken,
        cover_url: img?.src || img?.getAttribute("data-src") || "",
        title: title.slice(0, 200),
        liked_count_text: likedText,
        url: `https://www.xiaohongshu.com/explore/${noteId}${xsecToken ? "?xsec_token=" + xsecToken : ""}`,
      });
    }
  } catch {}
  return posts;
}

// 旧 SSR helper：search 页 first screen 兜底（保留以备将来）
function extractInitialStateNotes() { return []; }

async function captureFor(urlPattern, timeoutMs, minHits = 1) {
  startCapture(urlPattern);
  startAutoScroll();
  const start = Date.now();
  return new Promise((resolve) => {
    const finish = async (extra) => {
      stopCapture();
      stopAutoScroll();
      resolve({
        ...extra,
        hits: collectedHits.slice(),
        seen_urls: await drainSeenUrls(),
      });
    };
    const tick = async () => {
      const elapsed = Date.now() - start;
      if (collectedHits.length >= minHits && elapsed >= 2000) {
        await finish({ ok: true });
        return;
      }
      // 风控 fail-fast：page hook 看到验证码 URL → 立即返回
      if (captchaSignal && collectedHits.length === 0) {
        await finish({ ok: false, error: "captcha_required", captcha_url: captchaSignal.url });
        return;
      }
      if (elapsed >= timeoutMs) {
        // XHR 一条没收到 → 最后用 __INITIAL_STATE__ 兜底
        if (collectedHits.length === 0) {
          const ssr = extractInitialStateNotes();
          if (ssr.length > 0) {
            // 包成与 XHR 响应一致的 hit 形态：{ url, body }，body 是 fake search/notes 响应
            collectedHits.push({
              url: location.href,
              body: { data: { items: ssr }, _from_ssr: true },
            });
            await finish({ ok: true, from_ssr: true });
            return;
          }
        }
        await finish({
          ok: collectedHits.length > 0,
          error: collectedHits.length === 0 ? "no_response_captured" : undefined,
        });
        return;
      }
      setTimeout(tick, 500);
    };
    setTimeout(tick, 500);
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.from !== "bg") return;
  if (msg.action === "__ping") {
    sendResponse({ pong: true, host: location.hostname });
    return false;
  }
  if (msg.action === "capture_xhs") {
    const pattern = msg.urlPattern || "/api/sns/web/v1/search/notes";
    const timeout = msg.timeout_ms || 30000;
    // 默认 min_hits=0 = 宽松模式：超时就把已抓到的吐回，不强制至少 N 条
    // 永远兜底 sendResponse，否则 captureFor 任何 reject → bg 收到 "message channel closed"
    captureFor(pattern, timeout, msg.min_hits ?? 0)
      .then((r) => sendResponse(r))
      .catch((e) => {
        try { stopCapture(); stopAutoScroll(); } catch {}
        sendResponse({
          ok: false,
          error: "capture_threw: " + String(e?.message || e),
          hits: collectedHits.slice(),
          seen_urls: collectedSeenUrls.slice(),
        });
      });
    return true; // async
  }
  if (msg.action === "scroll") {
    // 触发懒加载
    window.scrollBy(0, msg.dy || 800);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.action === "get_initial_state") {
    // background 通过 content 转发到 main world 拿 SSR 数据
    readInitialStateUser(msg.timeout_ms || 1500).then((r) => sendResponse(r));
    return true; // async
  }
  if (msg.action === "read_dom_stats") {
    // 1. 先滚到底等懒加载稳定（连续 2 次 .note-item 数量不变就停）
    // 2. 再读 stats + posts，这样作品数和封面才齐
    (async () => {
      try {
        const el = document.scrollingElement || document.documentElement;
        let last = -1, stable = 0;
        const start = Date.now();
        const maxMs = msg.scroll_max_ms || 12000;
        while (Date.now() - start < maxMs) {
          const cur = document.querySelectorAll("section.note-item").length;
          if (cur === last) {
            stable++;
            if (stable >= 2) break;
          } else { stable = 0; last = cur; }
          el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
          await new Promise((r) => setTimeout(r, 1200));
        }
      } catch {}
      const stats = readDomCreatorStats();
      const posts = readDomCreatorPosts();
      sendResponse({ ...stats, posts });
    })();
    return true; // async
  }
});
