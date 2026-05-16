# -*- coding: utf-8 -*-
"""原创板块 —— 用户提供文字底稿 → AI 按平台风格改写成成品。

和"仿写床"的区别：
  - 仿写：抓别人爆款 → AI 模仿改造
  - 原创：用户自己写了一段（可能很糙）→ AI 按平台调性润色 / 重写

支持 3 个平台：
  - xhs:    小红书爆款体，emoji 多、短分段、个人口吻、首句钩子 + 价值清单 + 引导互动
  - douyin: 抖音口播风，第一句 5 秒钩子，节奏快、口语化、留悬念到结尾
  - mp:     公众号长文风，结构化标题、有起承转合、可读性优先

计费：feature='cross_rewrite'，0.5 点 / 次。
"""
from __future__ import annotations

import logging
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..services import ai_client
from .auth import get_current_user

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/original", tags=["Original"])

Platform = Literal["xhs", "douyin", "mp"]


# ── 各平台的 system prompt ────────────────────────────────────────────────

_PROMPTS: dict[str, str] = {
    "xhs": """你是小红书爆款笔记创作者。把用户提供的底稿改写成一篇典型的小红书笔记。

要点：
- **首句钩子**：第一句 15 字内，制造好奇 / 痛点 / 反差，必须让人继续看下去
- **emoji 适度**：每段开头 / 关键词后用 1-2 个，整篇不超过 15 个，不要刷屏
- **短段**：每段 2-3 行（小红书行宽窄），多分段加呼吸感
- **个人口吻**：用"我 / 你 / 姐妹们"，不要"大家"这种群体词
- **数字 + 清单**：能列点的部分用「① ② ③」或「✅」
- **结尾互动**：最后一句问读者一句话或求评论
- **标题**：开头单独一行，加 2-3 个 emoji + 一个最大的钩子，例如「我用 3 个动作让客厅大一倍 🛋️✨」

字数：成稿 200-400 字（不含标题）。
直接输出标题 + 正文，不要任何"以下是改写："这种前缀。
""",

    "douyin": """你是抖音爆款短视频脚本作者。把用户提供的底稿改写成一段适合 30 秒-60 秒口播的脚本。

要点：
- **5 秒钩子**：前两句必须立刻抓住人，制造好奇 / 反差 / 痛点 / 数字
- **口语化**：完全像和朋友聊天，不要书面词。可以用"兄弟 / 家人们 / 老铁"等
- **节奏快**：句子短，一句 8-15 字，多用"!"和"?"
- **留悬念**：中间设 1-2 个钩子（如"但是接下来才是关键"）让观众停留
- **结尾 CTA**：最后引导点赞 / 评论 / 关注，明确说出来
- **配镜头说明**：每段口播后用括号写 [镜头：xxx]，比如 [镜头：实拍特写]、[镜头：表情包]

格式：
开头：（口播 + 镜头）
转折：（口播 + 镜头）
…
结尾：（CTA 口播 + 镜头）

直接输出脚本，不要"以下是改写："这种前缀。
""",

    "mp": """你是微信公众号专栏作者。把用户提供的底稿改写成一篇结构清晰、有质感的公众号长文。

要点：
- **大标题**：14 字内，言简意赅但有钩子（疑问 / 数字 / 反差）
- **导语段**：300-500 字内，用具体场景或一个小故事切入，迅速建立读者代入感
- **小标题分段**：3-5 个二级标题（用「01 / 02」或「一、二、」编号），每段 200-400 字
- **数据 / 例子**：抽象观点必须配具体例子或数据支撑，不要全篇大道理
- **节奏**：长短句交替，避免段落超过 5 行
- **结尾**：一句金句或一个开放问题留给读者思考
- **不要**：emoji 不超过 5 个，全文不要"姐妹们""家人们"这种短平台口吻

字数：成稿 1200-2000 字。
直接输出标题 + 全文，不要"以下是改写："这种前缀。
""",
}

_LABELS = {"xhs": "小红书", "douyin": "抖音", "mp": "公众号"}


# ── API ────────────────────────────────────────────────────────────────────

class RewriteIn(BaseModel):
    platform: Platform
    source_text: str = Field(..., min_length=10, max_length=8000, description="用户底稿")
    text_model_id: Optional[int] = None
    extra_hint: str = Field("", max_length=200, description="额外要求：行业 / 调性 / 字数 等")


@router.post("/rewrite", summary="按平台风格改写底稿（扣 cross_rewrite 点）")
async def rewrite(body: RewriteIn, current_user: dict = Depends(get_current_user)):
    uid = int(current_user["id"])
    sys_prompt = _PROMPTS.get(body.platform)
    if not sys_prompt:
        raise HTTPException(400, f"不支持的平台：{body.platform}")

    user_prompt = f"=== 用户底稿 ===\n{body.source_text.strip()}\n"
    if body.extra_hint.strip():
        user_prompt += f"\n=== 额外要求 ===\n{body.extra_hint.strip()}\n"
    user_prompt += f"\n请把这段底稿改写成 {_LABELS[body.platform]} 风格的成品。"

    try:
        out = await ai_client.call_text(
            user_prompt,
            model_id=body.text_model_id,
            user_id=uid,
            feature="cross_rewrite",
            system_prompt=sys_prompt,
            temperature=0.8,
            max_tokens=2400,
            task_ref=ai_client.make_task_ref(
                "cross_rewrite", uid, body.platform, body.source_text, body.extra_hint or "",
            ),
        )
    except Exception as exc:
        # InsufficientCredits 已被全局 handler 处理；其它失败原样回
        logger.warning("[original] rewrite 失败 platform=%s: %s", body.platform, exc)
        raise

    return {
        "platform": body.platform,
        "platform_label": _LABELS[body.platform],
        "result": out.strip(),
        "source_length": len(body.source_text),
        "result_length": len(out.strip()),
    }
