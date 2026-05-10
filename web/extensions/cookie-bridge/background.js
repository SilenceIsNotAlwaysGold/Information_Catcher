// Pulse CookieBridge — service worker
//
// 设计要点：
//  1. 监听 chrome.cookies.onChanged，检测三平台域的关键字段（小红书 web_session/a1，
//     抖音 sessionid，公众号 token 等）变化时把整域 cookie 拼成串推送到 Pulse 后端。
//  2. 也提供 chrome.alarms 周期性主动同步（每 30 分钟一次）：避免长尾未触发场景。
//  3. 后端通过 (account_name + platform + JWT 用户身份) 匹配账号；扩展不创建账号。
//
// 配置存在 chrome.storage.local：
//   - apiBase   : Pulse 后端 base URL（如 http://127.0.0.1:8080）
//   - jwt       : 登录 Pulse 后从 Web 控制台拷贝的 JWT
//   - mappings  : { "xhs": "blogger账号A", "douyin": "blogger账号B" }
// 三者缺一即不工作（popup 引导用户填）。

const PLATFORM_DOMAINS = {
  xhs: ".xiaohongshu.com",
  douyin: ".douyin.com",
  mp: ".weixin.qq.com",
};

const KEY_FIELDS = {
  // 小红书签名必需 a1；web_session 是登录态
  xhs: ["a1", "web_session"],
  douyin: ["sessionid", "ttwid"],
  mp: ["data_bizuin", "slave_user"],
};

const SYNC_ALARM = "pulse-cookie-bridge-periodic";
const SYNC_INTERVAL_MIN = 30;
const DEBOUNCE_MS = 5000; // cookie 风暴时合并为一次推送

const _pendingTimers = {};

async function loadConfig() {
  const cfg = await chrome.storage.local.get(["apiBase", "jwt", "mappings"]);
  return {
    apiBase: (cfg.apiBase || "").replace(/\/+$/, ""),
    jwt: cfg.jwt || "",
    mappings: cfg.mappings || {},
  };
}

async function getCookiesForDomain(domain) {
  // chrome.cookies.getAll 接受 domain（不带前导点匹配子域）
  const cookies = await chrome.cookies.getAll({ domain: domain.replace(/^\./, "") });
  return cookies;
}

function buildCookieString(cookies) {
  // 转成 `a1=xxx; web_session=yyy` 形式
  const seen = new Set();
  const parts = [];
  for (const c of cookies) {
    if (!c.name || seen.has(c.name)) continue;
    seen.add(c.name);
    parts.push(`${c.name}=${c.value}`);
  }
  return parts.join("; ");
}

async function syncPlatform(platform) {
  const cfg = await loadConfig();
  if (!cfg.apiBase || !cfg.jwt) {
    console.log("[CookieBridge] missing apiBase/jwt; skip");
    return { ok: false, reason: "config_missing" };
  }
  const accountName = cfg.mappings[platform];
  if (!accountName) {
    console.log(`[CookieBridge] no mapping for platform=${platform}; skip`);
    return { ok: false, reason: "no_mapping" };
  }
  const domain = PLATFORM_DOMAINS[platform];
  if (!domain) return { ok: false, reason: "unknown_platform" };

  const cookies = await getCookiesForDomain(domain);
  if (!cookies.length) {
    return { ok: false, reason: "no_cookies" };
  }
  const cookieStr = buildCookieString(cookies);

  // 检查关键字段是否齐
  const required = KEY_FIELDS[platform] || [];
  const missing = required.filter((k) => !new RegExp(`(^|;\\s*)${k}=`).test(cookieStr));
  if (missing.length) {
    console.log(`[CookieBridge] ${platform} cookie missing key fields:`, missing);
    return { ok: false, reason: "missing_fields", missing };
  }

  try {
    const resp = await fetch(`${cfg.apiBase}/api/monitor/accounts/cookie/sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.jwt}`,
      },
      body: JSON.stringify({
        account_name: accountName,
        platform,
        cookie: cookieStr,
        source: "extension",
      }),
    });
    const text = await resp.text();
    if (!resp.ok) {
      console.warn(`[CookieBridge] sync ${platform} HTTP ${resp.status}: ${text}`);
      await chrome.storage.local.set({
        [`lastSync_${platform}`]: { ok: false, ts: Date.now(), error: text },
      });
      return { ok: false, status: resp.status, error: text };
    }
    await chrome.storage.local.set({
      [`lastSync_${platform}`]: { ok: true, ts: Date.now() },
    });
    console.log(`[CookieBridge] synced ${platform} → ${accountName}`);
    return { ok: true };
  } catch (e) {
    console.warn(`[CookieBridge] sync ${platform} failed:`, e);
    await chrome.storage.local.set({
      [`lastSync_${platform}`]: { ok: false, ts: Date.now(), error: String(e) },
    });
    return { ok: false, error: String(e) };
  }
}

