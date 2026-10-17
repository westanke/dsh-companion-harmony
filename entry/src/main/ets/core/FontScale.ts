/**
 * 应用内字号缩放的**取值规则** —— 移植自原工程 `data/AppPreferences.kt` 的
 * `normalizeFontScale` 与 `ui/theme/AppFontScale.kt` 的取值说明。
 *
 * 上界 1.5 / 下界 0.8 是与对比对象一致的取值：再大正文一屏放不下几行，
 * 再小中文就糊成一团。
 *
 * ## 为什么单独一个文件、并且是纯函数
 *
 * 偏好本身依赖平台的键值存储（测不动），而**这条边界规则才是真正会出错的地方**：
 * 一个坏值原样塞进字号缩放接口，会以 NaN 尺寸测量整个界面 —— 表现是「白屏且不崩」，
 * 比直接崩还难查。所以规则抽出来单测。
 *
 * ## 与源工程的差异：不用 `Number.isFinite` 的三元写法
 *
 * 源工程是 `if (value.isFinite()) value.coerceIn(0.8f, 1.5f) else 1f`。
 * ArkTS 里 `Number.isFinite` 对 `undefined` / `null`（JSON 里 `NaN` 落盘后读回来的
 * 常见形态）判断是 false，行为一致；这里改成显式 `value !== value` 判 NaN 与
 * `Number.isFinite` 并联，是为了让「读出来是 NaN」与「读出来是 Infinity」两条
 * 都能落到同一个兜底上，且不依赖 ArkTS 对 `Number.isFinite` 的实现细节。
 */

/** 可调区间下限。 */
export const FONT_SCALE_MIN: number = 0.8;
/** 可调区间上限。 */
export const FONT_SCALE_MAX: number = 1.5;
/** 落点间隔：0.8 → 1.5，步进 0.1（共 8 个落点）。 */
export const FONT_SCALE_STEP: number = 0.1;
/** 默认倍数：1.0 = 系统字号原样。 */
export const FONT_SCALE_DEFAULT: number = 1.0;

/**
 * 把任意数值收进合法区间；非有限值（NaN / ±Infinity）回落到 `FONT_SCALE_DEFAULT`。
 *
 * 非法值回落到 **1.0** 而不是区间端点，是刻意的：一个坏偏好不该让用户看到
 * 「字突然变得很大或很小」——那会被当成新版本改坏了排版，而 1.0 是「什么都没发生」。
 */
export function normalizeFontScale(value: number): number {
  if (!isFiniteNumber(value)) {
    return FONT_SCALE_DEFAULT;
  }
  if (value < FONT_SCALE_MIN) {
    return FONT_SCALE_MIN;
  }
  if (value > FONT_SCALE_MAX) {
    return FONT_SCALE_MAX;
  }
  return value;
}

function isFiniteNumber(value: number): boolean {
  return value === value && value !== Infinity && value !== -Infinity;
}

/**
 * 实际生效的倍数。
 *
 * 勾了「跟随系统」就固定返回 1.0（= 应用这层不做任何缩放，系统那份由平台自己乘）。
 * 这一条与源工程 `effectiveFontScale()` 逐字对应，也是「跟随系统」这个开关的全部意义：
 * 它不是一个额外的乘数，而是**关掉应用这一层**。
 */
export function effectiveFontScale(scale: number, followsSystem: boolean): number {
  return followsSystem ? FONT_SCALE_DEFAULT : normalizeFontScale(scale);
}

/**
 * 显示用的倍数文案：**固定一位小数**。
 *
 * 固定用不带区域的格式化（`1.0`／`1.2`），与本工程既定的「数字一律用点号」一致：
 * 某些区域用逗号作小数点，「1,2×」看着像笔误（源工程为此专门锁了 US locale）。
 */
export function formatFontScale(value: number): string {
  const normalized: number = normalizeFontScale(value);
  // 先放大 10 倍取整再还原，避开 ArkTS 的 `toFixed` 与浮点误差（1.05 → "1.1" 这类）。
  const tenths: number = Math.round(normalized * 10);
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}
