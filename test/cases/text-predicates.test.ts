import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isBlank, isKotlinWhitespace, isNotBlank, trimChar, trimEndChar, trimStartChar, trimText,
} from '../../entry/src/main/ets/core/TextPredicates.ts';

/**
 * Kotlin 文本语义复刻的测试。
 *
 * 重点全是**与 JS 自带行为的差异**：`\s` 把 U+FEFF 当空白而 Kotlin 不当；
 * `String.trim()` 与 Kotlin `trim()` 的字符集也不同（差值同样只在 U+FEFF）。
 * 这些差异不看代码是发现不了的，所以必须钉住。
 */

test('空白判定：Kotlin 认的空白字符都认', () => {
  const yes = ['\t', '\n', '\u000B', '\f', '\r', '\u001C', '\u001F', ' ', '\u00A0', '\u1680',
    '\u2000', '\u2007', '\u200A', '\u2028', '\u2029', '\u202F', '\u205F', '\u3000'];
  for (const ch of yes) {
    assert.equal(isKotlinWhitespace(ch), true, `应算空白: U+${ch.charCodeAt(0).toString(16)}`);
  }
});

test('空白判定：U+FEFF 与普通字符都不算空白（这是与 JS `\\s` 的唯一差异）', () => {
  assert.equal(isKotlinWhitespace('\uFEFF'), false);
  assert.equal(isKotlinWhitespace('a'), false);
  assert.equal(isKotlinWhitespace('\u200B'), false); // 零宽空格（Cf 类别）
  assert.equal(isKotlinWhitespace('中'), false);
});

test('空白判定：空串返回 false，不抛异常', () => {
  assert.equal(isKotlinWhitespace(''), false);
});

test('isBlank：空串、全空白串为真，含任意非空白字符为假', () => {
  assert.equal(isBlank(''), true);
  assert.equal(isBlank(' \t\n\u00A0\u3000'), true);
  assert.equal(isBlank('\uFEFF'), false); // 只含 BOM：Kotlin 认为有内容
  assert.equal(isBlank(' a '), false);
});

test('isNotBlank 与 isBlank 互为反义', () => {
  const samples = ['', ' ', 'a', '\uFEFF', '\u00A0', ' 中 ', 'x\uFEFF'];
  for (const s of samples) {
    assert.equal(isNotBlank(s), !isBlank(s), `样本: ${JSON.stringify(s)}`);
  }
});

test('trimText 只去首尾，不动中间', () => {
  assert.equal(trimText('  a b  '), 'a b');
  assert.equal(trimText('\u3000x\u3000'), 'x');
  assert.equal(trimText('a'), 'a');
  assert.equal(trimText('   '), '');
  assert.equal(trimText(''), '');
});

test('trimText 不去 U+FEFF（与 JS trim() 不同）', () => {
  assert.equal(trimText('\uFEFFa\uFEFF'), '\uFEFFa\uFEFF');
});

test('trimStartChar / trimEndChar 只按指定字符裁剪，不按空白', () => {
  assert.equal(trimStartChar('//a//', '/'), 'a//');
  assert.equal(trimEndChar('//a//', '/'), '//a');
  assert.equal(trimChar('//a//', '/'), 'a');
  // 指定字符时不再按空白判定：空格原样保留。
  assert.equal(trimChar('  /a/  ', '/'), '  /a/  ');
  // 全是目标字符时被裁成空串。
  assert.equal(trimChar('///', '/'), '');
  assert.equal(trimEndChar('abc', '/'), 'abc');
});
