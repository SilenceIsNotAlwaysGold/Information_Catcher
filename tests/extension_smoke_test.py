"""扩展端到端冒烟测试 — 用 Python 模拟扩展角色。

跑法（需要 Pulse 后端先在 8080 端口起来）：
    uv run python extension/_smoke_test.py --token "<your jwt>"

它会：
    1. 用 token 连 ws://127.0.0.1:8080/api/extension/ws
    2. 收到 task → 自动回 ok 结果
    3. 同时 POST /api/extension/dispatch_test 触发服务端派任务
    4. 验证整条链路通畅

不依赖真实浏览器，专门用于 review 后端代码无 bug。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys

import httpx
import websockets


async def fake_extension(server: str, token: str, stop_after: int = 1) -> int:
    """模拟扩展 - 连 ws，收 task，自动回 ok 结果。"""
    ws_url = server.replace("http://", "ws://").replace("https://", "wss://")
    url = f"{ws_url}/api/extension/ws?token={token}"
    print(f"[ext] connecting to {url}")
    handled = 0
    async with websockets.connect(url) as ws:
        # 发 hello
        await ws.send(json.dumps({"type": "hello", "ua": "smoke-test/1.0", "ext_version": "0.0.1"}))
        print("[ext] connected, waiting for tasks...")
        try:
            async for raw in ws:
                msg = json.loads(raw)
                t = msg.get("type")
                if t == "pong":
                    continue
                if t == "task":
                    task = msg["task"]
                    print(f"[ext] received task: {task['type']} payload={task['payload']}")
                    # 模拟执行
                    if task["type"] == "echo":
                        result = {"echoed": task["payload"]}
                        await ws.send(json.dumps({"type": "result", "id": task["id"], "ok": True, "data": result}))
                    elif task["type"] == "fail_test":
                        await ws.send(json.dumps({"type": "result", "id": task["id"], "ok": False, "error": "intentional fail"}))
                    else:
                        await ws.send(json.dumps({"type": "result", "id": task["id"], "ok": False, "error": f"unknown type {task['type']}"}))
                    handled += 1
                    if handled >= stop_after:
                        print(f"[ext] handled {handled} task(s), exit")
                        return 0
        except websockets.ConnectionClosed:
            print("[ext] connection closed")
    return 0


async def call_dispatch(server: str, token: str, body: dict) -> dict:
    """以普通 HTTP 客户端身份触发派任务接口。"""
    async with httpx.AsyncClient() as client:
        r = await client.post(
            f"{server}/api/extension/dispatch_test",
            headers={"Authorization": f"Bearer {token}"},
            json=body,
            timeout=15,
        )
        r.raise_for_status()
        return r.json()


async def login(server: str, username: str, password: str) -> str:
    async with httpx.AsyncClient() as c:
        r = await c.post(
            f"{server}/api/auth/login",
            json={"username": username, "password": password},
            timeout=10,
        )
        r.raise_for_status()
        body = r.json()
        return body.get("access_token") or body["token"]


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", default="http://127.0.0.1:8080")
    ap.add_argument("--token", default="", help="登录 Pulse 拿到的 JWT (留空则用 admin/admin123 自动登录)")
    ap.add_argument("--username", default="admin")
    ap.add_argument("--password", default="admin123")
    args = ap.parse_args()
    if not args.token:
        args.token = await login(args.server, args.username, args.password)
        print(f"[smoke] auto-logged in as {args.username}, token len={len(args.token)}")

    # 起一个后台扩展模拟器
    ext_task = asyncio.create_task(fake_extension(args.server, args.token, stop_after=2))
    await asyncio.sleep(1.5)  # 等连接建立

    # 派一个 echo
    print("\n--- test 1: echo ---")
    r1 = await call_dispatch(args.server, args.token, {"type": "echo", "payload": {"hello": "world"}})
    print(f"[server] dispatch result: {json.dumps(r1, ensure_ascii=False, indent=2)}")
    assert r1.get("ok") is True, "echo dispatch failed"
    assert r1["result"]["echoed"]["hello"] == "world", "echo result mismatch"
    print("✅ echo OK")

    # 派一个故意失败
    print("\n--- test 2: intentional fail ---")
    r2 = await call_dispatch(args.server, args.token, {"type": "fail_test", "payload": {}})
    print(f"[server] dispatch result: {json.dumps(r2, ensure_ascii=False, indent=2)}")
    assert r2.get("ok") is False, "expected ok=False"
    assert "intentional fail" in r2.get("error", ""), "expected error mention"
    print("✅ fail propagation OK")

    await ext_task
    print("\n🎉 SMOKE TEST PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
