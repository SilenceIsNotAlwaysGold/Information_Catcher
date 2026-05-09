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

async function captureFor(urlPattern, timeoutMs, minHits = 1) {
  startCapture(urlPattern);
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = async () => {
      const elapsed = Date.now() - start;
      if (collectedHits.length >= minHits && elapsed >= 2000) {
        stopCapture();
        resolve({ ok: true, hits: collectedHits.slice(), seen_urls: await drainSeenUrls() });
        return;
      }
      // 风控 fail-fast：page hook 看到验证码 URL → 立即返回，不等 30s
      if (captchaSignal && collectedHits.length === 0) {
        stopCapture();
        const seen = await drainSeenUrls();
        resolve({
          ok: false,
          hits: [],
          seen_urls: seen,
          error: "captcha_required",
          captcha_url: captchaSignal.url,
        });
        return;
      }
      if (elapsed >= timeoutMs) {
        stopCapture();
        const seen = await drainSeenUrls();
        resolve({
          ok: collectedHits.length > 0,
          hits: collectedHits.slice(),
          seen_urls: seen,
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
  if (msg.action === "capture_xhs") {
    const pattern = msg.urlPattern || "/api/sns/web/v1/search/notes";
    const timeout = msg.timeout_ms || 30000;
    captureFor(pattern, timeout, msg.min_hits || 1).then(sendResponse);
    return true; // async
  }
  if (msg.action === "scroll") {
    // 触发懒加载
    window.scrollBy(0, msg.dy || 800);
    sendResponse({ ok: true });
    return false;
  }
});
