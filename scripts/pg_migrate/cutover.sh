#!/usr/bin/env bash
# Pulse sqlite → PG 一键迁移流程
#
# 在 sandbox 库 redbook_test 上演练；确认无误后人工修改 PULSE_PG_DB=redbook 复跑。
# 默认不重启远程服务，最后一步只打印重启命令让人确认。
#
# 用法：
#   bash scripts/pg_migrate/cutover.sh             # 真跑（仍只动 redbook_test）
#   bash scripts/pg_migrate/cutover.sh --dry-run   # 不动 PG，只跑前置验证步骤
#
# 关键环境变量（默认值见下）：
#   REMOTE_USER=root  REMOTE_HOST=117.72.161.176  REMOTE_PASS=XLJmima1024
#   REMOTE_DIR=/opt/redbook
#   PG_HOST=127.0.0.1  PG_USER=redbook  PG_PASS=redbook_pulse_2026
#   PG_DB=redbook_test   ← 默认演练库，确认后人工改成 redbook
#
set -euo pipefail
IFS=$'\n\t'

# ── 参数解析 ───────────────────────────────────────────────────────────────
DRY_RUN=0
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        -h|--help)
            sed -n '2,20p' "$0"; exit 0 ;;
        *) echo "未知参数: $arg"; exit 1 ;;
    esac
done

# ── 配置 ───────────────────────────────────────────────────────────────────
REMOTE_USER="${REMOTE_USER:-root}"
REMOTE_HOST="${REMOTE_HOST:-117.72.161.176}"
REMOTE_PASS="${REMOTE_PASS:-XLJmima1024}"
REMOTE_DIR="${REMOTE_DIR:-/opt/redbook}"

PG_HOST="${PG_HOST:-127.0.0.1}"
PG_USER="${PG_USER:-redbook}"
PG_PASS="${PG_PASS:-redbook_pulse_2026}"
PG_DB="${PG_DB:-redbook_test}"

# 本地路径
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJ_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOCAL_TMP="$PROJ_ROOT/scripts/pg_migrate/_tmp_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$LOCAL_TMP"

# ── 工具函数 ───────────────────────────────────────────────────────────────
SSH() { sshpass -p "$REMOTE_PASS" ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 "$REMOTE_USER@$REMOTE_HOST" "$@"; }
SCP_FROM() { sshpass -p "$REMOTE_PASS" scp -o StrictHostKeyChecking=no "$REMOTE_USER@$REMOTE_HOST:$1" "$2"; }
SCP_TO()   { sshpass -p "$REMOTE_PASS" scp -o StrictHostKeyChecking=no "$1" "$REMOTE_USER@$REMOTE_HOST:$2"; }

PG_REMOTE() {
    # 在远端执行 psql；arg 为 SQL 字符串
    SSH "PGPASSWORD=$PG_PASS psql -U $PG_USER -h $PG_HOST -d $PG_DB -tA -c \"$1\""
}

step() { echo; echo "========== [$1] $2 =========="; }
ok()   { echo "  [OK] $*"; }
die()  { echo "  [FAIL] $*" >&2; exit 1; }

trap 'echo; echo "[ABORT] 失败于上一步，临时文件保留：$LOCAL_TMP"' ERR

echo "========================================================"
echo " Pulse PG cutover"
echo "   远端：$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR"
echo "   目标 PG：$PG_USER@$PG_HOST/$PG_DB"
echo "   本地临时目录：$LOCAL_TMP"
echo "   DRY_RUN=$DRY_RUN"
echo "========================================================"

if [[ "$PG_DB" == "redbook" ]]; then
    echo
    echo "[WARN] PG_DB=redbook —— 这是生产库！"
    echo "       脚本会清空它并重新导入。确认请输入 'yes I really mean redbook'："
    read -r confirm
    [[ "$confirm" == "yes I really mean redbook" ]] || die "未确认，退出"
fi

# ── 步骤 1：copy sqlite 到本地 ─────────────────────────────────────────────
step 1 "复制远端 sqlite → 本地临时目录"
# 用 scp 而非 rsync（mac 自带的老版 rsync 不支持多源 SSH）
SCP_FROM "$REMOTE_DIR/database/monitor.db" "$LOCAL_TMP/monitor.db" || die "scp monitor.db 失败"
SCP_FROM "$REMOTE_DIR/database/users.db" "$LOCAL_TMP/users.db" || die "scp users.db 失败"
ls -lh "$LOCAL_TMP/"*.db
ok "本地副本就绪"

# ── 步骤 2：远端基于线上 sqlite 副本跑 dump ───────────────────────────────
step 2 "远端跑 dump_sqlite.py（数据 + schema 备份）"
# 在远端复制一份 sqlite 到 /tmp（避免线上 sqlite WAL 干扰）
SSH "mkdir -p /tmp/pulse_dump_src && cp $REMOTE_DIR/database/monitor.db /tmp/pulse_dump_src/ && cp $REMOTE_DIR/database/users.db /tmp/pulse_dump_src/"
# 调用 dump（schema + data 都生成；--data-only 推荐方案 X 用，但全量生成更安全）
SSH "cd $REMOTE_DIR && .venv/bin/python -m scripts.pg_migrate.dump_sqlite --db-dir /tmp/pulse_dump_src"
ok "dump 完成"

# ── 步骤 3：scp 结果回本地，供人工审阅 ──────────────────────────────────────
step 3 "scp dump 结果回本地"
mkdir -p "$LOCAL_TMP/dump_out"
sshpass -p "$REMOTE_PASS" scp -r -o StrictHostKeyChecking=no \
    "$REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR/scripts/pg_migrate/out/." "$LOCAL_TMP/dump_out/" \
    || die "scp 失败"
