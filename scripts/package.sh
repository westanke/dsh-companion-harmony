#!/usr/bin/env bash
#
# 打包脚本 —— 跑双闸门（构建 + 单测）并把 HAP 归集到 dist/。
#
# 用法：
#   ./scripts/package.sh            # 构建 + 单测 + 归集
#   ./scripts/package.sh --no-test  # 只构建 + 归集（改文案时想快一点）
#
# 说明：
# 1. 依赖 `../_toolchain/env.sh`（国内源自动安装的工具链，见 docs/PORT-MAP.md §0）。
#    脚本不吃外部环境变量，直接 source 那份文件，所以从任何目录调用都能跑。
# 2. 当前只产出 **未签名 HAP**（暂无华为开发者账号，见 build-profile.json5 里的注释模板）。
#    签名材料补齐后本脚本无需改动 —— 它按 `assembleHap` 的实际产物名归集。
# 3. 构建成功标志是 `BUILD SUCCESSFUL`；日志里的 `WARN: No signingConfig` 属预期输出。

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLCHAIN_ENV="${PROJECT_DIR}/../_toolchain/env.sh"
OUT_DIR="${PROJECT_DIR}/entry/build/default/outputs/default"
DIST_DIR="${PROJECT_DIR}/dist"

RUN_TEST=1
for arg in "$@"; do
  case "${arg}" in
    --no-test) RUN_TEST=0 ;;
    -h|--help)
      sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "未知参数：${arg}（用 --help 看用法）" >&2
      exit 2
      ;;
  esac
done

if [[ ! -f "${TOOLCHAIN_ENV}" ]]; then
  echo "找不到工具链环境文件：${TOOLCHAIN_ENV}" >&2
  echo "工具链需先用国内源装好（见 docs/PORT-MAP.md §0）。" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "${TOOLCHAIN_ENV}"

cd "${PROJECT_DIR}"

echo "==> [1/3] 构建 HAP（hvigorw assembleHap）"
hvigorw assembleHap --no-daemon

if [[ "${RUN_TEST}" -eq 1 ]]; then
  echo "==> [2/3] 离线单测（test/ 下纯逻辑层用例）"
  ( cd "${PROJECT_DIR}/test" && npm test )
else
  echo "==> [2/3] 跳过单测（--no-test）"
fi

echo "==> [3/3] 归集产物到 dist/"
mkdir -p "${DIST_DIR}"
shopt -s nullglob
HAPS=("${OUT_DIR}"/*.hap)
shopt -u nullglob
if [[ "${#HAPS[@]}" -eq 0 ]]; then
  echo "未在 ${OUT_DIR} 找到任何 .hap；构建可能没真正走到打包阶段。" >&2
  exit 1
fi
cp -f "${HAPS[@]}" "${DIST_DIR}/"

# LICENSE 必须随分发物一起给出去（AGPL-3.0 的要求），NOTICE 带上归属。
# 只把 HAP 拷出去、许可证留在仓库里，对一个"下载即分发"的产物来说不够。
cp -f "${PROJECT_DIR}/LICENSE" "${PROJECT_DIR}/NOTICE" "${DIST_DIR}/"

echo
echo "完成。产物："
ls -lh "${DIST_DIR}"/*.hap
echo "随产物附带的许可与归属：$(basename "${DIST_DIR}")/LICENSE、$(basename "${DIST_DIR}")/NOTICE"
