#!/usr/bin/env bash
# 私鐵手帳 · 發版腳本（v1.1.2 WP12；契約席 2026-09-19 立骨架、WP12 填齊 ②–⑥）
#
# 為什麼要有這支：v1.0／v1.1.0／v1.1.1 三次發版都是人手照決策記錄〈發版流程〉逐步敲——
#   版號要改三處（package.json／tauri.conf.json／Cargo.toml）＋ Cargo.lock 要跟、tag 要對到版號 commit、
#   桌機 NSIS 與手機 APK 各一條指令、產物要改成英文檔名進 dist/、最後 gh release。
#   每一步都有踩過的坑（WiX 吃不下中文名、GitHub 剝中文檔名、release 簽章 keystore 在 repo 外……），
#   寫成腳本＝流程定案（D-1.1-7 v1.1.2「發版定案」）。
# 拍板依據：決策記錄〈v1.1.0 出爐〉發版流程（v1.1.2 定案）、〈v1.1 開工訪談拍板〉9（安裝包進 dist/）、
#   D-1.1-8（release APK＋自簽 keystore，私鑰不進 repo）；契約 docs/research/2026-09-19-v1.1.2-雙向同步契約.md §8。
#
# 用法（Git Bash，專案根目錄）：
#   bash scripts/release.sh <版號> [--notes <md 檔>] [--dry-run] [--skip-apk]
#   例：bash scripts/release.sh 1.1.2 --notes docs/release-notes/v1.1.2.md
#
# 步驟：
#   ① 前置檢查：git 乾淨、在 main、tag 不存在、pnpm／cargo／gh／node 都在、gh 已登入、keystore.properties 找得到（找不到只警告）
#   ② bump：package.json／src-tauri/tauri.conf.json 的 "version"、src-tauri/Cargo.toml [package] version（sed 各只改一行）；
#      `cargo metadata --no-deps --offline` 讓 Cargo.lock 跟上（不碰網路；失敗退到 `cargo update -p next-stop --offline`）
#   ③ commit「chore: 版號 <版號>」（沿 v1.1.1 的寫法）→ tag v<版號>（tag 一定指到版號 commit，v1.0 的偏差不再發生）
#   ④ 桌機：`CI=true pnpm tauri build --bundles nsis` → dist/NextStop_<版號>_x64-setup.exe（只出 NSIS：WiX 吃不下中文 productName）
#   ⑤ 手機：source scripts/android-env.sh → `pnpm tauri android build --apk --target aarch64`
#      → dist/NextStop_<版號>_arm64.apk；apksigner 驗簽章：憑證 CN 要含「Next Stop」（主人的 keystore），debug 簽章即停
#   ⑥ git push origin main v<版號> → `gh release create v<版號> <兩檔> --title --notes-file`（沒給 --notes ⇒ --generate-notes）
#   --dry-run：只跑 ①，②–⑥ 印出會執行的指令，不改任何檔、不 build、不 push。
#   --skip-apk：跳過 ⑤（release 只附 exe）。
#
# 鐵則：不印憑證（keystore 密碼只在 keystore.properties，gradle 自己讀，本腳本不讀它）；失敗即停（set -e），
#   bump 之後、push 之前失敗 ⇒ 腳本會提示回滾指令（git checkout 四檔／git tag -d）；push 之後失敗 ⇒ 人手補 gh release。
#
# 環境變數（可選）：NS_APK_CN（預設「Next Stop」，簽章 CN 要含的字串）、NS_ANDROID_ROOT／NDK_VER（見 android-env.sh）。

set -euo pipefail

# ─── 參數 ───
VERSION=""
NOTES=""
DRY_RUN=0
SKIP_APK=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --notes) NOTES="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-apk) SKIP_APK=1; shift ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) if [[ -z "$VERSION" ]]; then VERSION="$1"; shift; else echo "不認得的參數：$1" >&2; exit 2; fi ;;
  esac
done
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "用法：bash scripts/release.sh <X.Y.Z> [--notes <md>] [--dry-run] [--skip-apk]" >&2
  exit 2
fi
TAG="v${VERSION}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

say()  { printf '  %s\n' "$1"; }
step() { printf '\n▸ %s\n' "$1"; }
die()  { printf '✗ %s\n' "$1" >&2; exit 1; }
# --dry-run 時只印指令；否則印了再跑
run()  { say "\$ $*"; if [[ "$DRY_RUN" == "0" ]]; then "$@"; fi; }