ls -lh "$LOCAL_TMP/dump_out/"
ok "本地 dump 副本：$LOCAL_TMP/dump_out/"

if [[ "$DRY_RUN" == "1" ]]; then
    echo
    echo "[DRY-RUN] 后续步骤（清空 PG / 导入 / 校验）已跳过。"
    echo "         dump 已生成，可人工 less $LOCAL_TMP/dump_out/data_monitor.sql 审阅。"
    exit 0
fi

# ── 步骤 4：清空 PG 目标库的全部 public 表 ──────────────────────────────────
step 4 "清空 PG $PG_DB（DROP ALL TABLES）"
# 通过查 information_schema 拼一条 DROP TABLE ... CASCADE
DROP_SQL=$(SSH "PGPASSWORD=$PG_PASS psql -U $PG_USER -h $PG_HOST -d $PG_DB -tA -c \"SELECT string_agg('DROP TABLE IF EXISTS \\\"' || tablename || '\\\" CASCADE;', ' ') FROM pg_tables WHERE schemaname='public'\"")
if [[ -n "$DROP_SQL" && "$DROP_SQL" != " " ]]; then
    SSH "PGPASSWORD=$PG_PASS psql -U $PG_USER -h $PG_HOST -d $PG_DB -c \"$DROP_SQL\"" > /dev/null
    ok "已 DROP 所有 public 表"
else
    ok "PG $PG_DB 已是空库，无需 DROP"
fi

# ── 步骤 5：远端跑 init_db() 在 PG 上建 schema（方案 X）──────────────────
step 5 "远端跑 init_db() 在 PG 上自动建 schema"
SSH "cd $REMOTE_DIR && PULSE_DB_DRIVER=pg PULSE_PG_DB=$PG_DB .venv/bin/python -c \"import asyncio; from api.services.monitor_db import init_db; asyncio.run(init_db())\""
TBL_COUNT=$(PG_REMOTE "SELECT count(*) FROM pg_tables WHERE schemaname='public'")
echo "  PG $PG_DB 表数：$TBL_COUNT"
[[ "$TBL_COUNT" -ge 28 ]] || die "init_db 后表数 < 28，疑似建表不全"
ok "schema 就绪"

# ── 步骤 6：远端导入 data SQL ───────────────────────────────────────────────
step 6 "导入 data_monitor.sql 到 PG $PG_DB"
# 用 postgres 超级用户跑 —— data SQL 里 SET session_replication_role=replica
# 需要 superuser 权限；普通业务用户 (redbook) 拿不到这个权限。
SSH "sudo -u postgres psql -d $PG_DB -v ON_ERROR_STOP=1 -f $REMOTE_DIR/scripts/pg_migrate/out/data_monitor.sql" 2>&1 | tail -20
ok "data_monitor 导入完成"

# users.db 数据是否要导：检查 PG 现有 users 表
USERS_EXISTS=$(PG_REMOTE "SELECT count(*) FROM pg_tables WHERE tablename='users' AND schemaname='public'")
if [[ "$USERS_EXISTS" == "1" ]]; then
    echo "  PG 已有 users 表，导入 users 数据"
    SSH "sudo -u postgres psql -d $PG_DB -v ON_ERROR_STOP=1 -f $REMOTE_DIR/scripts/pg_migrate/out/data_users.sql" 2>&1 | tail -10 || echo "  [WARN] users 数据导入失败（可能 schema 差异），手动核对"
else
    echo "  [WARN] PG 无 users 表（auth_service.init_user_db 还未改造），跳过 users 数据导入"
    echo "         需要先在 PG 上手工建 users 表，或改造 auth_service 走适配层"
fi

# ── 步骤 7：行数校验 ───────────────────────────────────────────────────────
step 7 "行数校验：sqlite vs PG"
"$PROJ_ROOT/.venv/bin/python" "$SCRIPT_DIR/cutover_verify.py" \
    --sqlite "$LOCAL_TMP/monitor.db" \
    --counts-tsv "$LOCAL_TMP/dump_out/counts_monitor.tsv" \
    --pg-host "$REMOTE_HOST" \
    --pg-port 5432 \
    --pg-user "$PG_USER" \
    --pg-pass "$PG_PASS" \
    --pg-db "$PG_DB" \
    --remote-user "$REMOTE_USER" \
    --remote-pass "$REMOTE_PASS"

# ── 步骤 8：提示手动重启 ───────────────────────────────────────────────────
step 8 "完成。下一步（不自动执行）"
cat <<EOF

  cutover 主流程跑完。如果行数 / 业务校验都 OK，按以下步骤切换：

  1) 在远端 $REMOTE_DIR/.env (或 systemd EnvironmentFile) 设置：
       PULSE_DB_DRIVER=pg
       PULSE_PG_HOST=127.0.0.1
       PULSE_PG_DB=redbook          ← 注意：演练完后改成生产库 redbook
       PULSE_PG_USER=redbook
       PULSE_PG_PASS=redbook_pulse_2026

  2) 重启服务（在远端跑）：
       systemctl restart pulse        # 或你实际的服务名
       systemctl status  pulse

  3) 观察日志 + 业务巡检：
       tail -f $REMOTE_DIR/logs/*.log
       curl -s http://127.0.0.1:8080/api/health

  本地临时文件保留在： $LOCAL_TMP
EOF
