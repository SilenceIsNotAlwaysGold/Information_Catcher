// page_hook.js — 注入到 main world (page 的 JS 上下文)
// 职责：hook fetch + XHR，捕获指定 URL 模式的响应 JSON
//
// 默认 silent 模式（不捕获、不上报），只有 isolated world (content script) 通过
// window.postMessage 发 control 信号才开始捕获。
//
// 通信协议（postMessage 双方都用 window.postMessage(..., "*")，靠 __pulse 字段做命名空间）：
//   isolated → main:
//     {__pulse:"control", action:"start", mode:"xhs.search", urlPattern:"/search/notes"}
//     {__pulse:"control", action:"drain"}    // 把已收集的吐出来
//     {__pulse:"control", action:"stop"}     // 停止捕获
//   main → isolated:
//     {__pulse:"data", hits:[{url, body}, ...]}
(function () {
  if (window.__PULSE_HOOKED__) return;
  window.__PULSE_HOOKED__ = true;

  // ──── 后台 tab 节流绕过 ─────────────────────────────────────────────
  // 扩展用 chrome.tabs.create({active:false}) 开背景 tab，
  // 浏览器把 document.visibilityState 设为 'hidden' / document.hidden=true。
  // 小红书 / 抖音的 SPA 在 hidden 状态下会跳过初始数据请求（节能），
  // 导致 user_posted / search/notes 根本不发，hook 拦不到任何东西。
  // 这里在 document_start 最早期 override 这两个属性 + 屏蔽 visibilitychange，
  // 让 SPA 以为页面始终可见。
  try {
    Object.defineProperty(document, "visibilityState", {
      configurable: true, get: () => "visible",
    });
    Object.defineProperty(document, "hidden", {
      configurable: true, get: () => false,
    });
    Object.defineProperty(document, "webkitVisibilityState", {
      configurable: true, get: () => "visible",
    });
    Object.defineProperty(document, "webkitHidden", {
      configurable: true, get: () => false,
    });
    // 屏蔽 visibilitychange 事件（避免某些 SPA 监听到一次 hidden→visible 切换乱了状态）
    const _origAdd = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, opts) {
      if (type === "visibilitychange" || type === "webkitvisibilitychange") {
        return; // 吞掉
      }
      return _origAdd.call(this, type, listener, opts);
    };
    // hasFocus 也撒谎为 true（部分 SPA 用这个判断）
    document.hasFocus = () => true;
    console.log("[pulse-hook] visibility override installed");
  } catch (e) {
    console.warn("[pulse-hook] visibility override failed:", e);
  }

  let captureOn = false;
  let urlMatcher = null; // (url:string) => boolean
  const collected = [];
  // 诊断用：所有 fetch/XHR 看到过的 URL（最多 300，FIFO）
  const seenUrls = [];
  const SEEN_LIMIT = 300;
  // 平台风控触发的特征 URL —— 看到立即给 content world 发信号，避免傻等 30s
  // redcaptcha = 小红书滑块；douyin verifycenter / iesdouyin verify = 抖音验证
  const CAPTCHA_PATTERNS = [
    "redcaptcha",
    "/captcha_v",       // 小红书别名
    "verifycenter",     // 抖音
    "verify.snssdk",    // 抖音 verify 接口
    "/verify/",
  ];
  let _captchaSignaled = false;
  function pushSeen(url, method) {
    if (!url) return;
    // 风控特征：哪怕不是 xhs/douyin 域也要识别（验证码独立子域）
    const lower = String(url).toLowerCase();
    if (!_captchaSignaled && CAPTCHA_PATTERNS.some((p) => lower.includes(p))) {
      _captchaSignaled = true;
      window.postMessage(
        { __pulse: "signal", kind: "captcha", url: String(url).slice(0, 250) },
        "*",
      );
    }
    // 只记 xhs / 抖音域，避免静态资源刷屏
    if (!/xiaohongshu\.com|douyin\.com|xhs/i.test(url)) return;
    seenUrls.push({ url: String(url).slice(0, 250), method, t: Date.now() });
    if (seenUrls.length > SEEN_LIMIT) seenUrls.shift();
  }

  function makeMatcher(pattern) {
    if (!pattern) return () => true;
    if (typeof pattern === "string") return (u) => u.includes(pattern);
    if (Array.isArray(pattern)) return (u) => pattern.some((p) => u.includes(p));
    return () => false;
  }

  function emit() {
    const out = collected.splice(0, collected.length);
    if (out.length === 0) return;
    window.postMessage({ __pulse: "data", hits: out }, "*");
  }

  // ──── hook fetch ────────────────────────────────────────────────────
  const _origFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = (() => {
      try {
        if (typeof args[0] === "string") return args[0];
        if (args[0] instanceof Request) return args[0].url;
        return String(args[0]);
      } catch { return ""; }
    })();
    pushSeen(url, (typeof args[1] === "object" && args[1]?.method) || "GET");

    const resp = await _origFetch.apply(this, args);
    if (captureOn && urlMatcher && urlMatcher(url)) {
      // clone 避免消耗原 body
      try {
        const cloned = resp.clone();
        cloned.json().then((body) => {
          collected.push({ url, body, t: Date.now() });
          // 实时把数据吐给 content world
          window.postMessage({ __pulse: "data", hits: [{ url, body, t: Date.now() }] }, "*");
        }).catch(() => {});
      } catch {}
    }
    return resp;
  };

  // ──── hook XHR ──────────────────────────────────────────────────────
  const _OrigXHR = window.XMLHttpRequest;
  function HookedXHR() {
    const xhr = new _OrigXHR();
    let _url = "";
    const _open = xhr.open;
    xhr.open = function (method, url) {
      _url = url;
      pushSeen(url, method);
      return _open.apply(this, arguments);
    };
    xhr.addEventListener("load", () => {
      if (!captureOn || !urlMatcher || !urlMatcher(_url)) return;
      try {
        const body = JSON.parse(xhr.responseText);
        collected.push({ url: _url, body, t: Date.now() });
        window.postMessage({ __pulse: "data", hits: [{ url: _url, body, t: Date.now() }] }, "*");
      } catch {}
    });
    return xhr;
  }
  // 保留 prototype 兼容
  HookedXHR.prototype = _OrigXHR.prototype;
  window.XMLHttpRequest = HookedXHR;

  // ──── 接收控制指令 ─────────────────────────────────────────────────
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const m = e.data;
    if (!m || m.__pulse !== "control") return;
    if (m.action === "start") {
      captureOn = true;
      urlMatcher = makeMatcher(m.urlPattern);
      // 清缓冲 + 重置风控信号
      collected.length = 0;
      _captchaSignaled = false;
    } else if (m.action === "stop") {
      captureOn = false;
      urlMatcher = null;
    } else if (m.action === "drain") {
      emit();
    } else if (m.action === "drain_urls") {
      // 诊断：把 hook 看到过的所有 URL 吐回 content
      window.postMessage({ __pulse: "seen_urls", urls: seenUrls.slice() }, "*");
    } else if (m.action === "read_initial_state") {
      // 主世界读 window.__INITIAL_STATE__，剪裁 user 子树（避免 1MB+ 巨对象跨 world）
      let payload = null;
      try {
        const s = window.__INITIAL_STATE__ || {};
        // 小红书博主主页 SSR 把博主信息放在 state.user 下；不同版本路径有差异
        // 整个 user 子树通常 < 50KB，安全可传
        payload = s.user || s.userPage || null;
      } catch {}
      window.postMessage({ __pulse: "initial_state", data: payload }, "*");
    }
  });

  console.log("[pulse-hook] installed in main world");
})();
