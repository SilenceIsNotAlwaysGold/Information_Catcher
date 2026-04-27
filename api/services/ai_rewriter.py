import httpx
import logging

logger = logging.getLogger(__name__)


async def rewrite_content(
    base_url: str,
    api_key: str,
    model: str,
    prompt_template: str,
    content: str,
) -> str:
    """Call an OpenAI-compatible API to rewrite content. Returns rewritten text."""
    if not api_key or not content:
        raise ValueError("api_key and content are required")

    prompt = prompt_template.replace("{content}", content)
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 2000,
        "temperature": 0.8,
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    base = base_url.rstrip("/")
    url = f"{base}/chat/completions"

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(url, json=payload, headers=headers)
            resp.raise_for_status()
            data = resp.json()
            return data["choices"][0]["message"]["content"].strip()
    except Exception as e:
        logger.error(f"[ai_rewriter] error: {e}")
        raise
