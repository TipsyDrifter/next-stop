#!/usr/bin/env bash
# Android 建置環境（v1.1.2 WP12 收編；原稿是 v1.1.0 WP3 留在 scratchpad 的 env.sh，沒進 repo）
#
# 為什麼要進 repo：`pnpm tauri android build` 要 JAVA_HOME／ANDROID_HOME／NDK_HOME 三個變數，
#   本機全在 %LOCALAPPDATA%/Android 底下（jdk17／Sdk／Sdk/ndk/<版本>）；每次發版都重設一遍太脆弱，
#   release.sh 直接 `source` 這支。**不含任何憑證**（keystore 密碼在 keystore.properties，gradle 自己讀）。
#
# 用法：
#   source scripts/android-env.sh
#   pnpm tauri android build --apk --target aarch64
# 版本跟著 src-tauri/gen/android 走（NDK 28.2.13676358／JDK 17）；升版時這裡與 android-env-cc.sh 一起改。
# 可用環境變數蓋掉：NS_ANDROID_ROOT（預設 %LOCALAPPDATA%/Android）、NDK_VER。

NS_ANDROID_ROOT="${NS_ANDROID_ROOT:-$(cygpath -u "${LOCALAPPDATA:-}" 2>/dev/null || echo "$HOME")/Android}"
NDK_VER="${NDK_VER:-28.2.13676358}"

export JAVA_HOME="${JAVA_HOME:-$(cygpath -w "$NS_ANDROID_ROOT/jdk17")}"
export ANDROID_HOME="${ANDROID_HOME:-$(cygpath -w "$NS_ANDROID_ROOT/Sdk")}"
export NDK_HOME="${NDK_HOME:-$(cygpath -w "$NS_ANDROID_ROOT/Sdk/ndk/$NDK_VER")}"

for d in "$JAVA_HOME" "$ANDROID_HOME" "$NDK_HOME"; do
  if [ ! -d "$(cygpath -u "$d")" ]; then
    echo "找不到：$d（NS_ANDROID_ROOT=$NS_ANDROID_ROOT 對嗎？）" >&2
    return 1 2>/dev/null || exit 1
  fi
done

# 裸 cargo 的 cc 補環境（zstd-sys／ring 帶 C 原始碼；見該檔檔頭）
# shellcheck source=android-env-cc.sh
. "$(dirname "${BASH_SOURCE[0]}")/android-env-cc.sh"

echo "Android 建置環境已就緒（JDK 17、NDK ${NDK_VER}）"
