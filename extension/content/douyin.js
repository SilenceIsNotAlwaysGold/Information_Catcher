// content/douyin.js — isolated world bridge on douyin.com
// 行为与 xhs.js 完全一致，只是消息 action 不同。page_hook.js 已经在 main world
// 由 manifest content_scripts 自动注入到 douyin.com，这里只做 control 桥接。

console.log("[pulse-content] douyin content script loaded");

const collectedHits = [];
let collectedSeenUrls = [];
let captureActive = false;
let pendingSeenResolver = null;
let captchaSignal = null;

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

// capture 期间自动滚动 — 触发抖音的 IntersectionObserver / 瀑布流翻页
//
// 两种模式（背景脚本可指定 scroll_mode）：
//   "feed"    （默认）— 搜索 / 评论 / 直播页，list 是连续的 feed，直接 scrollTo bottom
//   "creator" — 博主主页，作品列表在「作品」tab 下、走 IntersectionObserver 懒加载。
//               jumpScroll 到底反而触发不了 observer（视口在 footer，post grid 不在 viewport）。
//               改为：先点「作品」tab，再渐进 scrollBy(0, 600~900) 反复让 grid 进入视口。
let _autoScrollTimer = null;
let _scrollPos = 0;

function tryClickWorksTab() {
  // 只点 data-e2e 命名空间下的 tab 按钮 —— 抖音用 div+onClick 实现，不会触发硬导航。
  // 之前的兜底 querySelectorAll("a,button,div,span,li") 会误中 <a href> 链接，
  // 点下去整页面跳走，content script 被销毁，bg 收到 "message channel closed"。
  const sel = '[data-e2e="user-tab-list"] [data-e2e^="user-tab-"], [data-e2e^="user-tab"]';
  const tabs = document.querySelectorAll(sel);
  for (const el of tabs) {
    const t = (el.textContent || "").trim();
    if (t.includes("作品") && !t.includes("喜欢") && !t.includes("收藏")) {
      // 严防误中 <a>：当前节点或父链路只要有 href 就跳过
      let cur = el;
      let dangerous = false;
      for (let i = 0; i < 4 && cur; i++) {
        if (cur.tagName === "A" && cur.getAttribute("href")) { dangerous = true; break; }
        cur = cur.parentElement;
      }
      if (dangerous) continue;
      try { el.click(); return true; } catch {}
    }
  }
  return false;
}

function startAutoScroll(mode = "feed") {
  stopAutoScroll();
  _scrollPos = 0;
  if (mode === "creator") {
    // 第一次先点击「作品」tab（部分博主默认在「直播」/「合集」）
    setTimeout(() => { try { tryClickWorksTab(); } catch {} }, 300);
    setTimeout(() => { try { tryClickWorksTab(); } catch {} }, 1500);
    // 渐进 scroll：每 800ms 下移 700px，到底后回顶再来一遍
    _autoScrollTimer = setInterval(() => {
      try {
        const el = document.scrollingElement || document.documentElement;
        const max = el.scrollHeight - el.clientHeight;
        _scrollPos += 700;
        if (_scrollPos > max) {
          // 到底：回顶 + 重新滚（让 IntersectionObserver 在第二次滚动时再触发一遍）
          _scrollPos = 0;
          el.scrollTo({ top: 0, behavior: "auto" });
        } else {
          el.scrollTo({ top: _scrollPos, behavior: "auto" });
        }
      } catch {}
    }, 800);
    return;
  }
  // feed 模式：直接刷到底（搜索结果 / 评论列表）
  _autoScrollTimer = setInterval(() => {
    try {
      const el = document.scrollingElement || document.documentElement;
      el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
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

async function captureFor(urlPattern, timeoutMs, minHits = 1, scrollMode = "feed") {
  startCapture(urlPattern);
  startAutoScroll(scrollMode);
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
      if (captchaSignal && collectedHits.length === 0) {
        await finish({ ok: false, error: "captcha_required", captcha_url: captchaSignal.url });
        return;
      }
      if (elapsed >= timeoutMs) {
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
  if (msg.action === "capture_douyin") {
    const pattern = msg.urlPattern || [
      "/aweme/v1/web/general/search/single",
      "/aweme/v1/web/search/item",
      "/aweme/v1/web/search/general",
    ];
    const timeout = msg.timeout_ms || 30000;
    const scrollMode = msg.scroll_mode || "feed";
    // 永远兜底 sendResponse —— 否则 captureFor 任何 reject 都会让 bg 收到
    // "message channel closed before a response was received"
    captureFor(pattern, timeout, msg.min_hits ?? 0, scrollMode)
      .then((r) => sendResponse(r))
      .catch((e) => {
        try {
          stopCapture();
          stopAutoScroll();
        } catch {}
        sendResponse({
          ok: false,
          error: "capture_threw: " + String(e?.message || e),
          hits: collectedHits.slice(),
          seen_urls: collectedSeenUrls.slice(),
        });
      });
    return true;
  }
  if (msg.action === "scroll") {
    window.scrollBy(0, msg.dy || 800);
    sendResponse({ ok: true });
    return false;
  }
});
