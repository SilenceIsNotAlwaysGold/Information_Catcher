"""
抖音直播间监控 v1：在线人数 + 礼物榜（HTTP API 拦截）

核心通道：浏览器加载 https://live.douyin.com/{room_id}，拦截 /webcast/web/enter/
响应——里面包含 room.user_count（在线人数）和 gift_list / sort_list（礼物榜）。

v2（弹幕 WebSocket protobuf）单独实现，需要 X-MS-Stub 签名 + protobuf 解码。
"""
from __future__ import annotations

import asyncio
import logging
import re
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


def _extract_room_id(room_url: str) -> str:
    if not room_url:
        return ""
    m = re.search(r"live\.douyin\.com/(\d+)", room_url)
    return m.group(1) if m else ""


async def fetch_live_state(room_url: str, account: Dict) -> Optional[Dict]:
    """
    返回 {online, gifts, room_id, streamer_name} 或 None（房间未开播 / 失败）。
    要求 account.platform='douyin' 且带 cookie。
    """
    if not account or not account.get("cookie"):
        logger.warning("[live] 需要带 cookie 的抖音账号")
        return None
    if (account.get("platform") or "xhs") != "douyin":
        logger.warning(f"[live] account platform={account.get('platform')} 非抖音")
        return None

    from ...account_browser import open_account_context

    captured: Dict = {}

    async with open_account_context(account) as (_browser, context):
        page = await context.new_page()

        async def on_response(response):
            url = response.url or ""
            if "/webcast/web/enter/" not in url or response.status != 200:
                return
            try:
                body = await response.json()
            except Exception:
                return
            data = body.get("data") or {}
            room = data.get("room") or {}
            user_count = room.get("user_count_str") or room.get("user_count") or 0
            try:
                online = int(user_count) if isinstance(user_count, (int, float)) else int(str(user_count).replace(",", ""))
            except Exception:
                online = 0
            owner = room.get("owner") or {}
            captured["online"] = online
            captured["room_id"] = str(room.get("id_str") or room.get("id") or "")
            captured["streamer_name"] = owner.get("nickname") or ""
            # 礼物榜：sort_list[0].sort_list 是常见路径
            gifts: List[Dict] = []
            sort_list = data.get("sort_list") or []
            if isinstance(sort_list, list):
                for sl in sort_list[:1]:
                    inner = (sl or {}).get("sort_list") or []
                    for g in inner[:10]:
                        u = (g or {}).get("user") or {}
                        gifts.append({
                            "rank": g.get("rank"),
                            "user_name": u.get("nickname") or "",
                            "score": g.get("score") or 0,
                        })
            captured["gifts"] = gifts

        page.on("response", on_response)

        try:
            await page.goto("https://www.douyin.com/", wait_until="domcontentloaded", timeout=15000)
            await asyncio.sleep(1)
            try:
                async with page.expect_response(
                    lambda r: "/webcast/web/enter/" in r.url and r.status == 200,
                    timeout=15000,
                ):
                    await page.goto(room_url, wait_until="domcontentloaded", timeout=15000)
            except Exception:
                # 拦截失败：直接 return None
                logger.warning(f"[live] 未拦截到 enter 响应：{room_url}")
                return None
            await asyncio.sleep(2)
        except Exception as e:
            logger.warning(f"[live] {room_url} 加载失败: {e}")
            return None

    return captured or None
