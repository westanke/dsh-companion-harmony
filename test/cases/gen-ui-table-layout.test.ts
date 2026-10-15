import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GENUI_TABLE_MIN_COLUMN_WIDTH_VP, genUiTableColumnWidthVp,
} from '../../entry/src/main/ets/core/GenUiBlocks.ts';
import {
  sessionFileSizeText,
} from '../../entry/src/main/ets/core/FileFormat.ts';

/**
 * 卡片内表格列宽的纯函数测试 —— 逐条对应原工程 `GenUiTableLayoutTest.kt`。
 *
 * 规则照抄网页版：装得下就铺满卡片，装不下就退回下限、交给外层横向滚。
 * 这条规则在界面上看不出来：算错了只是「表格右边空一块」，或者
 * 「该滚的时候滚不动、列被压得只剩两个字」，肉眼很容易放过。
 */

test('装得下时按列等分铺满可用宽度', () => {
  // 3 列 / 360vp：一列 120vp，总宽正好等于卡片宽度 —— 不该出现横向滚动。
  assert.equal(genUiTableColumnWidthVp(360, 3), 120);
});

test('正好卡在下限时不溢出', () => {
  // 4 列 / 384vp：等分恰好等于下限，取等分（总宽 == 可用宽度），刚好不需要滚。
  assert.equal(genUiTableColumnWidthVp(GENUI_TABLE_MIN_COLUMN_WIDTH_VP * 4, 4),
    GENUI_TABLE_MIN_COLUMN_WIDTH_VP);
});

test('装不下时退回下限，总宽超出卡片交给外层滚', () => {
  // 7 列 / 360vp：等分只有 51.4vp，一列放不下两个字，改用下限。
  const width = genUiTableColumnWidthVp(360, 7);
  assert.equal(width, GENUI_TABLE_MIN_COLUMN_WIDTH_VP);
  assert.ok(width * 7 > 360, '总宽必须超出卡片宽度，否则外层横向滚动就是摆设');
});

test('列数非法或宽度不可用时退回下限', () => {
  // 父级给无界约束时会拿到 Infinity —— 直接除会得到 Infinity 或 0，整张表会消失。
  assert.equal(genUiTableColumnWidthVp(Number.POSITIVE_INFINITY, 2), GENUI_TABLE_MIN_COLUMN_WIDTH_VP);
  assert.equal(genUiTableColumnWidthVp(Number.NaN, 2), GENUI_TABLE_MIN_COLUMN_WIDTH_VP);
  assert.equal(genUiTableColumnWidthVp(0, 2), GENUI_TABLE_MIN_COLUMN_WIDTH_VP);
  assert.equal(genUiTableColumnWidthVp(-100, 2), GENUI_TABLE_MIN_COLUMN_WIDTH_VP);
  assert.equal(genUiTableColumnWidthVp(360, 0), GENUI_TABLE_MIN_COLUMN_WIDTH_VP);
  assert.equal(genUiTableColumnWidthVp(360, -1), GENUI_TABLE_MIN_COLUMN_WIDTH_VP);
});

/**
 * 会话文件面板的体积文案。
 *
 * 源工程那个 `formatFileSize` 是 ChatScreen 的私有函数、**上游没有单测**；
 * 这里补是因为它有三处容易错的边界（1024 与 1024² 的取等、十进制一位小数、没有 GB 档）。
 */
test('小于 1024 直接给字节数', () => {
  assert.equal(sessionFileSizeText(0), '0 B');
  assert.equal(sessionFileSizeText(1023), '1023 B');
});

test('1024 起进位到 KiB（取等即进位）', () => {
  assert.equal(sessionFileSizeText(1024), '1.0 KiB');
  assert.equal(sessionFileSizeText(1536), '1.5 KiB');
});

test('1024² 起进位到 MiB', () => {
  assert.equal(sessionFileSizeText(1024 * 1024 - 1), '1024.0 KiB');
  assert.equal(sessionFileSizeText(1024 * 1024), '1.0 MiB');
  assert.equal(sessionFileSizeText(1024 * 1024 * 3.5), '3.5 MiB');
});

test('没有 GB 档，超过 1024 MiB 仍用 MiB（开口分支）', () => {
  // 源工程最后一档是 else（开口的），加档时若忘了这一点，超过 1024 MiB 会掉进空白。
  assert.equal(sessionFileSizeText(1024 * 1024 * 2048), '2048.0 MiB');
});

test('小数位按四舍五入而不是截断', () => {
  // 1536 = 1.5 KiB 精确；这里试一个需要进位的：1024 * 1.06 = 1085.44 → 1.1 KiB
  assert.equal(sessionFileSizeText(1085), '1.1 KiB');
  assert.equal(sessionFileSizeText(1024 * 1.04), '1.0 KiB');
});
