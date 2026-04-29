import asyncio
import httpx
import logging
from typing import List, Optional

logger = logging.getLogger(__name__)


async def _call_once(
    base_url: str, api_key: str, model: str, prompt: str, temperature: float,
) -> str:
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 2000,
        "temperature": temperature,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    base = base_url.rstrip("/")
    url = f"{base}/chat/completions"
    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(url, json=payload, headers=headers)
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"].strip()


async def rewrite_content(
    base_url: str,
    api_key: str,
    model: str,
    prompt_template: str,
    content: str,
) -> str:
    """单次改写。维持原签名，向后兼容。"""
    if not api_key or not content:
        raise ValueError("api_key and content are required")
    prompt = prompt_template.replace("{content}", content)
    try:
        return await _call_once(base_url, api_key, model, prompt, 0.8)
    except Exception as e:
        logger.error(f"[ai_rewriter] error: {e}")
        raise


async def rewrite_variants(
    base_url: str,
    api_key: str,
    model: str,
    prompt_template: str,
    content: str,
    n: int = 3,
    temperatures: Optional[List[float]] = None,
) -> List[str]:
    """并行生成 n 个不同温度的变体。

    默认温度梯度：[0.7, 1.0, 1.3, 1.5, 1.7]，前 n 个。
    一个变体失败不影响其他（返回时跳过）。
    """
    if not api_key or not content:
        raise ValueError("api_key and content are required")
    n = max(1, min(int(n), 5))
    prompt = prompt_template.replace("{content}", content)
    temps = temperatures or [0.7, 1.0, 1.3, 1.5, 1.7]
    temps = temps[:n]

    async def _one(t: float):
        try:
            return await _call_once(base_url, api_key, model, prompt, t)
        except Exception as e:
            logger.warning(f"[ai_rewriter] variant t={t} failed: {e}")
            return None

    results = await asyncio.gather(*[_one(t) for t in temps])
    return [r for r in results if r]
