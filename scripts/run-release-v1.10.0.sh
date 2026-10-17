#!/usr/bin/env bash
# v1.10.0 發版（主對話 #7 備好；分類器擋了自動執行，由使用者一鍵跑）
# 收窄建置並行度：目前認可記憶體 ~90%，之前 97% 被看門狗砍過
export CARGO_BUILD_JOBS=2
cd "$(dirname "$0")/.." || exit 1
exec bash scripts/release.sh 1.10.0 --notes docs/release-notes/v1.10.0.md
