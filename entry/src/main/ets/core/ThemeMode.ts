/**
 * 主题三档的取值规则 —— 对位安卓源工程 v2.2.42 的 `data/InterfaceStyle`。
 *
 * 三档：`system`（跟随系统）/ `light`（强制浅色）/ `dark`（强制深色）。
 *
 * ## 与源工程的关系
 *
 * 本工程此前只有「跟随系统」一档：鸿蒙的深浅色完全交给平台 —— `EntryAbility` 只调
 * `setColorMode(COLOR_MODE_NOT_SET)`（「不锁定、跟系统走」），并用 `onConfigurationUpdate`
 * 同步导航条颜色。那条链是对的，但**用户没有选择权** —— 系统是浅色而他就想在暗处看深色时，
 * 只能去改系统设置（会连带影响所有应用）。源工程 v2.2.42 的 Whaleness 舒适度「设置页外观
 * 选项合并」同样把样式做成了三档（`data/InterfaceStyle`），本工程据此补齐，取值口径与之一致。
 *
 * ## 取值用字符串常量而不做枚举
 *
 * 与 `ComposerSendPolicy` 的 `SEND_MODE_*` 同一口径：**线上取值（落盘值）就是真身**，
 * 不做 enum ↔ 字符串转换，少一层出错可能。
 *
 * 源工程曾按**枚举序数**落盘，升级后深浅色悄悄互换，才改成存枚举**名字**；
 * 本工程存的就是线上取值字符串，**升级安全这一点是同一个结论**。
 */

/** 跟随系统。 */
export const THEME_MODE_SYSTEM: string = 'system';
/** 强制浅色。 */
export const THEME_MODE_LIGHT: string = 'light';
/** 强制深色。 */
export const THEME_MODE_DARK: string = 'dark';

const THEME_MODES: string[] = [THEME_MODE_SYSTEM, THEME_MODE_LIGHT, THEME_MODE_DARK];

/**
 * 认不出的取值一律回落 `system`。
 *
 * 回落到「跟随系统」而不是「浅色」：认不出通常意味着偏好被写坏了或来自未来版本，
 * 此时**交还给平台**是最不容易让人误以为「这个 App 变样了」的选择。
 */
export function normalizeThemeMode(value: string | null): string {
  if (value === null) {
    return THEME_MODE_SYSTEM;
  }
  return THEME_MODES.includes(value) ? value : THEME_MODE_SYSTEM;
}
