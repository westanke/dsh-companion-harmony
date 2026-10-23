/**
 * 配色主题四套 × 明暗两份色板 —— 对位 Android 源工程 `ui/theme/ThemePalettes.kt`。
 *
 * 四套：`paper`（默认）/ `warm` / `mist` / `ink`，与深浅模式正交、实时生效。
 *
 * ## 设计纪律
 *
 * - **默认 PAPER 逐字段等于旧配色**：PAPER 浅色导航栏 `#FFFFFFFF`、深色 `#FF000000`，
 *   与 `EntryAbility.applyNavBarTheme` 此前硬编码值完全一致 —— 不切换时像素级零变化。
 *   PAPER 的页面背景（`pageBg`）为 `null`，含义是「回落系统默认背景资源」，
 *   同样是为了默认外观零漂移（系统背景色随版本可能微调，硬编码 hex 反而会漂移）。
 * - **存 name 不存 ordinal**（与 `ThemeMode.ts` 同一纪律）：升级安全。
 * - **纯函数、可 node 单测**：不碰平台 API。
 *
 * 色板覆盖两处消费：`navBarBg`/`navBarContent` 给系统导航栏（EntryAbility 直接消费），
 * `pageBg` 给 App 页面背景（`ui/AppRuntime.themedPageBgColor` 消费）。
 * 其余系统色（`sys.color.ohos_id_color_*`）由鸿蒙深浅模式自动控制，不在此处管理。
 */

/** 默认 —— 逐字段等于旧配色（导航栏白/黑）。 */
export const THEME_PALETTE_PAPER: string = 'paper';
/** 暖米。 */
export const THEME_PALETTE_WARM: string = 'warm';
/** 青灰。 */
export const THEME_PALETTE_MIST: string = 'mist';
/** 高对比。 */
export const THEME_PALETTE_INK: string = 'ink';

/**
 * 通用功能性色（不随主题变化）—— 收口散落的硬编码 hex。
 * 图片查看器等全屏遮罩场景使用。
 */
export const OVERLAY_MASK_DARK: string = '#66000000';   // 半透明黑（遮罩按钮背景）
export const OVERLAY_MASK_LIGHT: string = '#33FFFFFF';  // 半透明白（保存按钮背景）

const ALL_PALETTE_NAMES: string[] = [
  THEME_PALETTE_PAPER, THEME_PALETTE_WARM, THEME_PALETTE_MIST, THEME_PALETTE_INK,
];

/** 一套主题 × 一色阶的关键色。覆盖系统导航栏 + App 页面背景，后续按需扩。 */
export class ThemePalette {
  /** 导航栏背景。 */
  readonly navBarBg: string;
  /** 导航栏图标/文字颜色。 */
  readonly navBarContent: string;
  /**
   * 页面背景。`null` 表示「回落系统默认背景资源」（仅 PAPER —— 默认外观零漂移纪律，
   * 见文件头）。非 PAPER 配色必须与 `navBarBg` 同值：手势导航模式下系统不渲染
   * 导航条底色（真机实测恒白），页面底色与导航条同色才能让配色真正「看得见」，
   * 且三键导航设备上页面与导航条无缝衔接。
   */
  readonly pageBg: string | null;

  constructor(navBarBg: string, navBarContent: string, pageBg: string | null) {
    this.navBarBg = navBarBg;
    this.navBarContent = navBarContent;
    this.pageBg = pageBg;
  }
}

// ——— PAPER（默认）—— 与旧配色像素级一致；页面背景回落系统默认（null）——
const PAPER_LIGHT: ThemePalette = new ThemePalette('#FFFFFFFF', '#FF000000', null);
const PAPER_DARK: ThemePalette = new ThemePalette('#FF000000', '#FFFFFFFF', null);

// ——— WARM（暖米）—— 米色底，页面与导航栏同色 ——
const WARM_LIGHT: ThemePalette = new ThemePalette('#FFF5E8F0', '#FF4A2E2A', '#FFF5E8F0');
const WARM_DARK: ThemePalette = new ThemePalette('#FF2A1E18', '#FFF5E8F0', '#FF2A1E18');

// ——— MIST（青灰）—— 淡青底，页面与导航栏同色 ——
const MIST_LIGHT: ThemePalette = new ThemePalette('#FFEAF2F4', '#FF2E4A54', '#FFEAF2F4');
const MIST_DARK: ThemePalette = new ThemePalette('#FF1A2A30', '#FFEAF2F4', '#FF1A2A30');

// ——— INK（高对比）—— 纯白/近黑整页 + 高饱和图标色 ——
const INK_LIGHT: ThemePalette = new ThemePalette('#FFFFFFFF', '#FF000000', '#FFFFFFFF');
const INK_DARK: ThemePalette = new ThemePalette('#FF0D0D0D', '#FFE6E6E6', '#FF0D0D0D');

const PALETTES_LIGHT: Map<string, ThemePalette> = new Map([
  [THEME_PALETTE_PAPER, PAPER_LIGHT],
  [THEME_PALETTE_WARM, WARM_LIGHT],
  [THEME_PALETTE_MIST, MIST_LIGHT],
  [THEME_PALETTE_INK, INK_LIGHT],
]);

