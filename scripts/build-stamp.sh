#!/usr/bin/env bash
#
# 构建水印 —— 把当前提交短哈希写进 entry/src/main/ets/core/BuildStamp.ets。
#
# 用法：
#   ./scripts/build-stamp.sh          # 重写为当前 HEAD 的短哈希
#   ./scripts/build-stamp.sh --check  # 只比对不写；不一致时退出码 1（CI / 发版前自检）
#
# 由 scripts/package.sh 在构建前调用；也可单独调用（例如手工出上架包）。
#
# 为什么是「出包前重写一次」而不是人手维护：这个值只能来自 git rev-parse，
# 人手维护必然过期，于是「这个包是从哪个提交出来的」这句话就不成立。
# 详见 entry/src/main/ets/core/BuildStamp.ets 的文件头说明。
#
# 非 git 环境（例如只有源码 tar 包）不是错误：写成空串，界面只显示版本号。
# 空串是**刻意设计**的合法取值而非失败状态 —— 所以那种情况下退出码仍然是 0。

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${PROJECT_DIR}/entry/src/main/ets/core/BuildStamp.ets"
CHECK=0

for arg in "$@"; do
  case "${arg}" in
    --check) CHECK=1 ;;
    -h|--help)
      sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "未知参数：${arg}（用 --help 看用法）" >&2
      exit 2
      ;;
  esac
done

if [[ ! -f "${TARGET}" ]]; then
  echo "找不到水印文件：${TARGET}" >&2
  exit 1
fi

COMMIT=""
if command -v git >/dev/null 2>&1 && git -C "${PROJECT_DIR}" rev-parse --git-dir >/dev/null 2>&1; then
  COMMIT="$(git -C "${PROJECT_DIR}" rev-parse --short HEAD)"
fi

# 只读那一行赋值，绝不碰文件头的长篇说明。
CURRENT="$(sed -n "s/^export const BUILD_COMMIT: string = '\(.*\)';\$/\1/p" "${TARGET}")"

if [[ "${CHECK}" -eq 1 ]]; then
  if [[ "${CURRENT}" == "${COMMIT}" ]]; then
    echo "水印一致：${COMMIT:-（空）}"
    exit 0
  fi
  echo "水印不一致：文件里是 '${CURRENT}'，当前 HEAD 是 '${COMMIT}'" >&2
  exit 1
fi

if [[ "${CURRENT}" == "${COMMIT}" ]]; then
  echo "水印无需更新：${COMMIT:-（空）}"
  exit 0
fi

sed -i "s/^export const BUILD_COMMIT: string = '\(.*\)';\$/export const BUILD_COMMIT: string = '${COMMIT}';/" "${TARGET}"
echo "水印已更新：${CURRENT:-（空）} → ${COMMIT:-（空）}"
