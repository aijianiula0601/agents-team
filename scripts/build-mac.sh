#!/usr/bin/env bash
# 一键编译 macOS 客户端，生成 .app / .dmg
# 用法：./scripts/build-mac.sh
# 产物：mac-app/dist/Chorus-*.dmg

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MAC_DIR="$ROOT_DIR/mac-app"

echo "------------- build mac dmg --------------"
cd "$MAC_DIR"

if [[ ! -d node_modules ]]; then
  echo "安装依赖…"
  npm install
fi

npm run build

echo "------------- done --------------"
ls -lh "$MAC_DIR"/dist/*.dmg 2>/dev/null || true
echo "安装：打开 mac-app/dist/ 下的 Chorus-*.dmg，拖入「应用程序」。"
