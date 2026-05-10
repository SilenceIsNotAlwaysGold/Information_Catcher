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

// SSR 兜底：从 window.__INITIAL_STATE__ 解析首屏笔记数据
// 小红书首屏结果是 SSR 嵌进 HTML 的，不发 XHR；只有翻页才发 search/notes。
// 关键词结果少（≤1 屏）时扩展只能拿首屏 SSR。
function extractInitialStateNotes() {
  try {
    const state = window.__INITIAL_STATE__;
    if (!state) return [];
    // 路径：state.search.feeds._rawValue / state.search.feed.feeds 等多种变体
    const candidates = [
      state?.search?.feeds?._rawValue,
      state?.search?.feed?.feeds,
      state?.search?.searchResults,
      state?.search?.notes?._rawValue,
    ];
    for (const c of candidates) {
      if (Array.isArray(c) && c.length > 0) {
        return c;
      }
    }
  } catch {}
  return [];
}

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
    captureFor(pattern, timeout, msg.min_hits ?? 0).then(sendResponse);
    return true; // async
  }
  if (msg.action === "scroll") {
    // 触发懒加载
    window.scrollBy(0, msg.dy || 800);
    sendResponse({ ok: true });
    return false;
  }
});
