// content/publish_douyin.js — 注入到 creator.douyin.com 的发布页
//
// P7.5 起步实现：监听 background 派的 publish_douyin 任务，模拟发布。
// 同 publish_xhs.js，但抖音的发布页 DOM 选择器不同。

console.log("[pulse-publish-douyin] content script loaded");

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.from !== "bg" || msg.action !== "publish_douyin") return;
  doPublish(msg.payload || {})
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
  return true;
});

async function doPublish(payload) {
  const { title = "", body = "", video_url = "", images = [] } = payload;

  // 1. 等上传区域
  await waitFor(() => document.querySelector('input[type="file"]'),
                15000, "upload area not ready");

  // 2. 上传视频或图片
  const file = video_url ? await urlToFile(video_url) :
               (images.length > 0 ? await urlToFile(images[0]) : null);
  if (!file) throw new Error("no media to upload");

  const fileInput = document.querySelector('input[type="file"]');
  const dt = new DataTransfer();
  dt.items.add(file);
  fileInput.files = dt.files;
  fileInput.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(5000); // 视频上传慢

  // 等上传完成（页面会跳转到第二步表单）
  await waitFor(
    () => document.querySelector('input[placeholder*="标题"]') ||
          document.querySelector('textarea[placeholder*="标题"]'),
    60000, "title field not appearing (upload may have failed)",
  );

  // 3. 填标题
  const titleInput = document.querySelector('input[placeholder*="标题"]') ||
                     document.querySelector('textarea[placeholder*="标题"]');
  setReactValue(titleInput, title);

  // 4. 填描述/话题
  const descEl = document.querySelector('div[contenteditable="true"]');
  if (descEl && body) {
    descEl.focus();
    document.execCommand("selectAll");
    document.execCommand("insertText", false, body);
  }

  // 5. 点发布
  const publishBtn = await waitFor(
    () => Array.from(document.querySelectorAll("button"))
      .find((b) => /发布|publish/i.test(b.textContent || "") && !b.disabled),
    10000, "publish button not ready",
  );
  publishBtn.click();

  // 6. 等成功
  await waitFor(
    () => document.body.innerText.includes("发布成功") ||
          location.pathname.includes("creator-micro/content/manage"),
    30000, "publish confirmation not detected",
  );

  return { ok: true };
}

function setReactValue(el, value) {
  const setter = Object.getOwnPropertyDescriptor(el.__proto__, "value").set;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

async function urlToFile(url) {
  const r = await fetch(url);
  const blob = await r.blob();
  const isVideo = blob.type.startsWith("video/");
  const ext = isVideo ? "mp4" : (blob.type.split("/")[1] || "jpg").replace("jpeg", "jpg");
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
