# Pulse Helper（浏览器扩展）

让 Pulse 服务端通过你已登录的浏览器执行小红书 / 抖音搜索与博主追新任务，规避封号风险。

## 安装（开发模式）

1. 打开 Chrome / Edge，地址栏输入 `chrome://extensions`
2. 右上角开启「**开发者模式**」
3. 点击「**加载已解压的扩展程序**」
4. 选择本目录 `extension/`
5. 扩展栏会出现 Pulse Helper 蓝色图标 — 点开 popup

## 配置

popup 里填两项：

- **服务器地址**：本地开发填 `http://127.0.0.1:8080`，线上填你的 Pulse 域名（注意末尾不要带 `/`）
- **Token**：登录 Pulse → 浏览器 F12 → Application → Local Storage → `http://127.0.0.1:8080`（或你的域名）→ 复制 `token` 字段的值（一长串 base64.hash 格式）

点「保存并连接」，状态点变绿即握手成功。

## 验证最短链路（P1.4）

启动 Pulse 后端：

```bash
API_ONLY=1 uv run uvicorn api.main:app --port 8080 --reload
```

> ⚠️ 注意端口：扩展 popup 里填的服务器地址端口必须和这里启动的端口一致。如果你用 `--port 8080`，popup 就填 `http://127.0.0.1:8080`。

popup 连接成功后，在终端发一个测试任务：

```bash
TOKEN="<你登录后的 JWT>"

# echo 测试
curl -s -X POST http://127.0.0.1:8080/api/extension/dispatch_test \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"echo","payload":{"hello":"world"}}' | jq

# 桌面通知测试
curl -s -X POST http://127.0.0.1:8080/api/extension/dispatch_test \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"type":"ping_browser","payload":{"message":"Pulse 链路通了"}}' | jq
```

预期：
- `echo` 任务返回 `{"ok":true,"result":{"echoed":{"hello":"world"}}}`
- `ping_browser` 在桌面右下角弹出系统通知 "Pulse 链路通了"
- popup 「最近任务」列表里能看到 done 状态的记录

## 排错

- **状态点是灰色 / 红色**
  - 检查服务器地址末尾不要有 `/`
  - 检查 Pulse 后端是否在跑（`curl http://127.0.0.1:8080/api/health`）
  - 看 service worker 日志：`chrome://extensions` → Pulse Helper → 点「Service Worker」→ 控制台

- **dispatch_test 返回 503 no online extension**
  - popup 状态点必须是绿的才会被注册到 registry
  - 重连一下（popup 「重连」按钮）

- **任务超时**
  - background.js console 看 `[pulse] task ...` 日志
  - 默认超时 30s，复杂任务可在 dispatch_test body 加 `"timeout": 60`

## 状态查询

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8080/api/extension/status | jq
```

返回当前用户的所有在线扩展实例（同账号在多个浏览器登录会有多个）。

## 验证 P2: XHS 关键词搜索 + 入库

确保扩展状态点是绿的，然后：

```bash
# 触发一次搜索任务，自动落库到 trending_posts
curl -X POST http://127.0.0.1:8080/api/extension/run_xhs_search \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"keyword":"淘宝好物","min_likes":1000,"timeout_ms":25000,"pages":2}' | jq
```

发生什么：
1. 后端通过 ws 把 task 发给扩展
2. 扩展开一个**非活动 tab**（不抢焦点）→ 注入 page_hook + content/xhs.js
3. tab 跳到 `xiaohongshu.com/search_result?keyword=...`
4. hook 在 React 应用发 `/api/sns/web/v1/search/notes` 时拦截 JSON 响应
5. 滚动 2 次触发懒加载
6. 25s 内拿到笔记列表，关 tab，回传服务器
7. 服务器写入 `trending_posts` 表

预期返回：
```json
{"ok":true, "captured":36, "inserted":12, "updated":24, "raw_hits":3}
```

实测时关注：
- 浏览器右上角扩展图标，能看到一个临时 tab 闪现（搜索页加载完后自动关闭）
- 如果浏览器**没登录**小红书，搜索结果可能为空或缩水
- 如果**没登录**情况下 hook 拦不到任何响应（小红书搜索 API 强校验 cookie），返回 `captured:0`
- 现在登录态来自你的真实浏览器 cookie，**不会触发风控**（你正常用的浏览器、正常的家庭 IP）

## 验证 P2 排错

- **`captured:0`**：浏览器没登录小红书，或者小红书页面没成功加载。手动打开 `https://www.xiaohongshu.com/search_result?keyword=test` 看能不能正常出搜索结果
- **后端控制台报 `task ... timeout`**：扩展内部任务超时，看 service worker 控制台 (`chrome://extensions` → Pulse Helper → Service Worker)
- **`/api/sns/web/v1/search/notes` 没被命中**：可能小红书改 API 路径了，看 service worker 控制台里 `[pulse-content]` 日志，对照真实抓包

