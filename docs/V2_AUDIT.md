# v2 合并后审计（2026-05-17）

> 4 路并行 audit（计费 / Studio / hotnews·toolbox·original / 前端·合并遗留）汇总。
> 结论：v2 功能面铺得很广，但**计费命脉有阻断级缺陷，不可直接上生产**；多个板块"能跑但有明显缺口"。
> 修复优先级：P0 阻断 → P1 体验断裂 → P2 打磨。

## P0 — 阻断项（上生产前必须修）

| # | 板块 | 文件:行 | 问题 | 修复方向 |
|---|---|---|---|---|
| P0-1 | 计费 | `api/services/db.py:414-422` + `billing_service.py:136-190` | SQLite 连接未设 `isolation_level=None`/`busy_timeout`，`BEGIN IMMEDIATE` 写锁/回滚语义不成立；多 worker 真双扣/丢币/对账永久不平 | connect 走 autocommit + 应用显式事务；每连接 `PRAGMA busy_timeout=5000`；`_apply_change` except 显式 ROLLBACK |
| P0-2 | 计费 | `ai_client.py:58` + 所有 call_* 调用方 | 幂等键 `task_ref` 生产路径全是随机 UUID，幂等形同虚设；重试/worker 重投递重复扣费 | 每个调用方传业务稳定键（`comic_panel:{pid}:{panel}` 等）；缺 ref 时 WARNING/拒绝 |
| P0-3 | 计费 | `monitor_db.py:583` vs `billing_service.py:178` vs `ROADMAP_V2.md:29` | `credit_ledger.amount` 符号约定三处矛盾（注释说正数、代码存带符号、对账公式假设正数）；现在平账靠巧合 | 统一为"带符号 delta"，对齐 schema 注释/ROADMAP 公式/测试断言 |
| P0-4 | 计费 | `ai_client.py:560-570` | 图片部分退款 ref=`{_ref}:partial` 不稳定 + refund 无幂等，整操作重试累计多扣；退款额未量化到分 | 部分退款用稳定业务键；refund 也加幂等查重；退款额先 quantize |
| P0-5 | PPT | `ppt.py:989-1004` + `ppt/page.tsx:215-221` | 下载端点要 Bearer header，`<a target=_blank>` 带不了 → 永远 401，渲染好的 .pptx 下不到（整模块致命） | 下载端点接受 `?token=` query 自行 verify；或一次性签名 URL；或 fetch 带 header 取 blob |
| P0-6 | 漫画 | `comic.py:479-482` + `comic.py:123-136` | 未配对象存储时 base64 灌 DB，详情接口一次返几十 MB 卡死前端/撑爆 SQLite | 未配存储直接标 `gen_status='error'` 提示配存储；或详情接口不返 data: URL |
| ✅修复 | 热点雷达 | P0-7 | GitHub Trending 改按 Box-row 容器切 + stargazers 锚定星标，抓 0 → 抓满 25 条。2026-05-17 提交 7d9e3a3 | — |
| ✅修复 | 前端 | P0-8 | 公众号 mp UI 彻底下线：删 app/dashboard/mp/ + GlobalSearch mp 跳转 + profile mp tab/类型；后端保留。2026-05-17 提交 53614fd | — |
| ✅修复 | 计费 | P0-9 | call_edits/call_generations 五处调用方接入计费（bill_edits/refund_edits 助手 + comic_style 单价 + 预扣/整退/部分退/稳定 task_ref）—— 2026-05-17 已修并提交 ef91cc0 | — |
| ✅修复 | 计费 | P0-1/2/3/4 | SQLite 事务锁(connect_tx+busy_timeout+显式 ROLLBACK) / 幂等键(make_task_ref 贯通 call_* + v2 调用方稳定 ref + _bill_charge 缺失 WARNING) / amount 带符号约定对齐 / 部分退款量化+refund 幂等 —— 2026-05-17 已修并提交 6720296（23 测试过）| — |

## P1 — 功能缺失 / 体验断裂

**计费边界**：`price_per_call=0` 配不出免费模型（回退 1）；`monthly_grant`/迁移工具 TOCTOU 可重复发放；`adjust allow_negative` 可把余额打成大负数锁死用户；refund 失败仅 warning 无补偿队列；`feature_pricing` 负值/非法值未校验导致白嫖。