const PALETTES_DARK: Map<string, ThemePalette> = new Map([
  [THEME_PALETTE_PAPER, PAPER_DARK],
  [THEME_PALETTE_WARM, WARM_DARK],
  [THEME_PALETTE_MIST, MIST_DARK],
  [THEME_PALETTE_INK, INK_DARK],
]);

/**
 * 认不出的取值一律回落 `paper`（默认）。
 *
 * 与 `ThemeMode.normalizeThemeMode` 回落 `system` 不同 —— 主题配色回落默认 PAPER，
 * 因为配色是**装饰性**偏好，跟系统深浅色正交，不能把「系统的」当作默认配色。
 */
export function normalizePaletteName(value: string | null): string {
  if (value === null) {
    return THEME_PALETTE_PAPER;
  }
  return ALL_PALETTE_NAMES.includes(value) ? value : THEME_PALETTE_PAPER;
}

/** 返回四套主题名（用于设置页枚举）。 */
export function allPaletteNames(): string[] {
  return ALL_PALETTE_NAMES.slice();
}

/**
 * 取一套主题 × 一色阶的关键色。
 *
 * @param name 主题名（见 THEME_PALETTE_* 常量）。
 * @param isDark 是否深色阶。
 * @param fallback 主题名无效时的回落 —— 给 null 则默认 PAPER（等价于 normalizePaletteName 结果）。
 */
export function getPalette(name: string, isDark: boolean, fallback?: string | null): ThemePalette {
  const validName: string = normalizePaletteName(fallback !== undefined && fallback !== null
    ? fallback : name);
  // normalizePaletteName 已保证 validName 在 ALL_PALETTE_NAMES 内，
  // Map 取值不会是 undefined —— 类型断言是机械的。
  const map: Map<string, ThemePalette> = isDark ? PALETTES_DARK : PALETTES_LIGHT;
  const palette: ThemePalette | undefined = map.get(validName);
  // 防御：万一后续有人扩主题但漏了某色阶的条目，fallback 到 PAPER。
  return palette !== undefined ? palette : (isDark ? PAPER_DARK : PAPER_LIGHT);
}

// ——— WCAG 2.1 对比度纯函数 ———

/**
 * 把十六进制颜色字符串（`#AARRGGBB` 或 `#RRGGBB`）解析成 RGB（0-255）。
 *
 * 透明通道（AA）忽略——对比度只看 RGB。
 * 解析失败返回 null（不抛异常）。
 */
export function parseHexColor(hex: string): { r: number; g: number; b: number } | null {
  let s: string = hex.trim();
  if (!s.startsWith('#')) {
    return null;
  }
  s = s.substring(1);
  if (s.length === 8) {
    // #AARRGGBB → 剥 AA
    s = s.substring(2);
  }
  if (s.length !== 6) {
    return null;
  }
  const r: number = parseInt(s.substring(0, 2), 16);
  const g: number = parseInt(s.substring(2, 4), 16);
  const b: number = parseInt(s.substring(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) {
    return null;
  }
  return { r, g, b };
}

/**
 * WCAG 2.1 相对亮度（luminance）。
 *
 * 公式：
 *   - 通道归一化 c = channel / 255
 *   - c ≤ 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ^ 2.4
 *   - L = 0.2126 * R + 0.7152 * G + 0.0722 * B
 */
export function relativeLuminance(r: number, g: number, b: number): number {
  const csrgb: number[] = [r, g, b].map((c: number): number => {
    const v: number = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * csrgb[0] + 0.7152 * csrgb[1] + 0.0722 * csrgb[2];
}

/**
 * WCAG 2.1 对比度比值（前景色 vs 背景色）。
 *
 * 公式：(L1 + 0.05) / (L2 + 0.05)，其中 L1 是较亮的一方。
 *
 * @param foreground 前景色（正文/图标）hex。
 * @param background 背景色 hex。
 * @returns 对比度比值，范围 [1, 21]。解析失败返回 0。
 */
export function contrastRatio(foreground: string, background: string): number {
  const fg = parseHexColor(foreground);
  const bg = parseHexColor(background);
  if (fg === null || bg === null) {
    return 0;
  }
  const lFg: number = relativeLuminance(fg.r, fg.g, fg.b);
  const lBg: number = relativeLuminance(bg.r, bg.g, bg.b);
  const lighter: number = Math.max(lFg, lBg);
  const darker: number = Math.min(lFg, lBg);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG 阈值：正文/图标 ≥ 4.5:1（AA）。 */
export const WCAG_AA_NORMAL: number = 4.5;
/** WCAG 阈值：大文字 ≥ 3:1（AA）。 */
export const WCAG_AA_LARGE: number = 3.0;

/** 检查四套色板的关键色对（导航栏背景 vs 图标）是否都达 WCAG AA 正文阈值。 */
export function allPalettesPassAa(): { pass: boolean; failures: string[] } {
  const failures: string[] = [];
  for (const name of ALL_PALETTE_NAMES) {
    for (const isDark of [false, true]) {
      const p: ThemePalette = getPalette(name, isDark);
      const ratio: number = contrastRatio(p.navBarContent, p.navBarBg);
      if (ratio < WCAG_AA_NORMAL) {
        failures.push(`${name} ${isDark ? 'dark' : 'light'}: navBarContent vs navBarBg = ${ratio.toFixed(2)} < ${WCAG_AA_NORMAL}`);
      }
    }
  }
  return { pass: failures.length === 0, failures };
}
