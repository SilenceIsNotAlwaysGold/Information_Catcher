# Pulse CookieBridge

把浏览器登录的小红书 / 抖音 / 公众号 cookie 自动同步到 Pulse 后端，
免去 cookie 失效后手动复制重新录入的痛苦。

## 安装（开发模式）

1. 打开 Chrome → `chrome://extensions`
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」
4. 选择本目录 `web/extensions/cookie-bridge/`

## 配置

点扩展图标弹出 popup，填三项：

| 字段 | 说明 |
|---|---|
| Pulse 后端 API Base | 例如 `http://127.0.0.1:8080`（本地）或线上域名 |
| JWT | 登录 Pulse 后从浏览器控制台 `localStorage.token` 复制 |
| 账号映射 | Pulse「账号管理」里**已存在的同名账号**，三平台分别映射 |

> **重要**：扩展不会自动创建账号。你必须先在 Pulse 后台
> 「账号管理」里新建一个空 cookie 占位账号（platform 选对），
> 名字与扩展里填的映射保持一致。

## 工作机制

- **事件触发**：监听 `chrome.cookies.onChanged`，关键字段（XHS 的 `a1` / `web_session`、抖音的 `sessionid` 等）变化时去抖 5 秒后推送。
- **周期兜底**：每 30 分钟主动同步一次，覆盖事件未触发的边界情况。
- **后端校验**：XHS 必须带 `a1` 字段才接受（签名核心）。

## 后端接口

```
POST /api/monitor/accounts/cookie/sync
Authorization: Bearer <JWT>

{
  "account_name": "博主A",
  "platform": "xhs",
  "cookie": "a1=xxx; web_session=yyy; ...",
  "source": "extension"
}
```

成功后 Pulse 会：
1. 把账号的 cookie 字段覆盖
2. `cookie_status` 置 `valid`
3. 记录 `cookie_synced_at` / `cookie_synced_via='extension'`

## 公众号特殊：自动抓 uin/key/pass_ticket

公众号阅读数 / 在看数走 `mp.weixin.qq.com/mp/getappmsgext`，
需要 `uin / key / pass_ticket` 三个 30 分钟过期的 query 参数。
**不在 cookie 里**，老路径靠用户手动从抓包工具拷贝粘贴。

扩展用 `chrome.webRequest` 监听 `mp.weixin.qq.com/*`，从 URL query 自动
提取 `uin / key / pass_ticket / appmsg_token`，4 字段齐了就推送到后端：

```
PUT /api/auth/me/mp-auth
Authorization: Bearer <JWT>

{ "uin": "xxx", "key": "xxx", "pass_ticket": "xxx", "appmsg_token": "" }
```

**用户操作**：在装了扩展的浏览器里**打开任意一篇公众号文章**（手机分享出来的链接也行），
扩展自动抓字段、推后端，无需任何配置。后端把字段写到 `users.mp_auth_*`，
之后 30 分钟内的监控任务用这个凭证拿真实阅读数。

凭证 30 分钟过期是微信侧的限制（无解），但**只要你一周内开过几次公众号文章**，
扩展会持续刷新，**用户感知里就是"它一直能用"**。