**Studio**：
- 小说：缺世界观/伏笔/卷结构/插重章，章节摘要需手动点（不点续写连贯性退化），long 章静默截断 —— "骨架"=网文专业度不足
- 漫画：`generate-all` 同步串行无异步化（请求挂数分钟无进度）；角色一致性只靠文字、不传 ref 图、不支持图生图，多格人物漂移
- PPT：`fill.transparency` 非法属性被吞 → 封面暗罩实为纯黑盖死底图；产物存系统临时目录被清后下载 404；私有 API 删模板页失败静默产损坏 .pptx
- 旅游：长天数 `max_tokens` 不足易截断 502；无导出/重生成
- 跨模块：模型返 HTTP 200 但内容非法 JSON 不退款，用户白扣点

**hotnews/toolbox/original**：
- 热点雷达："政策""金融"两 Tab 无源永远空；前端 9 源文案造假；新部署最长等 30min 才有数据；`/refresh` 无冷却
- 服务监控：承诺的 TCP 探活未实现（仅 HTTP）；ROADMAP 承诺的"周报"完全缺失；前端无编辑入口、不暴露告警阈值/超时（后端均已支持）
- 一键起号：仅 1 端点无历史/无保存/无批量/同步阻塞，与同项目其它板块体验断层

**前端一致性**：
- 16 个监控/仿写老页未接 v2 `@/components/ui` 原子（PageHeader 等），与新板块页视觉割裂（采用率 24/38）
- text-remix 合并取 main 版缺 PageHeader（同板块 product-remix 已有）—— import 已确认齐全无破坏
- 全局缺 402（余额不足）拦截，AI 扣点失败无统一"去充值"引导
- comic-style 工具页孤儿（无导航入口、无站内链接）
- profile 公众号 tab 与"公众号砍掉"矛盾（同 P0-8）

## P2 — 打磨

死文件 `MyAiModelsCard.tsx`（324 行，应删）；hotnews 文档债（"先接两个源"实际 9 源）；计费缺成功路径 INFO 日志/无每日 reconcile 巡检告警；PG 路径零测试覆盖；text-remix 单文件 1347 行可抽组件；uptime 串行探活可并发化。

## 正向确认（无需动）

- 计费 402 handler（`api/main.py`）、`plans.py` 映射、`billing.py` 入口校验 — 正确
- 计费前端三件套（profile 余额卡 / ModelSelector 标价 / admin 充值后台）前后端对得上
- 旅游板块端到端可用；hotnews 9 源均有真实实现（非空壳）；uptime 飞书告警复用正确
- 合并未破坏 import（`SIZE_OPTIONS`/`mutateAiModels` 等均在）；sections.ts 无死链
- `ai_client` 计费接入健壮（预扣/失败退/部分退/并发信号量/usage 日志）

## 进度（2026-05-17）

**全部 9 个 P0 已修复并提交**：P0-1~4(6720296) · P0-9(ef91cc0) · P0-8(53614fd) ·
P0-5/6(2bd4918) · P0-7(7d9e3a3)。前端 P1 部分：comic-style 入导航 + 删
MyAiModelsCard 死文件(9ef6d23)。本地领先 origin/main 多个提交，未推送。

### 剩余（P1/P2，非阻断）
- **前端 P1**：全局 402「去充值」拦截（AI 扣点失败无引导）；16 个监控/仿写老页未接
  `@/components/ui` PageHeader（视觉割裂，cosmetic）；text-remix 头补 PageHeader
- **Studio P1**：小说补世界观/伏笔/卷/自动摘要；漫画 generate-all 异步化 + 角色 ref 图
  一致性；PPT transparency 纯黑罩 + 产物持久化 + 删模板页健壮性；旅游 max_tokens 动态；
  跨模块「HTTP 200 但内容非法不退款」
- **计费 P1/P2**：price_per_call=0 配不出免费模型；adjust 负值打穿；refund 失败无补偿队列；
  reconcile 无定时巡检告警；PG 路径零测试
- **P2**：hotnews 政策/金融 Tab 空 + 文案造假；uptime 无 TCP/无周报/无编辑入口；
  original 无历史/批量/同步阻塞；文档债
