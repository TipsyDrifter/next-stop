#!/usr/bin/env bash
#
# mirror-publish.sh — 把私有開發 repo（next-stop-dev）的「程式碼＋說明文件」發到公開鏡像 repo（next-stop）。
#
# 為什麼要有鏡像（主人 2026-09-21 拍板）：決策記錄、心得雷區、研究報告、原型、素材是開發過程，不公開；
#   程式碼、安裝包、README 這類說明文件才公開。鏡像**沒有開發歷史**——每次發布都是把當前內容整包
#   覆蓋成一顆 squash commit（歷史裡不會殘留曾經 commit 過的 docs/）。
#
# 用法：
#   bash scripts/mirror-publish.sh                              # 只推程式碼（commit 訊息＝私有 repo 的 HEAD 短 hash＋標題）
#   bash scripts/mirror-publish.sh --tag v1.2.0                 # 推程式碼＋在鏡像打 tag
#   bash scripts/mirror-publish.sh --tag v1.2.0 --release --notes docs/release-notes/v1.2.0.md
#                                                               # 再把 dist/NextStop_1.2.0_* 兩檔發成鏡像的 GitHub Release
#   --dry-run：只印不做。
#
# 公開名單（白名單思維——沒列的一律不出去）：
#   根目錄檔：README.md LICENSE package.json pnpm-lock.yaml pnpm-workspace.yaml index.html vite.config.ts tsconfig*.json .gitignore .gitattributes
#   目錄：src/ src-tauri/ public/ scripts/（排除 scripts/probes/）docs/images/ docs/release-notes/ docs/發版流程.md
#   不出去：docs/ 其餘、files/、prototypes/、.claude/、.vscode/、scripts/probes/、.sync/
set -euo pipefail

MIRROR_REPO="${MIRROR_REPO:-TipsyDrifter/next-stop}"
TAG=""; DO_RELEASE=0; NOTES=""; DRY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TAG="$2"; shift 2;;
    --release) DO_RELEASE=1; shift;;
    --notes) NOTES="$2"; shift 2;;
    --dry-run) DRY=1; shift;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
[[ -z "$(git status --porcelain)" ]] || { echo "✗ 工作樹不乾淨，先 commit 或 stash。" >&2; exit 1; }
HEAD_SHORT="$(git rev-parse --short HEAD)"
HEAD_SUBJ="$(git log -1 --pretty=%s)"

WHITELIST_FILES=(README.md LICENSE package.json pnpm-lock.yaml pnpm-workspace.yaml index.html vite.config.ts tsconfig.json tsconfig.node.json .gitignore .gitattributes)
WHITELIST_DIRS=(src src-tauri public scripts docs/images docs/release-notes)
WHITELIST_EXTRA=("docs/發版流程.md")
EXCLUDE_INSIDE=(scripts/probes src-tauri/gen/android/app/build src-tauri/target)

say() { printf '  %s\n' "$1"; }
run() { if [[ $DRY -eq 1 ]]; then say "\$ $*"; else "$@"; fi; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
EXPORT="$WORK/export"; MIR="$WORK/mirror"
mkdir -p "$EXPORT"

echo "▸ ① 從私有 repo HEAD（$HEAD_SHORT）匯出白名單"
git archive --format=tar HEAD | tar -x -C "$EXPORT"
STAGE="$WORK/stage"; mkdir -p "$STAGE"
for f in "${WHITELIST_FILES[@]}" "${WHITELIST_EXTRA[@]}"; do
  [[ -f "$EXPORT/$f" ]] && { mkdir -p "$STAGE/$(dirname "$f")"; cp "$EXPORT/$f" "$STAGE/$f"; }
done
for d in "${WHITELIST_DIRS[@]}"; do
  [[ -d "$EXPORT/$d" ]] && { mkdir -p "$STAGE/$d"; cp -r "$EXPORT/$d/." "$STAGE/$d/"; }
done
for x in "${EXCLUDE_INSIDE[@]}"; do rm -rf "$STAGE/$x"; done
# 安全網：鏡像裡的 markdown 不得連到私有文件（r2.env／keystore.properties 只是路徑說明，不算；那兩個檔本來就不在白名單）
if grep -rIl -E "決策記錄\.md|心得與雷區|點子與意見簿|專案進度表|開發路線圖|docs/research/" "$STAGE" --include='*.md' 2>/dev/null; then
  echo "✗ 白名單內出現私有文件的引用，先清掉再發。" >&2; exit 1
fi
say "匯出 $(find "$STAGE" -type f | wc -l) 個檔案"

echo "▸ ② 取鏡像 repo、整包覆蓋、squash commit"
if [[ $DRY -eq 1 ]]; then
  say "\$ git clone https://github.com/$MIRROR_REPO.git $MIR && 覆蓋 && git commit"
else
  if ! git clone -q "https://github.com/$MIRROR_REPO.git" "$MIR" 2>/dev/null; then
    mkdir -p "$MIR"; (cd "$MIR" && git init -q -b main && git remote add origin "https://github.com/$MIRROR_REPO.git")
  fi
  (cd "$MIR" && git checkout -q -B main 2>/dev/null || true)
  find "$MIR" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
  cp -r "$STAGE/." "$MIR/"
  (cd "$MIR" && git add -A && git -c user.name="Kosa" -c user.email="kosa@users.noreply.github.com" commit -q -m "${TAG:+$TAG — }$HEAD_SUBJ (dev@$HEAD_SHORT)" || true)
fi

echo "▸ ③ push main${TAG:+ ＋ tag $TAG}"
if [[ $DRY -eq 0 ]]; then
  (cd "$MIR" && { [[ -z "$TAG" ]] || git tag -f "$TAG"; } && git push -q -u origin main && { [[ -z "$TAG" ]] || git push -q -f origin "$TAG"; })
else
  say "\$ git push origin main${TAG:+ $TAG}"
fi

if [[ $DO_RELEASE -eq 1 ]]; then
  [[ -n "$TAG" ]] || { echo "✗ --release 需要 --tag" >&2; exit 1; }
  V="${TAG#v}"
  ASSETS=()
  for a in "dist/NextStop_${V}_x64-setup.exe" "dist/NextStop_${V}_arm64.apk"; do [[ -f "$a" ]] && ASSETS+=("$a"); done
  [[ ${#ASSETS[@]} -gt 0 ]] || { echo "✗ dist/ 裡沒有 ${V} 的安裝檔" >&2; exit 1; }
  echo "▸ ④ 鏡像 Release $TAG（${#ASSETS[@]} 檔）"
  if gh release view "$TAG" -R "$MIRROR_REPO" >/dev/null 2>&1; then
    run gh release upload "$TAG" "${ASSETS[@]}" -R "$MIRROR_REPO" --clobber
  else
    run gh release create "$TAG" "${ASSETS[@]}" -R "$MIRROR_REPO" --title "$TAG" --latest ${NOTES:+--notes-file "$NOTES"}
  fi
fi
echo "✓ 鏡像已更新：https://github.com/$MIRROR_REPO"
