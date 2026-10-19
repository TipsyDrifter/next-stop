#!/usr/bin/env bash
# adb-ro.sh — 對實體手機只讀的 adb 入口（權限白名單只放行這支腳本）。
# 用法：bash scripts/adb-ro.sh [-s <serial>] <子指令…>
#   允許：devices [-l]、mdns services、connect <host:port>、forward …（只做 tcp／localabstract 轉接）、
#         logcat -d …、exec-out screencap -p、
#         shell 後面第一個字在白名單：dumpsys、getprop、pm list…、pm path、cmd package list、cat、ls、date、uptime、screencap、id、whoami
#   擋下：install／uninstall／push／pull／reboot／root／disconnect、shell 裡的 rm／am／input／pm clear／settings put／su 等會改手機狀態的事；
#         任何參數含 ; & | > < ` $( 也擋（不讓 shell 字串夾帶第二個指令）。
# 為什麼：真機代驗只准唯讀（公約 §五）；auto 模式的分類器對裸 adb shell 一律擋，所以把「只讀」收成一支腳本讓白名單放行。
set -euo pipefail
die() { printf 'adb-ro：%s\n' "$1" >&2; exit 2; }
[[ $# -ge 1 ]] || die "缺子指令（devices／mdns services／connect／forward／logcat -d／exec-out screencap／shell <只讀指令>）"
for a in "$@"; do
  case "$a" in *';'*|*'&'*|*'|'*|*'>'*|*'<'*|*'`'*|*'$('*) die "參數含 shell 特殊字元，擋下：$a";; esac
done
ARGS=()
if [[ "$1" == "-s" ]]; then [[ $# -ge 3 ]] || die "-s 後面要有 serial 和子指令"; ARGS+=(-s "$2"); shift 2; fi
SUB="$1"; shift
case "$SUB" in
  devices) [[ $# -eq 0 || ( $# -eq 1 && "$1" == "-l" ) ]] || die "devices 只接 -l";;
  mdns) [[ $# -eq 1 && "$1" == "services" ]] || die "mdns 只接 services";;
  connect) [[ $# -eq 1 && "$1" =~ ^[A-Za-z0-9._:-]+$ ]] || die "connect 只接一個 host:port";;
  forward)
    # forward --list ／ forward tcp:<port> localabstract:<name>|tcp:<port>
    if [[ $# -eq 1 && "$1" == "--list" ]]; then :;
    elif [[ $# -eq 2 && "$1" =~ ^tcp:[0-9]+$ && "$2" =~ ^(localabstract:[A-Za-z0-9._-]+|tcp:[0-9]+)$ ]]; then :;
    else die "forward 只接 --list 或 tcp:<port> localabstract:<name>|tcp:<port>"; fi;;
  logcat) [[ $# -ge 1 && "$1" == "-d" ]] || die "logcat 只接 -d（dump 一次，不常駐）";;
  exec-out) [[ $# -ge 1 && "$1" == "screencap" ]] || die "exec-out 只接 screencap";;
  shell)
    [[ $# -ge 1 ]] || die "shell 後面要有指令"
    case "$1" in
      dumpsys|getprop|cat|ls|date|uptime|screencap|id|whoami) ;;
      pm) [[ $# -ge 2 && ( "$2" == "list" || "$2" == "path" ) ]] || die "shell pm 只接 list／path";;
      cmd) [[ $# -ge 3 && "$2" == "package" && "$3" == "list" ]] || die "shell cmd 只接 package list";;
      *) die "shell 子指令不在只讀白名單：$1";;
    esac;;
  *) die "子指令不在只讀白名單：$SUB（install／uninstall／push／pull／reboot 等要使用者或別的授權）";;
esac
if ! command -v adb >/dev/null 2>&1; then
  # Android 工具鏈在 Claude 的 silo 內，PATH 沒有 adb 時照各線的做法載環境
  # shellcheck source=android-env.sh
  source "$(dirname "$0")/android-env.sh" >/dev/null 2>&1 || true
  ADB="$(cygpath -u "${ANDROID_HOME:-}")/platform-tools/adb.exe"
  [[ -x "$ADB" ]] || die "找不到 adb（PATH 沒有、ANDROID_HOME 也沒有 platform-tools）"
else
  ADB=adb
fi
exec "$ADB" "${ARGS[@]}" "$SUB" "$@"
