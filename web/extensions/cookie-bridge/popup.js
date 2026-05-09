// Pulse CookieBridge popup

const $ = (id) => document.getElementById(id);

async function loadCfg() {
  const cfg = await chrome.storage.local.get([
    "apiBase", "jwt", "mappings",
    "lastSync_xhs", "lastSync_douyin", "lastSync_mp",
  ]);
  $("apiBase").value = cfg.apiBase || "";
  $("jwt").value = cfg.jwt || "";
  const m = cfg.mappings || {};
  $("map_xhs").value = m.xhs || "";
  $("map_douyin").value = m.douyin || "";
  $("map_mp").value = m.mp || "";
  renderStatus(cfg);
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

function renderStatus(cfg) {
  const lines = [];
  for (const p of ["xhs", "douyin", "mp"]) {
    const last = cfg[`lastSync_${p}`];
    if (!last) {
      lines.push(`${p.padEnd(7)}  —`);
      continue;
    }
    const tag = last.ok ? "ok " : "err";
    const cls = last.ok ? "ok" : "err";
    const detail = last.ok ? "" : `  ${(last.error || "").slice(0, 60)}`;
    lines.push(`<span class="${cls}">${tag}</span>  ${p.padEnd(7)} ${fmtAgo(last.ts)}${detail}`);
  }
  $("status").innerHTML = lines.join("\n");
}

$("save").addEventListener("click", async () => {
  const apiBase = $("apiBase").value.trim().replace(/\/+$/, "");
  const jwt = $("jwt").value.trim();
  const mappings = {
    xhs: $("map_xhs").value.trim(),
    douyin: $("map_douyin").value.trim(),
    mp: $("map_mp").value.trim(),
  };
  await chrome.storage.local.set({ apiBase, jwt, mappings });
  $("status").textContent = "已保存。下一次 cookie 变化会自动推送。";
});

$("syncNow").addEventListener("click", async () => {
  $("status").textContent = "同步中…";
  const r = await chrome.runtime.sendMessage({ type: "syncAll" });
  const all = await chrome.storage.local.get([
    "lastSync_xhs", "lastSync_douyin", "lastSync_mp",
  ]);
  renderStatus(all);
});

loadCfg();
