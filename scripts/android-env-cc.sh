#!/usr/bin/env bash
# Android 裸 cargo 的補充環境（v1.1.1 整合席收編；原稿出自 WP7 的 scratchpad）
#
# 為什麼要這一支：`pnpm tauri android build` 會自己把 NDK 的 clang 塞給 cc-rs，
# 但**直接跑** `cargo check/build --target aarch64-linux-android` 不會——於是帶 C 原始碼的依賴
# （v1.1.1 新增的 zstd-sys、object_store 走 ring 的那一段）會在
#   `cc-rs: failed to find tool "clang.exe"` 掛掉。
# 這不是程式的問題，是環境變數沒設；WP7 踩過一次，收進 repo 免得下一個人再踩。
#
# 用法（在專案根目錄）：
#   source scripts/android-env-cc.sh
#   cd src-tauri && cargo check --target aarch64-linux-android
#
# 前提：JAVA_HOME／ANDROID_HOME／NDK_HOME 已經設好（見〈發版流程〉的 Android 段；
#       本機是 %LOCALAPPDATA%/Android 底下的 jdk17／Sdk／Sdk/ndk/<版本>）。
# NDK 版本跟著 src-tauri/gen/android 走，升版時這裡的 NDK_VER 要一起改。

NDK_VER="${NDK_VER:-28.2.13676358}"
# API level 24＝tauri android init 產生的 minSdk；clang 的 wrapper 檔名帶著它。
API_LEVEL="${API_LEVEL:-24}"

_ndk_root="$(cygpath -u "$LOCALAPPDATA" 2>/dev/null || echo "$HOME")/Android/Sdk/ndk/${NDK_VER}"
NDKBIN="${_ndk_root}/toolchains/llvm/prebuilt/windows-x86_64/bin"

if [ ! -d "$NDKBIN" ]; then
  echo "找不到 NDK toolchain：$NDKBIN（NDK_VER=$NDK_VER 對嗎？）" >&2
  return 1 2>/dev/null || exit 1
fi

export PATH="$NDKBIN:$PATH"
# cc-rs 認的是 `CC_<target 底線版>`；Windows 上要指到 .cmd 包裝檔（.exe 不存在）。
export CC_aarch64_linux_android="$(cygpath -w "$NDKBIN/aarch64-linux-android${API_LEVEL}-clang.cmd")"
export CXX_aarch64_linux_android="$(cygpath -w "$NDKBIN/aarch64-linux-android${API_LEVEL}-clang++.cmd")"
export AR_aarch64_linux_android="$(cygpath -w "$NDKBIN/llvm-ar.exe")"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$CC_aarch64_linux_android"

echo "Android cc 環境已就緒（NDK ${NDK_VER}、API ${API_LEVEL}）"
