"""巨量算数 (trendinsight.oceanengine.com) 抓包/解析模块。

字节官方数据平台，覆盖抖音 + 头条关键词指数、热点榜单、人群画像。
注册即免费用，比直接爬抖音搜索 API 风控宽松 N 个数量级。

当前实现阶段（M1 step 1）：探索性抓包工具
  目的：用真实 cookie 加载页面，dump 所有命中接口的响应到本地，
       拿到结构后再写解析层。

下一阶段（M1 step 2）：稳定解析 + 关联视频补全（调 douyin/fetcher.py 匿名通道）

CLI 用法：
    uv run python -m api.services.platforms.douyin.trendinsight_fetcher explore \\
        --cookie "passport_csrf_token=...; sessionid=..." \\
        --keyword "淘宝好物"

Python 用法：
    from api.services.platforms.douyin.trendinsight_fetcher import explore_keyword
    result = await explore_keyword("淘宝好物", cookie="...")
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import quote, urlparse

logger = logging.getLogger(__name__)

TRENDINSIGHT_HOST = "trendinsight.oceanengine.com"
KEYWORD_PAGE_TPL = "https://trendinsight.oceanengine.com/arithmetic-index?keyword_word_list={kw}"
HOT_PAGE_TPL = "https://trendinsight.oceanengine.com/arithmetic-rank/{kind}"
DEFAULT_DUMP_DIR = Path("/tmp/trendinsight_dump")


def _cookie_to_playwright(cookie_str: str) -> List[Dict[str, Any]]:
    """字节系账号 SSO 同源，cookie 跨 .oceanengine.com / .bytedance.com / .douyin.com。
    保守起见全设到 .oceanengine.com（trendinsight 主域）。"""
    out: List[Dict[str, Any]] = []
    for part in (cookie_str or "").split(";"):
        part = part.strip()
        if "=" not in part:
            continue
        name, _, value = part.partition("=")
        out.append({
            "name": name.strip(),
            "value": value.strip(),
            "domain": ".oceanengine.com",
            "path": "/",
        })
    return out


async def _dump_response(response, dump_dir: Path, counter: Dict[str, int]) -> Optional[Dict[str, Any]]:
    """把命中 trendinsight API 的响应保存到磁盘，并返回简要描述给调用方。"""
    url = response.url or ""
    if TRENDINSIGHT_HOST not in url:
        return None
    if "/api/" not in url:
        return None
    if response.status != 200:
        return {"url": url, "status": response.status, "saved": False}

    parsed = urlparse(url)
    # endpoint 用作文件名安全前缀
    endpoint_safe = parsed.path.strip("/").replace("/", "_") or "root"
    counter[endpoint_safe] = counter.get(endpoint_safe, 0) + 1
    fname = f"{endpoint_safe}_{counter[endpoint_safe]:02d}.json"

    try:
        body = await response.json()
    except Exception:
        try:
            text = await response.text()
            (dump_dir / (fname.rsplit(".", 1)[0] + ".txt")).write_text(text, encoding="utf-8")
            return {"url": url, "status": 200, "saved": True, "format": "text"}
        except Exception as e:
            return {"url": url, "status": 200, "saved": False, "error": str(e)}

    payload = {
        "url": url,
        "method": response.request.method if response.request else "GET",
        "query": parsed.query,
        "body": body,
    }
    (dump_dir / fname).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return {"url": url, "status": 200, "saved": True, "endpoint": parsed.path}


async def explore_keyword(
    keyword: str,
    cookie: str,
    *,
    dump_dir: Optional[Path] = None,
    timeout_sec: int = 30,
    headless: bool = True,
) -> Dict[str, Any]:
    """加载 trendinsight 关键词页，dump 所有命中的 API 响应。

    返回:
        {
            "keyword": ...,
            "dump_dir": "/tmp/trendinsight_dump/<ts>",
            "endpoints_hit": [{"url":..., "endpoint":..., "saved": bool}, ...],
            "page_title": "...",
        }
    """
    from playwright.async_api import async_playwright

    ts = int(time.time())
    dump_dir = (dump_dir or DEFAULT_DUMP_DIR) / f"{ts}_{quote(keyword, safe='')[:30]}"
    dump_dir.mkdir(parents=True, exist_ok=True)
    logger.info(f"[trendinsight] dump dir: {dump_dir}")

    counter: Dict[str, int] = {}
    hits: List[Dict[str, Any]] = []

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            headless=headless,
            args=[
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-blink-features=AutomationControlled",
            ],
        )
        try:
            context = await browser.new_context(
                user_agent=(
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
                ),
                locale="zh-CN",
                timezone_id="Asia/Shanghai",
                viewport={"width": 1440, "height": 900},
            )

            ck = _cookie_to_playwright(cookie)
            if ck:
                await context.add_cookies(ck)
                logger.info(f"[trendinsight] injected {len(ck)} cookies")

            page = await context.new_page()

            async def _on_response(resp):
                desc = await _dump_response(resp, dump_dir, counter)
                if desc:
                    hits.append(desc)

            page.on("response", _on_response)

            url = KEYWORD_PAGE_TPL.format(kw=quote(keyword, safe=""))
            logger.info(f"[trendinsight] navigating to {url}")
            try:
                await page.goto(url, wait_until="networkidle", timeout=timeout_sec * 1000)
            except Exception as e:
                logger.warning(f"[trendinsight] networkidle wait timeout: {e}; collecting current state")
                # 即使 networkidle 没到也继续 — 已经触发的请求已被拦截
                await asyncio.sleep(3)

            # 让懒加载组件再发一波请求
            try:
                await page.mouse.wheel(0, 800)
                await asyncio.sleep(2)
                await page.mouse.wheel(0, 1500)
                await asyncio.sleep(2)
            except Exception:
                pass

            page_title = await page.title()
            # 检测登录墙
            try:
                login_hit = await page.evaluate(
                    "() => document.body.innerText.includes('登录') && "
                    "document.body.innerText.includes('扫码')"
                )
            except Exception:
                login_hit = False

            return {
                "keyword": keyword,
                "dump_dir": str(dump_dir),
                "endpoints_hit": hits,
                "page_title": page_title,
                "login_wall_detected": bool(login_hit),
            }
        finally:
            await browser.close()


async def main_cli():
    import argparse

    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    explore = sub.add_parser("explore", help="探索性抓包 trendinsight 关键词页")
    explore.add_argument("--keyword", required=True)
    explore.add_argument(
        "--cookie", default="",
        help="字节系账号 cookie 字符串 (登录 trendinsight 后从浏览器复制)",
    )
    explore.add_argument("--dump-dir", default=None, help="dump 目录, 默认 /tmp/trendinsight_dump")
    explore.add_argument("--no-headless", action="store_true")

    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    if args.cmd == "explore":
        result = await explore_keyword(
            args.keyword,
            cookie=args.cookie,
            dump_dir=Path(args.dump_dir) if args.dump_dir else None,
            headless=not args.no_headless,
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main_cli())
