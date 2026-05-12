# 第二版路线图（v2-dev 分支）

> 本文档只在 `v2-dev` 分支维护。线上 `main` 分支不动。
> 工作区：`/Users/a1111/Desktop/project/redbook-v2`（git worktree）

## 商业模式

- **基础功能免费**：内容获取 / 监控 / 仿写 / 工具箱 / 热点雷达 等不耗 AI 的功能完全免费
- **AI 功能走平台中转赚钱**：所有 AI 调用强制走 admin 预置的渠道（站长自维护的中转站），按"AI 点数"计费
  - 用户**不能**配自己的 AI key（私有渠道功能砍掉/隐藏）
  - 但用户**可以选模型**：admin 在后台上架多个模型，每个模型**单价不同**，用户调用前自选
  - 免费层每月送少量点数；想多用 → 充值 / 订阅（先 admin 手动充值，后期接支付）

## SaaS 计费系统（命脉，必须零 bug）

### 模型定价（admin 可配）
- `ai_models` 新增字段：
  - `price_per_call` — 每次调用基础点数（按次计价，简单）
  - `feature_pricing` (JSON) — 按 feature 覆盖：`{"ocr": 0.3, "image": 1.0, "comic_panel": 0.5, ...}`，缺省回退 `price_per_call`
  - （可选 v2.1）`price_input_per_1k` / `price_output_per_1k` — 按 token 精确计价
- admin 后台：上架/下架模型、改单价、改 feature 价、改并发上限

### 余额 + 流水（防并发/防错账）
- `user_credits` 表：`user_id (PK), balance NUMERIC(12,2), updated_at`
- `credit_ledger` 表（**每一笔变动都记**）：
  `id, user_id, kind ∈ {recharge|deduct|refund|grant|adjust}, amount NUMERIC(12,2),
   balance_after NUMERIC(12,2), model_id, feature, task_ref, operator, note, created_at`
- **不变量**：`user_credits.balance == SUM(signed amount in credit_ledger)`，任何时刻可对账
  - 对账脚本：`SELECT SUM(CASE WHEN kind IN ('recharge','refund','grant') THEN amount ELSE -amount END) FROM credit_ledger WHERE user_id=?` 必须 == `balance`

### 扣费流程（事务 + 行锁，幂等）
```sql
BEGIN;
  -- 行锁住该用户的余额行，防并发双扣
  SELECT balance FROM user_credits WHERE user_id = $uid FOR UPDATE;
  -- 幂等：同一 task_ref 已扣过就直接返回（不重复扣）
  IF EXISTS(SELECT 1 FROM credit_ledger WHERE task_ref = $ref AND kind='deduct'): COMMIT; RETURN already;
  -- 余额不足：回滚 + 报错（调用方不发起 AI 请求）
  IF balance < $cost: ROLLBACK; RAISE '余额不足';
  UPDATE user_credits SET balance = balance - $cost, updated_at = NOW() WHERE user_id = $uid;
  INSERT INTO credit_ledger(user_id, kind, amount, balance_after, model_id, feature, task_ref)
    VALUES($uid, 'deduct', $cost, balance - $cost, $mid, $feat, $ref);
COMMIT;
```
- AI 调用**失败 → 退款**：`INSERT credit_ledger kind='refund' amount=$cost ... + UPDATE balance += $cost`（同样事务+锁）
- 流式调用（如对话）：先按预估上限扣，结束后按实际用量退差额
- 充值：`kind='recharge'`（admin 手动）/ `kind='grant'`（系统每月免费额度）/ `kind='adjust'`（admin 手动纠错，必须填 note）

### 配额 vs 点数
- **方案 A（先做）**：废弃旧的 `total_image_gen` / `daily_text_gen` 双轨配额，全部统一为点数。
  - plan 决定每月 `grant` 多少点（trial 送 N、free 送 M、pro 不送但买便宜……）
  - 每月 1 号 cron：给每个用户 `grant` 当月免费额度（不累计，超期清零或保留视策略）
- 方案 B（后期可选）：免费额度（每月重置）+ 充值点数（不重置）双余额，先扣免费再扣充值

### 用户侧 UI
- 个人中心：当前余额 + 流水明细分页 + 当前各模型单价表
- AI 调用前余额不足 → 友好弹窗"余额不足，剩 X 点，本次需 Y 点，去充值"
- admin 后台：用户列表 → 充值/调整 + 看每个用户的流水

