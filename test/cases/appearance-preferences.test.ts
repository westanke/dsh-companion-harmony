import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FONT_SCALE_DEFAULT, FONT_SCALE_MAX, FONT_SCALE_MIN, effectiveFontScale, formatFontScale, normalizeFontScale,
} from '../../entry/src/main/ets/core/FontScale.ts';
import {
  THEME_MODE_DARK, THEME_MODE_LIGHT, THEME_MODE_SYSTEM, normalizeThemeMode,
} from '../../entry/src/main/ets/core/ThemeMode.ts';
import { AppPreferences } from '../../entry/src/main/ets/core/AppPreferences.ts';
import { KeyValueStore } from '../../entry/src/main/ets/core/HostStore.ts';

/**
 * 外观设置（字号缩放 + 主题三档）的纯逻辑回归 —— 对位源工程 `AppearancePreferencesTest.kt`。
 *
 * ## 为什么这几条值得单测
 *
 * 它们都是**取错值不会崩、只会悄悄难看**的地方：NaN 字号让整个界面白屏（不崩、无日志）、
 * 「跟随系统」写反导致双重放大、主题档位认不出时深浅色悄悄互换。这类问题在真机上只能靠
 * 「用户截图 + 我们猜」才能定位，而它们本质上是纯函数 —— 一条断言就能钉死。
 *
 * ## 与源工程的一处有意差异
 *
 * 源工程用 `enum InterfaceStyle` 的**名字**落盘（曾经按 ordinal 存，升级后深浅色互换，
 * 才改成存名字）；本工程直接存**线上取值** `'system'`/`'light'`/`'dark'`（`ThemeMode.ts`
 * 的口径：不做 enum ↔ 字符串转换）。两者**对升级安全这一点是同一个结论** —— 存的都是名字，
 * 改名不会让老数据错位。故断言写成「存的就是那个字符串」，而不是「枚举序数」。
 */

class MemoryStore implements KeyValueStore {
  readonly map: Map<string, string> = new Map();

  getString(key: string): string | null {
    return this.map.has(key) ? this.map.get(key) as string : null;
  }

  putString(key: string, value: string | null): void {
    if (value === null) {
      this.map.delete(key);
    } else {
      this.map.set(key, value);
    }
  }

