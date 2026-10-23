/**
 * ThemePalettes 纯函数用例 —— 对位 Android 源工程 `ThemePalettes.kt` 测试口径。
 *
 * 核心断言：
 * 1. 默认 PAPER 与旧配色像素级一致（导航栏白/黑）
 * 2. normalizePaletteName 对 null/未知值回落 PAPER
 * 3. getPalette 四套 × 明暗都能取到 ThemePalette，且 PAPER 浅色导航栏 = #FFFFFFFF
 * 4. 深浅正交：同一主题明暗色阶不同值
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  THEME_PALETTE_PAPER, THEME_PALETTE_WARM, THEME_PALETTE_MIST, THEME_PALETTE_INK,
  getPalette, normalizePaletteName, allPaletteNames, ThemePalette,
  parseHexColor, relativeLuminance, contrastRatio, WCAG_AA_NORMAL, WCAG_AA_LARGE, allPalettesPassAa,
} from '../../entry/src/main/ets/core/ThemePalettes';

describe('ThemePalettes', () => {

  describe('normalizePaletteName', () => {

    it('null → paper', () => {
      assert.equal(normalizePaletteName(null), THEME_PALETTE_PAPER);
    });

    it('空串 → paper', () => {
      assert.equal(normalizePaletteName(''), THEME_PALETTE_PAPER);
    });

    it('合法名返回自身', () => {
      for (const name of allPaletteNames()) {
        assert.equal(normalizePaletteName(name), name);
      }
    });

    it('未知值回落 paper（升级安全纪律）', () => {
      assert.equal(normalizePaletteName('cyberpunk'), THEME_PALETTE_PAPER);
      assert.equal(normalizePaletteName('PAPER'), THEME_PALETTE_PAPER); // 大小写敏感
      assert.equal(normalizePaletteName('  paper  '), THEME_PALETTE_PAPER); // 不含 trim
    });
  });

  describe('getPalette', () => {

    it('四套主题都能取到浅色阶', () => {
      for (const name of allPaletteNames()) {
        const p: ThemePalette = getPalette(name, false);
        assert.ok(p instanceof ThemePalette, `${name} light should be ThemePalette`);
        assert.ok(p.navBarBg.startsWith('#'), `${name} light navBarBg should be hex`);
        assert.ok(p.navBarContent.startsWith('#'), `${name} light navBarContent should be hex`);
      }
    });

    it('四套主题都能取到深色阶', () => {
      for (const name of allPaletteNames()) {
        const p: ThemePalette = getPalette(name, true);
        assert.ok(p instanceof ThemePalette, `${name} dark should be ThemePalette`);
      }
    });

    it('默认 PAPER 与旧配色像素级一致（浅色导航栏 = 白底黑图标）', () => {
      const light: ThemePalette = getPalette(THEME_PALETTE_PAPER, false);
      assert.equal(light.navBarBg, '#FFFFFFFF');      // 旧 NAV_BAR_COLOR_LIGHT
      assert.equal(light.navBarContent, '#FF000000'); // 旧 NAV_BAR_CONTENT_LIGHT
    });

    it('默认 PAPER 与旧配色像素级一致（深色导航栏 = 黑底白图标）', () => {
      const dark: ThemePalette = getPalette(THEME_PALETTE_PAPER, true);
      assert.equal(dark.navBarBg, '#FF000000');       // 旧 NAV_BAR_COLOR_DARK
      assert.equal(dark.navBarContent, '#FFFFFFFF');  // 旧 NAV_BAR_CONTENT_DARK
    });

    it('未知主题 + fallback → paper', () => {
      const p: ThemePalette = getPalette('bogus', false);
      assert.equal(p.navBarBg, '#FFFFFFFF');
    });

    it('深浅正交：同一主题明暗色阶不同值', () => {
      for (const name of allPaletteNames()) {
        const light: ThemePalette = getPalette(name, false);
        const dark: ThemePalette = getPalette(name, true);
        // PAPER 之外肯定不同；PAPER 虽然都是黑/白但反转了
        assert.notEqual(light.navBarBg, dark.navBarBg, `${name} 深浅 navBarBg 应该不同`);
        assert.notEqual(light.navBarContent, dark.navBarContent, `${name} 深浅 navBarContent 应该不同`);
      }
    });

    it('pageBg：PAPER 明暗都为 null（回落系统背景，默认外观零漂移）', () => {
      assert.equal(getPalette(THEME_PALETTE_PAPER, false).pageBg, null);
      assert.equal(getPalette(THEME_PALETTE_PAPER, true).pageBg, null);
    });

    it('pageBg：非默认配色与导航栏底色同值（页面/导航条同色才「看得见」）', () => {
      for (const name of [THEME_PALETTE_WARM, THEME_PALETTE_MIST, THEME_PALETTE_INK]) {
        for (const isDark of [false, true]) {
          const p: ThemePalette = getPalette(name, isDark);
          assert.ok(p.pageBg !== null, `${name} ${isDark ? 'dark' : 'light'} pageBg 不应为 null`);
          assert.equal(p.pageBg, p.navBarBg, `${name} pageBg 应与 navBarBg 同值`);
        }
      }
    });
  });

  describe('allPaletteNames', () => {

    it('正好四套主题', () => {
      assert.equal(allPaletteNames().length, 4);
    });

    it('顺序固定：paper → warm → mist → ink', () => {
      assert.deepEqual(allPaletteNames(), [
        THEME_PALETTE_PAPER, THEME_PALETTE_WARM, THEME_PALETTE_MIST, THEME_PALETTE_INK,
      ]);
    });

    it('返回副本不是内部引用', () => {
      const a: string[] = allPaletteNames();
      const b: string[] = allPaletteNames();
      a.push('corrupt');
      assert.equal(b.length, 4);
    });
  });

  describe('WCAG 2.1 对比度纯函数', () => {

    it('parseHexColor：#RRGGBB 正常解析', () => {
      const c = parseHexColor('#FF8800');
      assert.deepEqual(c, { r: 255, g: 136, b: 0 });
    });

    it('parseHexColor：#AARRGGBB 剥 AA', () => {
      const c = parseHexColor('#80FF8800');
      assert.deepEqual(c, { r: 255, g: 136, b: 0 });
    });

    it('parseHexColor：非 # 开头返回 null', () => {
      assert.equal(parseHexColor('FF8800'), null);
      assert.equal(parseHexColor('rgb(255,0,0)'), null);
    });

    it('parseHexColor：长度不符返回 null', () => {
      assert.equal(parseHexColor('#FFF'), null);
      assert.equal(parseHexColor('#FF'), null);
    });

    it('relativeLuminance：纯黑 = 0', () => {
      assert.equal(relativeLuminance(0, 0, 0), 0);
    });

    it('relativeLuminance：纯白 = 1', () => {
      assert.ok(Math.abs(relativeLuminance(255, 255, 255) - 1) < 1e-6);
    });

    it('contrastRatio：黑 vs 白 = 21（理论最大值）', () => {
      const r: number = contrastRatio('#FF000000', '#FFFFFFFF');
      assert.ok(Math.abs(r - 21) < 0.01, `expected 21, got ${r}`);
    });

    it('contrastRatio：前景/背景参数顺序不影响结果', () => {
      const r1: number = contrastRatio('#FF000000', '#FFFFFFFF');
      const r2: number = contrastRatio('#FFFFFFFF', '#FF000000');
      assert.equal(r1, r2);
    });

    it('contrastRatio：解析失败返回 0', () => {
      assert.equal(contrastRatio('not-a-color', '#FFFFFFFF'), 0);
    });

    it('contrastRatio：同色对比 = 1', () => {
      const r: number = contrastRatio('#FF880080', '#FF880080');
      assert.ok(Math.abs(r - 1) < 0.01, `expected ~1, got ${r}`);
    });

    it('WCAG 阈值常量：正文 ≥ 4.5 大文字 ≥ 3', () => {
      assert.equal(WCAG_AA_NORMAL, 4.5);
      assert.equal(WCAG_AA_LARGE, 3.0);
      assert.ok(WCAG_AA_NORMAL > WCAG_AA_LARGE);
    });

    it('★ 四套色板 × 明暗 导航栏图标 vs 背景 ≥ WCAG AA 正文阈值 4.5', () => {
      const { pass, failures } = allPalettesPassAa();
      assert.ok(pass, `色板对比度不达标：\n${failures.join('\n')}`);
      // 同时逐项断言，便于定位失败
      for (const name of allPaletteNames()) {
        for (const isDark of [false, true]) {
          const p = getPalette(name, isDark);
          const r: number = contrastRatio(p.navBarContent, p.navBarBg);
          assert.ok(
            r >= WCAG_AA_NORMAL,
            `${name} ${isDark ? 'dark' : 'light'} navBarContent vs navBarBg = ${r.toFixed(2)} < ${WCAG_AA_NORMAL}`,
          );
        }
      }
    });
  });
});
