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

// 派发真实的 wheel 事件 —— 抖音 SPA 部分懒加载触发器只监听 wheel，
// 不监听 scroll；programmatic scrollTo 不触发 wheel。
function dispatchWheel(deltaY) {
  try {
    const opts = { deltaY, bubbles: true, cancelable: true, deltaMode: 0 };
    document.dispatchEvent(new WheelEvent("wheel", opts));
    window.dispatchEvent(new WheelEvent("wheel", opts));
  } catch {}
}

function startAutoScroll(mode = "feed") {
  stopAutoScroll();
  _scrollPos = 0;
  if (mode === "creator") {
    // 多次尝试点击「作品」tab（部分博主默认在「直播」/「合集」）
    setTimeout(() => { try { tryClickWorksTab(); } catch {} }, 500);
    setTimeout(() => { try { tryClickWorksTab(); } catch {} }, 2500);
    setTimeout(() => { try { tryClickWorksTab(); } catch {} }, 5000);
    // 渐进式 scroll + wheel 事件双保险
    // 之前的 bug：刚进页面时 scrollHeight 短 → _scrollPos > max → 跳 0 → 永远停在顶上
    let phase = 0;
    _autoScrollTimer = setInterval(() => {
      try {
        const el = document.scrollingElement || document.documentElement;
        phase++;
        // 每 8 个 tick 做一次「滚到底 + 滚回顶」的大幅刺激
        if (phase % 8 === 0) {
          el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
          dispatchWheel(800);
          setTimeout(() => {
            try { el.scrollTo({ top: 0, behavior: "auto" }); } catch {}
          }, 300);
          return;
        }
        // 常规 tick：scrollBy 600px + 派发 wheel
        // 用 scrollBy 而非 scrollTo —— 不需要预测 scrollHeight，浏览器自动 clamp
        el.scrollBy({ top: 600, behavior: "auto" });
        dispatchWheel(600);
      } catch {}
    }, 700);
    return;
  }
  // feed 模式：直接刷到底（搜索结果 / 评论列表）
  _autoScrollTimer = setInterval(() => {
    try {
      const el = document.scrollingElement || document.documentElement;
      el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
      dispatchWheel(800);
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

// ─── DOM 兜底：直接读抖音博主主页可见信息 ───────────────────────────────
//
// 抖音的 aweme/post XHR 走 IntersectionObserver 懒加载，在 popup window /
// 后台 tab 里不一定能触发。但页面 DOM 里其实已经有 SSR 渲染好的：
//   - data-e2e="user-info-{follow,fans,like}" → 关注/粉丝/获赞 数字（含「万」单位）
//   - tab 列表里有「作品 N」文字
//   - 「作品」grid 里前 N 条 <a href="/video/{aweme_id}">
// 直接抓这些就够判断是否有更新（作品数变了 / 第一条 ID 变了）。
function readDomDouyinCreator() {
  const out = { profile: {}, posts: [], debug: {} };
  try {
    // 1) 基本信息
    const grab = (sel) => {
      const el = document.querySelector(sel);
      return el ? (el.textContent || "").trim() : "";
    };
    const followsText = grab('[data-e2e="user-info-follow"] :nth-child(2)') || grab('[data-e2e="user-info-follow"]');
    const fansText = grab('[data-e2e="user-info-fans"] :nth-child(2)') || grab('[data-e2e="user-info-fans"]');
    const likesText = grab('[data-e2e="user-info-like"] :nth-child(2)') || grab('[data-e2e="user-info-like"]');
    out.profile.follows_text = followsText;
    out.profile.fans_text = fansText;
    out.profile.likes_text = likesText;
    out.debug.fans_raw = fansText;

    // 昵称 / 简介 — 抖音 user-detail 第一个 h1 通常是昵称
    const nickEl = document.querySelector('[data-e2e="user-info"] h1, [data-e2e="user-detail"] h1, .user-info h1');
    if (nickEl) out.profile.creator_name = (nickEl.textContent || "").trim().slice(0, 100);
    if (!out.profile.creator_name) {
      // 兜底：document.title 形如 "{昵称}的主页 - 抖音"
      const m = (document.title || "").match(/^(.+?)的主页/);
      if (m) out.profile.creator_name = m[1];
    }
    const avatarImg = document.querySelector('[data-e2e="user-info"] img, [data-e2e="user-detail"] img');
    if (avatarImg) out.profile.avatar_url = avatarImg.getAttribute("src") || "";

    const descEl = document.querySelector('[data-e2e="user-info"] p, [data-e2e="user-detail"] p');
    if (descEl) out.profile.desc_text = (descEl.textContent || "").trim().slice(0, 300);

    // 2) 作品数：从 tab 「作品 214」抠数字
    let notesText = "";
    const tabs = document.querySelectorAll('[data-e2e="user-tab-list"] *, [data-e2e^="user-tab"]');
    for (const t of tabs) {
      const tx = (t.textContent || "").trim();
      // 期望严格匹配「作品 214」/ 「作品214」，避免误中「作品集」
      const m = tx.match(/^作品\s*([0-9][0-9.,]*\s*[万亿wWkK]?)$/);
      if (m) { notesText = m[1].trim(); break; }
    }
    if (!notesText) {
      // 兜底：扫页面任何带「作品」的短文本
      for (const el of document.querySelectorAll("div,span,a")) {
        const tx = (el.textContent || "").trim();
        if (tx.length > 30) continue;
        const m = tx.match(/^作品\s*([0-9][0-9.,]*\s*[万亿wWkK]?)$/);
        if (m) { notesText = m[1].trim(); break; }
      }
    }
    out.profile.notes_text = notesText;

    // 3) 作品列表：grid 里 <a href="/video/{id}">
    const seen = new Set();
    const linkSels = [
      '[data-e2e="user-post-list"] a[href*="/video/"]',
      '[data-e2e="scroll-list"] a[href*="/video/"]',
      'a[href*="/video/"]',  // 兜底
    ];
    let links = [];
    for (const sel of linkSels) {
      links = document.querySelectorAll(sel);
      if (links.length > 0) { out.debug.link_sel = sel; break; }
    }
    for (const a of links) {
      const href = a.getAttribute("href") || "";
      const m = href.match(/\/video\/([0-9]+)/);
      if (!m) continue;
      const aid = m[1];
      if (seen.has(aid)) continue;
      seen.add(aid);
      // 寻找这个 link 内或邻近的 <img> 作为封面
      const img = a.querySelector("img") || a.parentElement?.querySelector("img");
      // 标题：抖音 cover img 的 alt 属性才是视频文案；
      // a 里的 textContent / 纯 span 通常是点赞数（"1225"、"1.1万"），不能当标题
      let title = (img?.getAttribute("alt") || "").trim();
      // 兜底：找显式带 title/desc/text 的容器
      if (!title) {
        const titleEl = a.querySelector('[class*="title"]:not([class*="like"]), [class*="desc"]:not([class*="like"]), [class*="caption"]');
        if (titleEl) {
          const tx = (titleEl.textContent || "").trim();
          // 确认不是纯数字（避免误中点赞数）
          if (tx && !/^[0-9][0-9.,]*\s*[万亿wWkK]?$/.test(tx)) title = tx;
        }
      }
      // 点赞数：a 内的纯数字（含「万/亿」单位）span
      let likedText = "";
      for (const sp of a.querySelectorAll("span, div")) {
        const tx = (sp.textContent || "").trim();
        if (/^[0-9][0-9.,]*\s*[万亿wWkK]?$/.test(tx) && tx.length <= 8) {
          likedText = tx;
          break;
        }
      }
      out.posts.push({
        post_id: aid,
        url: `https://www.douyin.com/video/${aid}`,
        title: title.slice(0, 200),
        cover_url: img?.getAttribute("src") || img?.getAttribute("data-src") || "",
        liked_count_text: likedText,
      });
      if (out.posts.length >= 30) break;
    }
    out.debug.posts_count = out.posts.length;
  } catch (e) {
    out.debug.error = String(e?.message || e);
  }
  return out;
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
  if (msg.action === "read_dom_creator") {
    sendResponse(readDomDouyinCreator());
    return false;
  }
});
