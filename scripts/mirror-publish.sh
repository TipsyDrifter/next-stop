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
#   bash scripts/mirror-publish.sh --tag v1.2.0                 # 內容取自私有 repo 的 tag v1.2.0（不是當前工作樹）＋在鏡像打 tag
#                                                               #   --tag 只吃 vX.Y.Z 而且必須是 refs/tags/ 下真的存在的 tag
#                                                               #   （分支名／HEAD／sha 一律擋；tag ≠ HEAD 時印一行警告照發）
#   bash scripts/mirror-publish.sh --tag v1.2.0 --release --notes docs/release-notes/v1.2.0.md
#                                                               # 再把 dist/NextStop_1.2.0_* 兩檔發成鏡像的 GitHub Release
#   --dry-run：只印不做。
#   --allow-older：明知故犯地把比鏡像現有最新版舊的 tag 發上去（Release 會標 --latest=false）。
#
# 舊版線的 hotfix 不發鏡像（複驗 V5）：鏡像只有一條 main，每次發布都是整包覆蓋成一顆 squash commit——
#   v1.2.0 發過之後再發 v1.1.5，公開 clone main 的人拿到的程式碼會**倒退**（v1.2 的檔案整批消失）。
#   所以 ③ 之前會比對鏡像現有最高的 vX.Y.Z tag，往回發直接停；真的要發只有 --allow-older 一條路。
#
# 公開名單（白名單思維——沒列的一律不出去）：
#   根目錄檔：README.md LICENSE package.json pnpm-lock.yaml pnpm-workspace.yaml index.html vite.config.ts tsconfig*.json .gitignore .gitattributes
#   目錄：src/ src-tauri/ public/ scripts/（排除 scripts/probes/）docs/images/ docs/release-notes/ docs/發版流程.md
#   不出去：docs/ 其餘、files/、prototypes/、.claude/、.vscode/、scripts/probes/、.sync/
set -euo pipefail

MIRROR_REPO="${MIRROR_REPO:-TipsyDrifter/next-stop}"
TAG=""; DO_RELEASE=0; NOTES=""; DRY=0; ALLOW_OLDER=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    # ${2:-}＋先檢查再 shift：`--tag` 忘了帶值時，原本會撞 set -u 的「$2: unbound variable」，看不出是什麼壞了
    --tag) TAG="${2:-}"; [[ -n "$TAG" ]] || { echo "✗ --tag 要帶發版 tag（vX.Y.Z）" >&2; exit 2; }; shift 2;;
    --release) DO_RELEASE=1; shift;;
    --notes) NOTES="$2"; shift 2;;
    --dry-run) DRY=1; shift;;
    --allow-older) ALLOW_OLDER=1; shift;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

say() { printf '  %s\n' "$1"; }
run() { if [[ $DRY -eq 1 ]]; then say "\$ $*"; else "$@"; fi; }

[[ -z "$(git status --porcelain)" ]] || { echo "✗ 工作樹不乾淨，先 commit 或 stash。" >&2; exit 1; }

