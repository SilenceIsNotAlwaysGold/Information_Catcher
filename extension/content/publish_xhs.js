// content/publish_xhs.js — 注入到 creator.xiaohongshu.com 的发布页
//
// P7.5 起步实现：监听 background 派的 publish_xhs 任务，模拟用户发布操作。
//
// 协议：
//   bg → content: {from:"bg", action:"publish_xhs", payload: {
//     title: "...", body: "...", images: ["url1", "url2", ...], topics: ["#xxx"],
//     poi: {...}  // 可选地点
//   }}
//   content → bg: {ok: bool, data: {note_url: "..."}, error: "..."}
//
// 当前阶段：仅做 DOM 填写 + 上传 + 点击发布的骨架，**容错较弱**。
// 后续要 hardening：上传进度等待、异常监测、二次发布拦截、风控验证码处理。

console.log("[pulse-publish-xhs] content script loaded");

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.from !== "bg" || msg.action !== "publish_xhs") return;
  doPublish(msg.payload || {})
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
  return true;
});

async function doPublish(payload) {
  const { title = "", body = "", images = [], topics = [] } = payload;

  // 1. 等发布表单的关键控件就绪
  await waitFor(() => document.querySelector('[class*="upload"]') || document.querySelector('input[type="file"]'),
                15000, "upload area not ready");

  // 2. 上传图片：图片是 URL，先 fetch 成 Blob 再触发 input 的 change
  if (images.length > 0) {
    const fileInput = await waitFor(
      () => document.querySelector('input[type="file"]'),
      8000, "file input not found",
    );
    const files = await Promise.all(images.map(urlToFile));
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    await sleep(3000); // 等上传组件渲染
  }

  // 3. 填标题
  const titleInput = await waitFor(
    () => document.querySelector('input[placeholder*="标题"]') ||
          document.querySelector('input[class*="title"]'),
    10000, "title input not found",
  );
  setReactValue(titleInput, title);

  // 4. 填正文（contenteditable div）
  const bodyEl = await waitFor(
    () => document.querySelector('[class*="content-editor"] [contenteditable]') ||
          document.querySelector('[contenteditable="true"]'),
    8000, "body editor not found",
  );
  bodyEl.focus();
  document.execCommand("selectAll", false);
  document.execCommand("insertText", false, body);

  // 话题（可选）
  for (const t of topics) {
    document.execCommand("insertText", false, ` ${t}`);
    await sleep(500);
  }

  // 5. 找发布按钮并点击（可能要先找到表单底部的 "发布" 按钮）
  const publishBtn = await waitFor(
    () => Array.from(document.querySelectorAll("button"))
      .find((b) => /发布|publish/i.test(b.textContent || "") && !b.disabled),
    10000, "publish button not found / disabled",
  );
  publishBtn.click();

  // 6. 等成功提示（DOM 上有"发布成功"或跳转）
  await waitFor(
    () => document.body.innerText.includes("发布成功") ||
          location.pathname.includes("/note/") ||
          location.pathname.includes("/explore/"),
    20000, "publish confirmation not detected",
  );

  return { note_url: location.href };
}

function setReactValue(el, value) {
  const setter = Object.getOwnPropertyDescriptor(el.__proto__, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

async function urlToFile(url) {
  const r = await fetch(url);
  const blob = await r.blob();
  const ext = (blob.type.split("/")[1] || "jpg").replace("jpeg", "jpg");
  return new File([blob], `pulse-${Date.now()}.${ext}`, { type: blob.type });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(predicate, timeoutMs, errMsg) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const v = predicate();
      if (v) return v;
    } catch {}
    await sleep(300);
  }
  throw new Error(errMsg || "waitFor timeout");
}