function debounceSync(platform) {
  if (_pendingTimers[platform]) {
    clearTimeout(_pendingTimers[platform]);
  }
  _pendingTimers[platform] = setTimeout(() => {
    delete _pendingTimers[platform];
    syncPlatform(platform);
  }, DEBOUNCE_MS);
}

chrome.cookies.onChanged.addListener((changeInfo) => {
  const c = changeInfo.cookie;
  if (!c || !c.domain) return;
  for (const [platform, domain] of Object.entries(PLATFORM_DOMAINS)) {
    const baseDomain = domain.replace(/^\./, "");
    if (c.domain === domain || c.domain === baseDomain || c.domain.endsWith(domain)) {
      const fields = KEY_FIELDS[platform] || [];
      if (!fields.length || fields.includes(c.name)) {
        debounceSync(platform);
      }
      break;
    }
  }
});

// 周期性兜底同步
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_INTERVAL_MIN });
});
chrome.runtime.onStartup.addListener(async () => {
  await chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_INTERVAL_MIN });
});
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== SYNC_ALARM) return;
  for (const platform of Object.keys(PLATFORM_DOMAINS)) {
    await syncPlatform(platform);
  }
});

// 来自 popup 的手动同步消息
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "syncNow") {
    (async () => {
      const platform = msg.platform || "xhs";
      const r = await syncPlatform(platform);
      sendResponse(r);
    })();
    return true; // async response
  }
  if (msg && msg.type === "syncAll") {
    (async () => {
      const out = {};
      for (const platform of Object.keys(PLATFORM_DOMAINS)) {
        out[platform] = await syncPlatform(platform);
      }
      sendResponse(out);
    })();
    return true;
  }
});


// ── MP 凭证捕获 (uin/key/pass_ticket/appmsg_token) ─────────────────────────
//
// 公众号阅读数 / 在看数走 mp.weixin.qq.com/mp/getappmsgext，需要四个临时凭证：
//   - uin / key / pass_ticket：URL query
//   - appmsg_token：URL query 里也常出现，或在 /mp/profile_ext 那种页面里
// 这些值 30 分钟过期，老路径靠用户手动从浏览器抓包拷出来粘进 PulseUI。
// 这里用 chrome.webRequest 监听打开公众号文章的请求，从 URL 里直接刨出来推到后端。

const _mpAuthCache = { uin: "", key: "", pass_ticket: "", appmsg_token: "" };
let _mpAuthLastSyncAt = 0;

function _extractMpAuthFromUrl(url) {
  try {
    const u = new URL(url);
    const out = {};
    for (const k of ["uin", "key", "pass_ticket", "appmsg_token"]) {
      const v = u.searchParams.get(k);
      if (v) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

async function _maybeSyncMpAuth() {
  // 4 字段齐才推
  if (!_mpAuthCache.uin || !_mpAuthCache.key || !_mpAuthCache.pass_ticket) {
    return;
  }
  // appmsg_token 不是每个 URL 都有，没拿到也认（后端可降级）
  // 同步频率：60 秒内只推一次（避免文章里大量 ajax 把后端打满）
  const now = Date.now();
  if (now - _mpAuthLastSyncAt < 60 * 1000) return;

  const cfg = await loadConfig();
  if (!cfg.apiBase || !cfg.jwt) return;

  _mpAuthLastSyncAt = now;
  try {
    const resp = await fetch(`${cfg.apiBase}/api/auth/me/mp-auth`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.jwt}`,
      },
      body: JSON.stringify({
        uin: _mpAuthCache.uin,
        key: _mpAuthCache.key,
        pass_ticket: _mpAuthCache.pass_ticket,
        appmsg_token: _mpAuthCache.appmsg_token || "",
      }),
    });
    const ok = resp.ok;
    await chrome.storage.local.set({
      lastSync_mp_auth: { ok, ts: now, error: ok ? "" : await resp.text().catch(() => "") },
    });
    console.log(`[CookieBridge] mp_auth sync ${ok ? "ok" : "failed"}`);
  } catch (e) {
    console.warn("[CookieBridge] mp_auth sync error:", e);
    await chrome.storage.local.set({
      lastSync_mp_auth: { ok: false, ts: now, error: String(e) },
    });
  }
}

if (chrome.webRequest && chrome.webRequest.onBeforeRequest) {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      const fields = _extractMpAuthFromUrl(details.url);
      let updated = false;
      for (const k of Object.keys(fields)) {
        if (fields[k] && fields[k] !== _mpAuthCache[k]) {
          _mpAuthCache[k] = fields[k];
          updated = true;
        }
      }
      if (updated) {
        // fire-and-forget；service worker 异步任务不阻塞请求
        _maybeSyncMpAuth();
      }
    },
    {
      urls: [
        "https://mp.weixin.qq.com/*",
        "https://*.mp.weixin.qq.com/*",
      ],
    },
  );
}