  remove(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

// ——— normalizeFontScale：偏好层的兜底 ———

test('字号上限被收敛到 1.5', () => {
  assert.equal(normalizeFontScale(2.0), FONT_SCALE_MAX);
  assert.equal(normalizeFontScale(1.5), 1.5);
});

test('字号下限被收敛到 0.8', () => {
  assert.equal(normalizeFontScale(0.2), FONT_SCALE_MIN);
  assert.equal(normalizeFontScale(0.8), 0.8);
});

test('区间内的字号原样保留', () => {
  assert.equal(normalizeFontScale(1.0), 1.0);
  assert.equal(normalizeFontScale(1.3), 1.3);
});

test('非法字号（NaN / ±Infinity）回落到 1.0 而不是区间端点', () => {
  // 白屏防线：坏值若以 NaN 尺寸测量整个界面，会「不崩、没日志、什么都不显示」。
  // 回落到区间端点会把「读坏了」伪装成「用户就是要最大 / 最小字号」，所以只能回落到 1.0。
  assert.equal(normalizeFontScale(Number.NaN), FONT_SCALE_DEFAULT);
  assert.equal(normalizeFontScale(Number.POSITIVE_INFINITY), FONT_SCALE_DEFAULT);
  assert.equal(normalizeFontScale(Number.NEGATIVE_INFINITY), FONT_SCALE_DEFAULT);
});

// ——— effectiveFontScale：界面真正读的那一个值 ———

test('勾选跟随系统时生效字号是 1.0（应用这层不做任何缩放）', () => {
  assert.equal(effectiveFontScale(1.4, true), FONT_SCALE_DEFAULT);
});

test('未勾选时生效字号就是偏好值（且仍会被归一）', () => {
  assert.equal(effectiveFontScale(1.4, false), 1.4);
  assert.equal(effectiveFontScale(9.0, false), FONT_SCALE_MAX, '越界值即便在生效路径上也要收敛');
});

// ——— formatFontScale：固定一位小数、不带区域 ———

test('字号文案固定一位小数，且用点号作小数点', () => {
  // 某些区域用逗号作小数点，「1,2×」看着像笔误 —— 所以不走区域格式化。
  assert.equal(formatFontScale(1.0), '1.0');
  assert.equal(formatFontScale(1.5), '1.5');
  assert.equal(formatFontScale(0.8), '0.8');
});

test('字号文案对坏值走同一条兜底', () => {
  assert.equal(formatFontScale(Number.NaN), '1.0');
});

// ——— normalizeThemeMode：三档的判据 ———

test('主题档位：认得的取值原样保留', () => {
  assert.equal(normalizeThemeMode(THEME_MODE_SYSTEM), THEME_MODE_SYSTEM);
  assert.equal(normalizeThemeMode(THEME_MODE_LIGHT), THEME_MODE_LIGHT);
  assert.equal(normalizeThemeMode(THEME_MODE_DARK), THEME_MODE_DARK);
});

test('主题档位：缺失或认不出一律回落「跟随系统」', () => {
  // 回落「跟随系统」而不是「浅色」：认不出通常意味着偏好写坏了或来自未来版本，
  // 此时交还给平台最不容易让人误以为「这个 App 变样了」。
  assert.equal(normalizeThemeMode(null), THEME_MODE_SYSTEM);
  assert.equal(normalizeThemeMode('garbage'), THEME_MODE_SYSTEM);
  assert.equal(normalizeThemeMode('SYSTEM'), THEME_MODE_SYSTEM, '大写枚举名（旧形态）不认，回落跟随系统');
});

// ——— 偏好读写往返 ———

test('主题档位：默认跟随系统，读写往返，坏值不落盘', () => {
  const store = new MemoryStore();
  const prefs = new AppPreferences(store);
  assert.equal(prefs.themeMode, THEME_MODE_SYSTEM, '默认跟随系统');

  prefs.themeMode = THEME_MODE_DARK;
  assert.equal(store.getString('theme_mode'), THEME_MODE_DARK, '存的就是线上取值本身，不做枚举转换');
  assert.equal(prefs.themeMode, THEME_MODE_DARK);

  // 写入非法值时按「跟随系统」落盘，不留垃圾在偏好里。
  prefs.themeMode = 'nonsense';
  assert.equal(store.getString('theme_mode'), THEME_MODE_SYSTEM);
  assert.equal(prefs.themeMode, THEME_MODE_SYSTEM);
});

test('字号偏好：默认 1.0、跟随系统默认开、坏值读回 1.0', () => {
  const store = new MemoryStore();
  const prefs = new AppPreferences(store);
  assert.equal(prefs.fontScale, FONT_SCALE_DEFAULT);
  // 默认跟随系统 = true（与源工程相反，且是刻意的）：不该擅自把用户调大的系统字号缩回去。
  assert.equal(prefs.fontFollowsSystem, true);

  prefs.fontScale = 1.2;
  assert.equal(prefs.fontScale, 1.2);

  // 坏值：读出来是 NaN 也要落到 1.0，绝不把坏值送进尺寸测量。
  store.putString('font_scale', 'not-a-number');
  assert.equal(prefs.fontScale, FONT_SCALE_DEFAULT);

  prefs.fontScale = 9.0;
  assert.equal(prefs.fontScale, FONT_SCALE_MAX, '写入越界值也按区间收敛后落盘');
});

test('偏好独立命名空间：不同 store 实例互不串味', () => {
  const a = new AppPreferences(new MemoryStore());
  const b = new AppPreferences(new MemoryStore());
  a.themeMode = THEME_MODE_DARK;
  a.fontFollowsSystem = false;
  assert.equal(a.themeMode, THEME_MODE_DARK);
  assert.equal(a.fontFollowsSystem, false);
  assert.equal(b.themeMode, THEME_MODE_SYSTEM);
  assert.equal(b.fontFollowsSystem, true);
});
