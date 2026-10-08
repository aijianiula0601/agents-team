#!/usr/bin/env bash
# 一键编译、校验不可调试的 Android Release APK。
# 参数：可选 --legacy-signing，仅用于沿用 0.5.5 原签名进行无损覆盖升级。
# 返回值：构建与校验成功退出 0，否则非零；签名密码只从环境变量读取，不输出到日志。
# 产物：dist/Chorus-<version>-android-build<versionCode>.apk 及检查报告。

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ANDROID_DIR="$ROOT_DIR/android-app"
APK_PATH="$ANDROID_DIR/android/app/build/outputs/apk/release/app-release.apk"
GRADLE_ARGS=(--console=plain)

# ------------ 明确签名来源，不自动生成新密钥或回退到调试构建 ---------------
if [[ "$#" -eq 1 && "${1:-}" == "--legacy-signing" ]]; then
  export CHORUS_ANDROID_LEGACY_SIGNING=1
  export CHORUS_ANDROID_EXPECTED_CERT_SHA256="$(node -p 'require(process.argv[1]).legacyCertificate' "$ROOT_DIR/scripts/verify-apk.js")"
  GRADLE_ARGS+=(-PchorusLegacySigning=true)
elif [[ "$#" -ne 0 ]]; then
  echo "用法：./scripts/build-apk.sh [--legacy-signing]" >&2
  exit 1
else
  export CHORUS_ANDROID_LEGACY_SIGNING=0
  if [[ -z "${CHORUS_ANDROID_KEYSTORE:-}" || -z "${CHORUS_ANDROID_STORE_PASSWORD:-}" || -z "${CHORUS_ANDROID_KEY_ALIAS:-}" || -z "${CHORUS_ANDROID_KEY_PASSWORD:-}" || -z "${CHORUS_ANDROID_EXPECTED_CERT_SHA256:-}" ]]; then
    echo "错误：请配置 Android 正式签名环境变量；沿用已交付 0.5.5 的原签名请显式使用 --legacy-signing（见 android-app/README.md）。" >&2
    exit 1
  fi
fi

echo "------------- build android apk --------------"

# ------------ 环境变量（本机常见路径，可被外部覆盖）---------------
if [[ -z "${JAVA_HOME:-}" ]]; then
  SYSTEM_JDK="$(/usr/libexec/java_home -v 17 2>/dev/null || true)"
  if [[ -n "$SYSTEM_JDK" ]]; then
    export JAVA_HOME="$SYSTEM_JDK"
  elif command -v brew >/dev/null 2>&1; then
    BREW_JDK="$(brew --prefix openjdk@17 2>/dev/null || true)"
    if [[ -n "$BREW_JDK" && -d "$BREW_JDK/libexec/openjdk.jdk/Contents/Home" ]]; then
      export JAVA_HOME="$BREW_JDK/libexec/openjdk.jdk/Contents/Home"
    fi
  fi
fi

if [[ -z "${ANDROID_HOME:-}" ]]; then
  if [[ -d "$HOME/Library/Android/sdk" ]]; then
    export ANDROID_HOME="$HOME/Library/Android/sdk"
  elif [[ -d "$HOME/Android/Sdk" ]]; then
    export ANDROID_HOME="$HOME/Android/Sdk"
  fi
fi

if [[ -n "${JAVA_HOME:-}" ]]; then
  export PATH="$JAVA_HOME/bin:${PATH}"
fi
if [[ -n "${ANDROID_HOME:-}" ]]; then
  export PATH="$ANDROID_HOME/platform-tools:${PATH}"
fi

if [[ -n "${JAVA_HOME:-}" && ! -x "$JAVA_HOME/bin/java" ]]; then
  echo "错误：JAVA_HOME 中没有可执行的 java，请设置正确的 JDK 17 路径。" >&2
  exit 1
fi
if ! command -v java >/dev/null 2>&1; then
  echo "错误：没有找到 JDK 17，请设置 JAVA_HOME 或将 JDK 加入 PATH。" >&2
  exit 1
fi
if [[ -z "${ANDROID_HOME:-}" || ! -d "$ANDROID_HOME" ]]; then
  echo "错误：未设置 ANDROID_HOME，请安装 Android SDK（常见路径 ~/Library/Android/sdk）" >&2
  exit 1
fi

cd "$ANDROID_DIR"

# ------------ 同一工作区只运行一个 APK 构建，避免 npm ci 清理另一构建的依赖 ---------------
BUILD_LOCK="$ANDROID_DIR/.apk-build-lock"
if ! mkdir "$BUILD_LOCK" 2>/dev/null; then
  echo "错误：此工作区已有 APK 构建。请等待结束后重试；若上次进程异常退出，确认无构建后再移除 android-app/.apk-build-lock。" >&2
  exit 1
fi
trap 'rmdir "$BUILD_LOCK" 2>/dev/null || true' EXIT

echo "------------- 按锁文件安装构建依赖 --------------"
npm ci

if [[ ! -d android ]]; then
  echo "错误：仓库原生工程缺失，请恢复 android-app/android 后再构建。" >&2
  exit 1
fi

npm run cap:sync
./android/gradlew --project-dir android :app:assembleRelease :app:lintRelease "${GRADLE_ARGS[@]}"

BUILD_TOOLS=""
for tools_dir in "$ANDROID_HOME"/build-tools/*; do
  if [[ -x "$tools_dir/apksigner" && -x "$tools_dir/zipalign" && -x "$tools_dir/aapt" ]]; then
    BUILD_TOOLS="$tools_dir"
  fi
done
if [[ -z "$BUILD_TOOLS" ]]; then
  echo "错误：Android Build Tools 缺少 aapt、apksigner 或 zipalign。" >&2
  exit 1
fi
APP_VERSION="$(node -p "require('./package.json').version")"
if [[ ! "$APP_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]]; then
  echo "错误：package.json 应包含有效版本号。" >&2
  exit 1
fi
APP_BUILD="$(node -e 'const fs = require("node:fs"); process.stdout.write(fs.readFileSync("android/app/build.gradle", "utf8").match(/versionCode\s+(\d+)/)[1]);')"
DELIVERY_PATH="$ROOT_DIR/dist/Chorus-$APP_VERSION-android-build$APP_BUILD.apk"
mkdir -p "$ROOT_DIR/dist"
node "$ROOT_DIR/scripts/verify-apk.js" "$APK_PATH" "$BUILD_TOOLS" "${DELIVERY_PATH%.apk}-validation.json"
cp "$APK_PATH" "$DELIVERY_PATH"

echo "------------- done --------------"
if [[ -f "$APK_PATH" ]]; then
  ls -lh "$DELIVERY_PATH"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$DELIVERY_PATH"
  else
    sha256sum "$DELIVERY_PATH"
  fi
  echo "安装到手机：adb install -r \"$DELIVERY_PATH\""
  echo "已完成构建与包检查；脚本未安装或验证手机运行。"
else
  echo "警告：未找到 APK，请检查构建日志。" >&2
  exit 1
fi