# 匯出來源：給了 --tag 就以「那顆 tag 指到的 commit」為準，不是當前工作樹。
# 為什麼：hotfix 的發布 build 做在 hotfix 分支上，合回 main 後回主桌發鏡像時 HEAD 已經是 main
#   （多半還領先，含未發布的半成品）——用 HEAD 匯出就會把半成品當成 v<舊版號+1> 的內容發出去。
SRC_REF="HEAD"; SRC_LABEL="HEAD"
if [[ -n "$TAG" ]]; then
  # 複驗 V4：原本驗的是「${TAG}^{commit} 能不能解析」——分支名、HEAD、甚至一串 sha 都會通過，
  #   然後在鏡像打出一顆叫 `40b548a`／`main` 的 tag（`--tag main` 還會在 ③ 撞 refspec ambiguous 才炸，
  #   訊息完全看不出是參數給錯）。這裡改成只吃 vX.Y.Z、而且必須是 refs/tags/ 底下真的有的 tag。
  [[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] \
    || { echo "✗ --tag 只吃發版 tag（vX.Y.Z），不吃分支名／HEAD／sha：${TAG}" >&2; exit 2; }
  git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null \
    || { echo "✗ 私有 repo 沒有 tag ${TAG}——先跑 scripts/release.sh 打 tag，再發鏡像。" >&2; exit 1; }
  SRC_REF="refs/tags/${TAG}"; SRC_LABEL="$TAG"
fi
SRC_SHA="$(git rev-parse "${SRC_REF}^{commit}")"
SRC_SHORT="$(git rev-parse --short "${SRC_REF}^{commit}")"
SRC_SUBJ="$(git log -1 --pretty=%s "$SRC_SHA")"
if [[ -n "$TAG" && "$SRC_SHA" != "$(git rev-parse HEAD)" ]]; then
  say "⚠ 鏡像內容取自 tag ${TAG}（${SRC_SHORT}），非目前工作樹（HEAD $(git rev-parse --short HEAD)）"
fi

# 不准往回發（複驗 V5）：鏡像只有一條 main，整包覆蓋＝公開程式碼會倒退。
# 讀遠端 tag 而不是等 clone：② 之後才發現就已經做了半套；讀不到遠端（離網／鏡像還沒建）只警告，不擋。
if [[ -n "$TAG" ]]; then
  MIR_TAGS="$(git ls-remote --tags "https://github.com/$MIRROR_REPO.git" 2>/dev/null \
    | sed -E 's#^.*refs/tags/##; s#\^\{\}$##' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -u || true)"
  if [[ -z "$MIR_TAGS" ]]; then
    say "（鏡像還沒有 vX.Y.Z tag，或讀不到遠端——跳過「不准往回發」比對）"
  else
    MIR_TOP="$(printf '%s\n' "$MIR_TAGS" | sort -V | tail -1)"
    if [[ "$MIR_TOP" != "$TAG" && "$(printf '%s\n%s\n' "$MIR_TOP" "$TAG" | sort -V | tail -1)" == "$MIR_TOP" ]]; then
      if [[ $ALLOW_OLDER -eq 1 ]]; then
        say "⚠ --allow-older：${TAG} 比鏡像現有最新 ${MIR_TOP} 舊，照發（公開 main 會倒退；Release 標 --latest=false）"
      else
        echo "✗ ${TAG} 比鏡像現有最新版 ${MIR_TOP} 舊——鏡像只有一條 main，發上去會讓公開的程式碼倒退。" >&2
        echo "  舊版線的 hotfix 預設不發鏡像（私有 repo 的 tag／Release 仍然有）。真要發：加 --allow-older。" >&2
        exit 1
      fi
    fi
  fi
fi

WHITELIST_FILES=(README.md LICENSE package.json pnpm-lock.yaml pnpm-workspace.yaml index.html vite.config.ts tsconfig.json tsconfig.node.json .gitignore .gitattributes)
WHITELIST_DIRS=(src src-tauri public scripts docs/images docs/release-notes)
WHITELIST_EXTRA=("docs/發版流程.md")
EXCLUDE_INSIDE=(scripts/probes src-tauri/gen/android/app/build src-tauri/target)

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
EXPORT="$WORK/export"; MIR="$WORK/mirror"
mkdir -p "$EXPORT"

echo "▸ ① 從私有 repo ${SRC_LABEL}（$SRC_SHORT）匯出白名單"
git archive --format=tar "$SRC_REF" | tar -x -C "$EXPORT"
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
  (cd "$MIR" && git add -A && git -c user.name="Kosa" -c user.email="kosa@users.noreply.github.com" commit -q -m "${TAG:+$TAG — }$SRC_SUBJ (dev@$SRC_SHORT)" || true)
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
    # --verify-tag：③ 已經把 tag push 到鏡像；沒有的話就停，不讓 gh 拿鏡像 default branch 的最新狀態自己建 tag
    REL_ARGS=(--verify-tag --title "$TAG")
    # --allow-older 時不可以標 Latest（那顆 Release 的內容比鏡像現有的舊）
    if [[ $ALLOW_OLDER -eq 1 ]]; then REL_ARGS+=(--latest=false); else REL_ARGS+=(--latest); fi
    [[ -z "$NOTES" ]] || REL_ARGS+=(--notes-file "$NOTES")
    run gh release create "$TAG" "${ASSETS[@]}" -R "$MIRROR_REPO" "${REL_ARGS[@]}"
  fi
fi
echo "✓ 鏡像已更新：https://github.com/$MIRROR_REPO"
