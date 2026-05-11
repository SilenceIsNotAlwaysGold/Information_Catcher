#!/usr/bin/env bash
# 打包浏览器扩展为 api/ui/extension.zip，供 dashboard 「我的浏览器扩展」页面下载。
#
# 用法（项目根目录）：
#   bash scripts/build-extension.sh
#
# 打完后部署到线上服务器：
#   rsync -av api/ui/extension.zip user@server:/path/to/redbook/api/ui/

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT_DIR/extension"
OUT="$ROOT_DIR/api/ui/extension.zip"

if [ ! -f "$SRC/manifest.json" ]; then
  echo "✗ 没找到 $SRC/manifest.json" >&2
  exit 1
fi

VERSION=$(python3 -c "import json; print(json.load(open('$SRC/manifest.json'))['version'])")
echo "→ 打包扩展 v$VERSION ..."

rm -f "$OUT"
mkdir -p "$(dirname "$OUT")"
( cd "$SRC" && zip -rq "$OUT" . -x "*.DS_Store" "_smoke*" "*.smoke*" "README.md" )

SIZE=$(du -h "$OUT" | cut -f1)
echo "✓ 已生成 $OUT ($SIZE)"
echo
echo "下一步部署到服务器："
echo "  rsync -av api/ui/extension.zip user@server:/path/to/redbook/api/ui/"