### 模型切换 UI
- 现有 `ModelSelector` 组件加单价标注：每个选项后面显示 "(0.3 点/次)"
- 默认选 admin 标的 `is_default` 模型；用户可改偏好

## 四大板块

### 板块 1：内容雷达（Content Radar）— 现有，做平台扩展
- 保留：小红书、抖音 的「获取 / 监控 / 仿写」
- **砍公众号**：深化 ROI 太低，代码保留不删，UI 下架
- 后期加平台：B站 > 快手（B站 API 友好、内容深）；每个新平台约 2-3 天（含浏览器扩展端抓取脚本）

### 板块 2：AI 创作工坊（AI Studio）— 第二版重点
| 子模块 | 状态 | 参考 | 工作量 |
|---|---|---|---|
| AI 生图 / 整体仿写 / 文案换背景 | 已上线 | — | — |
| AI 漫画（独立）| TODO | [LoreVista](https://github.com/libohan-ha/-LoreVista)（栈一致：对话→分镜→生图）| 3-5 天 |
| AI 小说（独立）| TODO | [NovelMaker](https://github.com/SilenceIsNotAlwaysGold/NovelMaker)（专业网文：卷/章/角色卡/世界观/伏笔/工作流）| 5-7 天 |
| AI 旅游攻略 | TODO | 纯 LLM + 模板 | 2-3 天 |
| AI PPT（生成 + 上传改造）| TODO | python-pptx / PPTAgent；支持上传 .pptx 按指令改 | 7-10 天 |
| AI 视频 | TODO | 可灵 / SVD API | 高，最后 |

- 小说与漫画可联动：小说写完 → 一键转漫画分镜
- 全部 AI 调用走 `ai_client.call_*`，强制平台 key + 扣点数

### 板块 3：实用工具箱（Toolbox）
| 工具 | 参考 | 工作量 |
|---|---|---|
| 服务监控告警 + 周报 | uptime-kuma（HTTP/TCP 探活 + 告警），复用现有飞书推送 | 2-3 天 |
| 文档转换 | gotenberg（Office↔PDF、HTML→PDF），起 docker + 包 API | 2 天 |
| AI 音乐生成 | ace-step-ui，起 ace-step 服务 + 包 API（走 AI 配额）| 3-4 天 |

### 板块 4：热点雷达（Hot Topics）
- 分类聚合：**Code**（GitHub Trending）/ **政策** / **娱乐** / **金融**
- 基座：[newsnow](https://github.com/ourongxing/newsnow)（~30 源，分类清晰），抄源列表 + 抓取器，套我们 UI
- 风险：实时性靠各站榜单 API，质量参差 → 先搭骨架，源不够后期补；不是 P0
- 工作量：3-4 天

## 工程约定（不影响线上）

1. 第二版全部在 `v2-dev` 分支 / `redbook-v2` worktree 开发，线上 `main` 永不动
2. 新功能 = 新 router 模块（`api/routers/studio/` `api/routers/toolbox/` `api/routers/hotnews/`）+ 新 DB 表（不碰 `monitor_posts` 等现有表）+ 前端新页面（`web/src/app/dashboard/studio/...`）
3. 本地跑：`uv run uvicorn api.main:app --port 8090 --reload` + `cd web && npm run dev`
4. 每个板块稳定一个就可以单独 cherry-pick 回 `main` + 部署，不必一次性合并

## 执行顺序

| # | 任务 | 工作量 | 状态 |
|---|---|---|---|
| 0 | **SaaS 计费系统**：模型定价 + user_credits/credit_ledger + 扣费事务 + 砍用户私有渠道 + admin 充值后台 + 用户余额 UI | 4-6 天 | 进行中 |
| 1 | AI 漫画（LoreVista 思路，接入计费）| 3-5 天 | |
| 2 | AI 小说（NovelMaker 思路，接入计费）| 5-7 天 | |
| 3 | 服务监控 + 周报 | 2-3 天 | |
| 4 | 热点雷达骨架 | 3-4 天 | |
| 5 | AI 旅游攻略 | 2-3 天 | |
| 6 | 砍公众号 UI、B站平台、AI PPT（生成+上传改造）、文档转换、AI 音乐、AI 视频、后期接支付 | — | |
