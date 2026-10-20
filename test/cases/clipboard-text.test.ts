import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePrimaryText } from '../../entry/src/main/ets/core/ClipboardText.ts';

/**
 * 剪贴板文本归一化的测试 —— 对位的是 2026-10-20 AGC 上架驳回的真实闪退：
 *
 *   TypeError: Cannot read property length of undefined
 *     at anonymous (entry|entry|1.0.0|src/main/ets/ui/ConnectScreen.ts:993:1)
 *
 * `pasteboard.PasteData.getPrimaryText()` 声明返回 `string`，运行时却会给 `undefined`
 * （剪贴板里没有文本记录 / 没读权限 / 只拿到一条空记录），调用方紧接着写
 * `text.length > 0` → `undefined.length` 抛异常 → ArkUI 回调里的未捕获异常**杀掉整个进程**。
 *
 * 这些用例的取值刻意收进了 `undefined` / `null` / 数字 / 对象 —— 都是**类型系统放行、
 * 运行时才炸**的形态。写成 `assert.equal(x.length, 0)` 那种断言是钉不住这件事的：
 * 崩的正是「先取 length」这一步，所以这里断言的是**返回值本身是字符串**。
 */

test('正常文本：原样返回，一个字符都不改（含首尾空白与换行）', () => {
  assert.equal(normalizePrimaryText('DSH1:abcdef'), 'DSH1:abcdef');
  assert.equal(normalizePrimaryText('  两边有空格  '), '  两边有空格  ');
  assert.equal(normalizePrimaryText('\n多行\n文本\n'), '\n多行\n文本\n');
});

test('undefined 归一为空串 —— 就是真机闪退的那一支', () => {
  const raw: string = undefined as unknown as string;
  const out: string = normalizePrimaryText(raw);
  assert.equal(out, '');
  // 断言「调用方紧接着的那句」不再炸：崩的版本正是死在这一步。
  assert.doesNotThrow(() => out.length > 0);
  assert.equal(out.length, 0);
});

test('null 归一为空串', () => {
  assert.equal(normalizePrimaryText(null as unknown as string), '');
});

test('非字符串（数字 / 对象）一律当「没有文本」，不返回原值', () => {
  assert.equal(normalizePrimaryText(123 as unknown as string), '');
  assert.equal(normalizePrimaryText({} as unknown as string), '');
  assert.equal(normalizePrimaryText([] as unknown as string), '');
  assert.equal(normalizePrimaryText(true as unknown as string), '');
});

test('空串原样返回空串（空剪贴板不是异常，是正常状态）', () => {
  assert.equal(normalizePrimaryText(''), '');
});

test('只含空白 / BOM 的串算「有内容」，不在这里替调用方做内容判定', () => {
  // 归一化只负责「类型对不对」，不负责「内容算不算数」——
  // 后者是 trimText / isNotBlank 的活（见 text-predicates.test.ts）。
  assert.equal(normalizePrimaryText(' '), ' ');
  assert.equal(normalizePrimaryText('\uFEFF'), '\uFEFF');
});
