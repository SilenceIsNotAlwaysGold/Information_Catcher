#!/usr/bin/env bash
# Pulse / Redbook 一键部署到生产服务器。
#
# 用法：
#   ./deploy.sh             # 同步全部（默认）
#   ./deploy.sh backend     # 只同步后端 .py + pyproject
#   ./deploy.sh frontend    # 只同步 api/ui/（前端 build 产物）
#   ./deploy.sh restart     # 只重启 service
#   ./deploy.sh logs        # 跟踪远端日志
#   ./deploy.sh status      # 查看远端 service 状态
#
# 前置要求：
#   - 本机 sshpass 已装：brew install hudochenkov/sshpass/sshpass
#   - 远端 117.72.161.176 root 密码在环境变量 PULSE_DEPLOY_PASSWORD 或写在 .deploy.env
#
# .deploy.env 示例（与本脚本同目录，已加入 .gitignore）：
#   PULSE_DEPLOY_HOST=117.72.161.176
#   PULSE_DEPLOY_USER=root
#   PULSE_DEPLOY_PASSWORD=xxxxxxxx
#   PULSE_DEPLOY_PATH=/opt/redbook
#   PULSE_DEPLOY_SERVICE=redbook

set -euo pipefail

cd "$(dirname "$0")"

# ── 加载配置 ───────────────────────────────────────────────────────────────
if [[ -f .deploy.env ]]; then
  # shellcheck disable=SC1091
  source .deploy.env
fi
HOST="${PULSE_DEPLOY_HOST:-117.72.161.176}"
USER="${PULSE_DEPLOY_USER:-root}"
PASSWORD="${PULSE_DEPLOY_PASSWORD:-}"
TARGET_PATH="${PULSE_DEPLOY_PATH:-/opt/redbook}"
SERVICE="${PULSE_DEPLOY_SERVICE:-redbook}"

if [[ -z "$PASSWORD" ]]; then
  echo "✗ 缺少远端 root 密码。设置 PULSE_DEPLOY_PASSWORD 环境变量 或 创建 .deploy.env。" >&2
  exit 1
fi
if ! command -v sshpass >/dev/null; then
  echo "✗ 缺少 sshpass。安装：brew install hudochenkov/sshpass/sshpass" >&2
  exit 1
fi

SSH_OPTS=(-o StrictHostKeyChecking=no -o ConnectTimeout=10)
SSH="sshpass -p $PASSWORD ssh ${SSH_OPTS[*]} ${USER}@${HOST}"
RSYNC="sshpass -p $PASSWORD rsync -avzR --no-perms --no-times --omit-dir-times -e 'ssh ${SSH_OPTS[*]}'"

# ── 后端要同步的关键文件清单（相对路径，rsync -R 保结构） ─────────────────
BACKEND_FILES=(
  api/main.py
  api/routers/__init__.py
  api/routers/monitor.py
  api/routers/archive.py
  api/routers/creator_stats.py
  api/routers/extension.py
  api/routers/image_gen/__init__.py
  api/routers/image_gen/remix.py
  api/routers/image_gen/product.py
  api/routers/image_gen/text_remix.py
  api/routers/image_gen/_common.py
  api/services/ai_client.py
  api/services/audit_service.py
  api/services/extension_dispatcher.py
  api/services/quota_service.py
  api/services/plans.py
  api/services/invite_service.py
  api/schemas/monitor.py
  api/services/scheduler.py
  api/services/monitor_db.py
  api/services/notifier.py
  api/services/storage.py
  api/services/s3_uploader.py
  api/services/qiniu_uploader.py
  api/services/local_storage.py
  api/services/media_archiver.py
  api/services/trending_fetcher.py
  api/services/monitor_fetcher.py
  api/services/account_browser.py
  api/services/cookie_health.py
  api/services/auth_service.py
  api/services/remix_worker.py
  api/services/text_remix_worker.py
  api/services/image_upload_worker.py
  api/services/proxy_forwarder.py
  api/services/platforms/__init__.py
  api/services/platforms/base.py
  api/services/platforms/_ua_pool.py
  api/services/platforms/xhs/__init__.py
  api/services/platforms/xhs/sign_service.py
  api/services/platforms/xhs/fetcher.py
  api/services/platforms/xhs/creator_dashboard_fetcher.py
  api/services/platforms/douyin/__init__.py
  api/services/platforms/douyin/fetcher.py
  api/services/platforms/douyin/live_fetcher.py
  api/services/platforms/douyin/trendinsight_fetcher.py
  api/services/platforms/mp/__init__.py
  api/services/platforms/mp/fetcher.py
  pyproject.toml
)

