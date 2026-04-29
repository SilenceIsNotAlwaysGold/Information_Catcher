"""
验证代理是否真的生效：
- 用一个肯定不存在的代理（127.0.0.1:1，本机这个端口闭着）传给 account
- 走 _open_builtin（trending/comment 入口）+ httpx 路径（监控入口）
- 如果代理被真传下去了，应该报 ERR_PROXY_CONNECTION_FAILED 或类似
- 如果没传，会绕过代理直接成功 → 说明代理逻辑是假的
"""
import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from api.services import account_browser, monitor_fetcher
import httpx


BAD_PROXY = "http://127.0.0.1:1"   # 必失败的代理（端口 1 没人监听）

ACC_WITH_BAD_PROXY = {
    "id": 9999,
    "name": "verify-bad-proxy",
    "cookie": "",
    "proxy_url": BAD_PROXY,
    "user_agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
    "viewport": "",
    "timezone": "Asia/Shanghai",
    "locale": "zh-CN",
    "fp_browser_type": "builtin",
    "fp_profile_id": "",
    "fp_api_url": "",
}


async def test_playwright_path():
    """trending / comment 走的是 _open_builtin → Playwright launch with proxy."""
    print("\n=== [Playwright 路径] _open_builtin + 失效代理 ===")
    try:
        async with account_browser.open_account_context(ACC_WITH_BAD_PROXY) as (browser, context):
            page = await context.new_page()
            try:
                await page.goto("https://api.ipify.org/?format=json", timeout=8000)
                body = await page.content()
                print(f"  ❌ 代理没生效！页面成功加载: {body[:200]}")
            except Exception as e:
                msg = str(e)
                if "PROXY" in msg.upper() or "CONNECTION" in msg.upper() or "TUNNEL" in msg.upper():
                    print(f"  ✅ 代理生效：浏览器走代理失败 = {msg[:120]}")
                else:
                    print(f"  ⚠️  失败但原因不明: {msg[:200]}")
            await browser.close()
    except Exception as e:
        msg = str(e)
        if "PROXY" in msg.upper() or "ECONNREFUSED" in msg.upper() or "tunnel" in msg.lower():
            print(f"  ✅ 代理生效（在 launch 阶段就拒绝）= {msg[:120]}")
        else:
            print(f"  ⚠️  launch 抛: {msg[:200]}")


async def test_httpx_path():
    """监控帖子路径：fetch_note_metrics(account=...) 用 httpx + proxy."""
    print("\n=== [httpx 路径] monitor_fetcher.fetch_note_metrics + 失效代理 ===")
    metrics, status = await monitor_fetcher.fetch_note_metrics(
        note_id="69e810b8000000001a029c13",
        xsec_token="x",  # token 假的没关系，请求会先在代理层失败
        xsec_source="app_share",
        account=ACC_WITH_BAD_PROXY,
    )
    print(f"  metrics={metrics is not None}, status={status}")
    if status == "error" and metrics is None:
        print(f"  ✅ 代理生效（httpx 通过失效代理失败 → status=error）")
    elif status == "ok":
        print(f"  ❌ 代理没生效！直连成功了")
    else:
        print(f"  ⚠️  status={status}，结论不明")


async def test_no_account_path():
    """观测帖子的匿名通道：account=None，直连，跟代理无关。"""
    print("\n=== [匿名通道] account=None ===")
    metrics, status = await monitor_fetcher.fetch_note_metrics(
        note_id="69e810b8000000001a029c13",
        xsec_token="x",
        xsec_source="app_share",
        account=None,
    )
    print(f"  status={status}")
    print(f"  说明：匿名通道不带 account，本来就不走代理。下面验证 httpx 默认确实直连：")
    try:
        async with httpx.AsyncClient(timeout=8) as c:
            r = await c.get("https://api.ipify.org/?format=json")
            print(f"  ✅ 直连出口 IP = {r.text}")
    except Exception as e:
        print(f"  ⚠️  直连也挂了: {e}")


async def main():
    await test_playwright_path()
    await test_httpx_path()
    await test_no_account_path()


if __name__ == "__main__":
    asyncio.run(main())