# ─── 失敗回滾提示（bump 之後才有意義；push 之後改成補救提示）───
PHASE="pre"   # pre → bumped → tagged → pushing → pushed → done
VERSION_FILES=(package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock)
on_err() {
  local code=$?
  [[ $code -eq 0 ]] && return 0
  printf '\n✗ 發版在「%s」階段失敗（exit %d）。\n' "$PHASE" "$code" >&2
  case "$PHASE" in
    bumped) printf '  回滾：git checkout -- %s\n' "${VERSION_FILES[*]}" >&2 ;;
    # 評審 S8：原本建議 `git reset --hard HEAD~1`——那會把工作樹裡**沒 commit 的東西**一起抹掉。
    # `--soft` 退 commit、再單獨 checkout 四個版號檔，效果一樣而且只動該動的。
    tagged) printf '  回滾：git tag -d %s && git reset --soft HEAD~1 && git checkout -- %s   （版號 commit 還沒 push，可安全退掉）\n' "$TAG" "${VERSION_FILES[*]}" >&2 ;;
    # 評審 S8：`git push origin main "$TAG"` 可能半成功（main 上了、tag 沒上，或反之）。
    # 以前這個窗口落在 `tagged`，提示會叫人 reset 一個**已經在遠端**的 commit。
    pushing) printf '  push 可能只成功一半：先 `git ls-remote origin main refs/tags/%s` 看哪個上去了。\n  tag 沒上就 `git push origin %s`；兩個都沒上才照 tagged 的方式退。\n' "$TAG" "$TAG" >&2 ;;
    pushed) printf '  main 與 tag 已 push；請人手補：gh release create %s dist/NextStop_%s_x64-setup.exe dist/NextStop_%s_arm64.apk --title %s --notes-file <md>\n' "$TAG" "$VERSION" "$VERSION" "$TAG" >&2 ;;
  esac
}
trap on_err EXIT

# ─── ① 前置檢查 ───
step "① 前置檢查（${TAG}）"
# --dry-run 不動任何東西，所以 git 狀態三項只警告不擋（方便在半路上先演練）；真發版一律擋。
soft() { if [[ "$DRY_RUN" == "1" ]]; then say "⚠ $1（--dry-run 放行；真發版會停）"; else die "$1"; fi; }
[[ -z "$(git status --porcelain)" ]] || soft "git 工作樹不乾淨——先 commit 或 stash。"
[[ "$(git rev-parse --abbrev-ref HEAD)" == "main" ]] || soft "請在 main 分支發版。"
if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then soft "tag ${TAG} 已存在。"; fi
for tool in pnpm cargo gh node git; do command -v "$tool" >/dev/null 2>&1 || die "找不到 ${tool}。"; done
gh auth status >/dev/null 2>&1 || die "gh 尚未登入（gh auth login）。"
if [[ -n "$NOTES" && ! -f "$NOTES" ]]; then die "找不到 notes 檔：$NOTES"; fi
if [[ -z "$NOTES" ]]; then say "⚠ 沒給 --notes，⑥ 會用 gh --generate-notes（建議先寫 docs/release-notes/${TAG}.md）"; fi
LOCAL_U="$(cygpath -u "${LOCALAPPDATA:-}" 2>/dev/null || echo "$HOME")"
KEYSTORE_PROPS="${LOCAL_U}/Android/keystore/keystore.properties"
if [[ "$SKIP_APK" == "0" ]]; then
  if [[ -f "$KEYSTORE_PROPS" ]]; then say "✓ keystore.properties 在（release APK 會用主人的簽章）"; else say "⚠ 找不到 ${KEYSTORE_PROPS}——APK 會退回 debug 簽章，⑤ 驗簽會停"; fi
  [[ -f scripts/android-env.sh ]] || die "找不到 scripts/android-env.sh。"
