import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatItemKind, LiveChatBlock } from '../../entry/src/main/ets/core/ChatPresentation.ts';
import { liveThinkingText, thinkBarText } from '../../entry/src/main/ets/core/ChatThinkBar.ts';

/**
 * 思考条两个纯函数的测试 —— 逐条对应原工程 `ChatThinkBarTest.kt`。
 *
 * 为什么值得单独测：原来流式思考是消息流里的一行活动块，改成底部固定一条之后，
 * 「取哪一段」和「怎么截断」都成了看不见的规则 —— 界面上只有一行字，边界全在代码里。
 * 少截一段只是「看着有点长」，**取了开头而不是结尾**才会露馅。
 */

function block(index: number, kind: ChatItemKind, text: string): LiveChatBlock {
  return new LiveChatBlock(index, kind, text);
}

// ── liveThinkingText：只认流式的 REASONING ──

test('思考条只取 REASONING 块，正文与工具调用都不进', () => {
  const blocks: LiveChatBlock[] = [
    block(0, ChatItemKind.REASONING, '先看一眼'),
    block(1, ChatItemKind.ASSISTANT, '这是正文，不该进思考条'),
    block(2, ChatItemKind.TOOL, '工具调用'),
    block(3, ChatItemKind.REASONING, '再确认一下'),
  ];
  assert.equal(liveThinkingText(blocks), '先看一眼 再确认一下');
});

test('没有思考时是空串（界面靠它整条隐藏）', () => {
  assert.equal(liveThinkingText([]), '');
  assert.equal(liveThinkingText([block(0, ChatItemKind.ASSISTANT, '只有正文')]), '');
});

test('顺序按 blocks 原顺序，不按 index 重排', () => {
  // index 是流式分块号，不是显示序。
  const blocks: LiveChatBlock[] = [
    block(7, ChatItemKind.REASONING, '乙'),
    block(2, ChatItemKind.REASONING, '甲'),
  ];
  assert.equal(liveThinkingText(blocks), '乙 甲');
});

// ── thinkBarText：折空白 + 留尾部 ──

test('全空白的思考渲染成空串（不留一条空白条）', () => {
  assert.equal(thinkBarText(''), '');
  assert.equal(thinkBarText('   '), '');
  assert.equal(thinkBarText('\n\n\t '), '');
});

test('连续空白折成单个空格', () => {
  assert.equal(thinkBarText('  正在\n\n想   什么\t'), '正在 想 什么');
});

test('短思考原样保留', () => {
  const text = '检查一下 roots 解析';
  assert.equal(thinkBarText(text), text);
});

test('恰好等于上限时不截断', () => {
  // 边界按网页版的 `t.length > 140` 取：**等于**上限不截。
  const text = 'x'.repeat(140);
  assert.equal(thinkBarText(text), text);
  assert.equal(thinkBarText(text).length, 140);
});

test('超长时留尾部而不是头部', () => {
  const text = `很久以前说的第一句${'b'.repeat(200)}`;
  const result = thinkBarText(text);
  assert.ok(result.startsWith('…'));
  assert.ok(!result.includes('很久以前说的第一句'));
  assert.equal(result, `…${text.slice(-140)}`);
});

test('默认上限就是 140', () => {
  const text = 'c'.repeat(200);
  assert.equal(thinkBarText(text), `…${text.slice(-140)}`);
  assert.equal(thinkBarText(text).length, 141);
});

test('自定义上限生效', () => {
  const text = '0123456789';
  assert.equal(thinkBarText(text, 3), '…789');
  assert.equal(thinkBarText(text, 10), text);
});

test('先折空白再截尾（顺序不能颠倒）', () => {
  // 顺序反了的话，截出来的尾部会是一堆换行，看起来像思考条空了。
  const text = `头${'\n'.repeat(50)}尾`;
  assert.equal(thinkBarText(text, 10), '头 尾');
});

// ── 与源工程的两处分歧，钉在这里免得日后被「顺手统一」 ──

test('全角空格与不换行空格不被折叠（源工程用 Java 正则，不是 JS 的 \\s）', () => {
  // Kotlin 的 Regex("\\s+") 不开 UNICODE_CHARACTER_CLASS，U+3000 / U+00A0 都不算空白。
  // 若照 JS 的 /\s+/ 写会把它们折成普通空格 —— 那是与源工程不同的行为。
  assert.equal(thinkBarText('想\u3000什么'), '想\u3000什么');
  assert.equal(thinkBarText('想\u00A0什么'), '想\u00A0什么');
  // 但首尾裁剪用的是宽集（Kotlin trim() 走 isWhitespace()，含 Zs 类），所以首尾的会被剪掉。
  assert.equal(thinkBarText('\u3000想什么\u3000'), '想什么');
});

test('U+FEFF 不算空白：既不被折叠也不被裁掉', () => {
  // JS 的 String.prototype.trim() 会把 U+FEFF 剪掉，而 Kotlin 不会 —— 这里必须自己裁。
  assert.equal(thinkBarText('\uFEFF想什么'), '\uFEFF想什么');
  assert.equal(thinkBarText('想什么\uFEFF'), '想什么\uFEFF');
});

// ── 两条规则串起来 ──

test('流式思考接成一行后再折空白＋截尾', () => {
  const blocks: LiveChatBlock[] = [
    block(0, ChatItemKind.REASONING, '第一步\n\n想清楚了'),
    block(1, ChatItemKind.REASONING, '   第二步接着想  '),
  ];
  assert.equal(thinkBarText(liveThinkingText(blocks)), '第一步 想清楚了 第二步接着想');
});
