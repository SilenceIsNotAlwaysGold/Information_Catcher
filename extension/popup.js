// popup ↔ background 通信
const $ = (id) => document.getElementById(id);

// 检查当前是不是独立窗口模式（detached）
const IS_DETACHED = new URLSearchParams(location.search).get("detached") === "1";

async function rpc(action, payload = {}) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ from: "popup", action, ...payload }, (resp) => {
        // 即使 background 没正常响应，也 resolve 一个空对象，不要卡住
        resolve(resp || {});
      });
    } catch (e) {
      resolve({});
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
    chrome.storage.local.get(["serverUrl", "token", "lastTaskLog"], (items) => {
      resolve(items || {});
    });
  });
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
}

$("save").addEventListener("click", async () => {
  const serverUrl = $("server-url").value.trim().replace(/\/+$/, ""); // 去尾部斜杠
  const token = $("token").value.trim();
  if (!serverUrl) {
    alert("请填写服务器地址");
    return;
  }
  // 仅当用户输入了新 token 才覆盖；空输入保持原值
  const payload = { serverUrl };
  if (token) payload.token = token;

  $("save").textContent = "保存中…";
  $("save").disabled = true;
  await rpc("set_config", payload);
  $("token").value = "";
  // 给 background 一点时间完成 ws 握手再 refresh，让用户看到状态变化
  setTimeout(async () => {
    await refresh();
    $("save").textContent = "保存并连接";
    $("save").disabled = false;
  }, 1500);
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