# ── 命令实现 ───────────────────────────────────────────────────────────────

deploy_backend() {
  echo "▶ 同步后端 (${#BACKEND_FILES[@]} files)..."
  local existing=()
  for f in "${BACKEND_FILES[@]}"; do
    [[ -f "$f" ]] && existing+=("$f")
  done
  eval "$RSYNC ${existing[*]} ${USER}@${HOST}:${TARGET_PATH}/" | tail -8
  echo "▶ 检查/安装新依赖（boto3 等）..."
  $SSH "${TARGET_PATH}/.venv/bin/pip install -q -e ${TARGET_PATH} 2>&1 | tail -3 || true"
  echo "✓ 后端同步完成"
}

deploy_frontend() {
  echo "▶ 同步前端 (api/ui/)..."
  if [[ ! -d api/ui ]]; then
    echo "✗ api/ui/ 不存在。请先 cd web && npm run build" >&2
    return 1
  fi
  sshpass -p "$PASSWORD" rsync -avz --delete --no-perms --no-times --omit-dir-times \
    -e "ssh ${SSH_OPTS[*]}" \
    api/ui/ "${USER}@${HOST}:${TARGET_PATH}/api/ui/" | tail -6
  echo "✓ 前端同步完成"
}

deploy_extension() {
  echo "▶ 同步浏览器扩展源码..."
  if [[ ! -d extension ]]; then
    echo "（无 extension/，跳过）"
    return 0
  fi
  $SSH "mkdir -p ${TARGET_PATH}/extension" || true
  sshpass -p "$PASSWORD" rsync -avz --no-perms --no-times --omit-dir-times \
    -e "ssh ${SSH_OPTS[*]}" \
    extension/ "${USER}@${HOST}:${TARGET_PATH}/extension/" | tail -6
  echo "✓ 扩展同步完成（服务端 /api/extension/version 会读 extension/manifest.json）"
}

restart_service() {
  echo "▶ 重启 ${SERVICE} service..."
  $SSH "systemctl restart ${SERVICE} && sleep 3 && systemctl is-active ${SERVICE}"
  echo "▶ 健康检查..."
  $SSH "curl -sk https://localhost:8003/api/health --max-time 5 || curl -s http://localhost:8003/api/health --max-time 5" | head -c 200
  echo
}

show_logs() {
  $SSH "journalctl -u ${SERVICE} -f --no-pager"
}

show_status() {
  $SSH "systemctl status ${SERVICE} --no-pager | head -20"
}

# ── 入口 ───────────────────────────────────────────────────────────────────
cmd="${1:-all}"
case "$cmd" in
  backend)  deploy_backend; restart_service ;;
  frontend) deploy_frontend ;;
  extension) deploy_extension ;;
  restart)  restart_service ;;
  logs)     show_logs ;;
  status)   show_status ;;
  all|"")
    deploy_backend
    deploy_frontend
    deploy_extension
    restart_service
    ;;
  *)
    echo "未知命令: $cmd" >&2
    sed -n '/^# 用法/,/^# 前置/p' "$0" | sed 's/^# \?//'
    exit 1
    ;;
esac

# ── 备选模式：将来切到 git pull ────────────────────────────────────────────
# 如果你后续把代码都 push 到 GitHub，并在远端 /opt/redbook 做：
#   git init && git remote add origin <repo> && git fetch && git reset --hard origin/main
# 那么 deploy_backend 可改为：
#   $SSH "cd ${TARGET_PATH} && git fetch origin && git reset --hard origin/main && \
#         .venv/bin/pip install -q -e . && true"
# rsync 模式保留为离线兜底。