fi
# 版號現況（三處應一致；不一致只警告，bump 後就一致了）
CUR_PKG="$(grep -m1 -E '^  "version": "' package.json | sed -E 's/.*"version": "([^"]+)".*/\1/')"
CUR_TAURI="$(grep -m1 -E '^  "version": "' src-tauri/tauri.conf.json | sed -E 's/.*"version": "([^"]+)".*/\1/')"
CUR_CARGO="$(grep -m1 -E '^version = "' src-tauri/Cargo.toml | sed -E 's/^version = "([^"]+)".*/\1/')"
say "目前版號：package.json=${CUR_PKG}、tauri.conf.json=${CUR_TAURI}、Cargo.toml=${CUR_CARGO} → 目標 ${VERSION}"
[[ "$CUR_PKG" == "$CUR_TAURI" && "$CUR_TAURI" == "$CUR_CARGO" ]] || say "⚠ 三處版號目前不一致"
[[ "$CUR_PKG" != "$VERSION" ]] || die "版號已是 ${VERSION}，沒東西可 bump。"
say "✓ 前置檢查通過"
[[ "$DRY_RUN" == "1" ]] && say "（--dry-run：以下只印指令，不執行）"

# ─── ② bump 三處版號＋Cargo.lock ───
step "② bump 版號 → ${VERSION}"
# sed 各只改「第一個」符合的行：package.json／tauri.conf.json 是頂層兩空白縮排的 "version"；Cargo.toml 是 [package] 的 version。
run sed -i -E "0,/^  \"version\": \"[^\"]+\"/s//  \"version\": \"${VERSION}\"/" package.json
run sed -i -E "0,/^  \"version\": \"[^\"]+\"/s//  \"version\": \"${VERSION}\"/" src-tauri/tauri.conf.json
run sed -i -E "0,/^version = \"[^\"]+\"/s//version = \"${VERSION}\"/" src-tauri/Cargo.toml
if [[ "$DRY_RUN" == "0" ]]; then
  PHASE="bumped"
  for f in package.json src-tauri/tauri.conf.json; do
    [[ "$(grep -c -E "^  \"version\": \"${VERSION}\"" "$f")" == "1" ]] || die "${f} 的 version 沒改到 ${VERSION}。"
  done
  [[ "$(grep -c -E "^version = \"${VERSION}\"" src-tauri/Cargo.toml)" == "1" ]] || die "Cargo.toml 的 version 沒改到 ${VERSION}。"
fi
say "Cargo.lock 跟上（離線）"
if [[ "$DRY_RUN" == "0" ]]; then
  # 首次實跑（1.1.2）踩到：cargo 1.95 的 `cargo metadata --offline` 回 0 但**不再改寫** Cargo.lock，
  # 只有 `cargo update -p <pkg> --offline` 會真的把本 crate 的版號鎖進去。改以它為主。
  (cd src-tauri && cargo update -p next-stop --offline >/dev/null 2>&1)     || (cd src-tauri && cargo metadata --no-deps --offline --format-version 1 >/dev/null 2>&1) || true
  grep -A1 'name = "next-stop"' src-tauri/Cargo.lock | grep -q "version = \"${VERSION}\"" || die "Cargo.lock 的 next-stop 版本沒跟上 ${VERSION}。"
  say "✓ 四檔版號一致：$(grep -A1 'name = "next-stop"' src-tauri/Cargo.lock | tail -1)"
else
  say "\$ (cd src-tauri && cargo metadata --no-deps --offline --format-version 1 >/dev/null) || (cd src-tauri && cargo update -p next-stop --offline)"
fi

# ─── ③ commit＋tag ───
step "③ commit＋tag ${TAG}"
run git add "${VERSION_FILES[@]}"
run git commit -q -m "chore: 版號 ${VERSION}"
run git tag "$TAG"
[[ "$DRY_RUN" == "0" ]] && PHASE="tagged"

# ─── ④ 桌機 NSIS ───
step "④ 桌機 NSIS → dist/NextStop_${VERSION}_x64-setup.exe"
mkdir -p dist
run env CI=true pnpm tauri build --bundles nsis
EXE_SRC="src-tauri/target/release/bundle/nsis/私鐵手帳_${VERSION}_x64-setup.exe"
EXE_DST="dist/NextStop_${VERSION}_x64-setup.exe"
if [[ "$DRY_RUN" == "0" ]]; then
  if [[ ! -f "$EXE_SRC" ]]; then
    EXE_SRC="$(ls -t src-tauri/target/release/bundle/nsis/*_"${VERSION}"_x64-setup.exe 2>/dev/null | head -1 || true)"
  fi
  [[ -n "$EXE_SRC" && -f "$EXE_SRC" ]] || die "找不到 NSIS 產物（src-tauri/target/release/bundle/nsis/*_${VERSION}_x64-setup.exe）。"
  cp -f "$EXE_SRC" "$EXE_DST"
  say "✓ ${EXE_DST}（$(du -h "$EXE_DST" | cut -f1)）"
else
  say "\$ cp -f ${EXE_SRC} ${EXE_DST}"
fi

# ─── ⑤ 手機 APK ───
APK_DST="dist/NextStop_${VERSION}_arm64.apk"
APK_CN="${NS_APK_CN:-Next Stop}"
if [[ "$SKIP_APK" == "1" ]]; then
  step "⑤ 手機 APK：--skip-apk，跳過"
else
  step "⑤ 手機 APK → ${APK_DST}"
  APK_SRC="src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk"
  # v1.1.3 工程評審 N-12：AndroidManifest 在 gen/android 底下，`tauri android init` 會把它重生成模板版
  # ——`allowBackup="false"` 一旦被洗掉，系統備份就會把同步身分搬到另一支手機（兩支頂同一個身分互推）。
  # 這是「安靜地壞掉」的那種，所以在發版前硬擋一次。
  MANIFEST="src-tauri/gen/android/app/src/main/AndroidManifest.xml"
  if [[ -f "$MANIFEST" ]]; then
    grep -q 'android:allowBackup="false"' "$MANIFEST" \
      || die "AndroidManifest 少了 android:allowBackup=\"false\"（多半是 tauri android init 重生過）——回填後再發。"
  fi
  if [[ "$DRY_RUN" == "0" ]]; then
    # shellcheck source=android-env.sh
    source scripts/android-env.sh
    pnpm tauri android build --apk --target aarch64
    [[ -f "$APK_SRC" ]] || die "找不到 APK 產物（${APK_SRC}）。"
    # 驗簽章：拿 build-tools 最新版的 apksigner；憑證 CN 要含主人的名字，debug 簽章（CN=Android Debug）即停
    ANDROID_HOME_U="$(cygpath -u "$ANDROID_HOME")"
    APKSIGNER="$(ls -d "${ANDROID_HOME_U}"/build-tools/*/apksigner.bat 2>/dev/null | sort -V | tail -1 || true)"
    if [[ -z "$APKSIGNER" ]]; then
      say "⚠ 找不到 apksigner（${ANDROID_HOME_U}/build-tools/*/），跳過驗簽——請人手確認不是 debug 簽章"
    else
      CERTS="$("$APKSIGNER" verify --print-certs "$APK_SRC" 2>&1 | grep -i 'certificate DN' || true)"
      say "簽章：${CERTS:-（讀不到）}"
      echo "$CERTS" | grep -q "$APK_CN" || die "APK 簽章不是主人的 keystore（CN 沒含「${APK_CN}」）——這包裝不上主人手機，停。"
    fi
    cp -f "$APK_SRC" "$APK_DST"
    say "✓ ${APK_DST}（$(du -h "$APK_DST" | cut -f1)）"
  else
    say "\$ source scripts/android-env.sh && pnpm tauri android build --apk --target aarch64"
    say "\$ apksigner verify --print-certs ${APK_SRC}   # 憑證 CN 要含「${APK_CN}」，否則停"
    say "\$ cp -f ${APK_SRC} ${APK_DST}"
  fi
fi

# ─── ⑥ push＋GitHub Release ───
step "⑥ push main＋${TAG} → gh release create"
[[ "$DRY_RUN" == "0" ]] && PHASE="pushing"   # 評審 S8：半成功的窗口在這一行裡面，提示要對得上
run git push origin main "$TAG"
[[ "$DRY_RUN" == "0" ]] && PHASE="pushed"
ASSETS=("$EXE_DST")
[[ "$SKIP_APK" == "0" ]] && ASSETS+=("$APK_DST")
if [[ -n "$NOTES" ]]; then
  run gh release create "$TAG" "${ASSETS[@]}" --title "$TAG" --notes-file "$NOTES"
else
  run gh release create "$TAG" "${ASSETS[@]}" --title "$TAG" --generate-notes
fi

PHASE="done"
if [[ "$DRY_RUN" == "1" ]]; then
  step "--dry-run 結束：沒有改任何檔、沒有 build、沒有 push。"
else
  step "✓ ${TAG} 發版完成"
  say "Release：$(gh release view "$TAG" --json url -q .url 2>/dev/null || echo "gh release view ${TAG}")"
  say "手機更新＝下載 ${APK_DST##*/} 覆蓋安裝；桌機＝跑 ${EXE_DST##*/}。"
fi
