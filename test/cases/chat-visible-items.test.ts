import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatDisplayItem, ChatItemKind } from '../../entry/src/main/ets/core/ChatPresentation.ts';
import { ChatHistory } from '../../entry/src/main/ets/core/ModelsEvents.ts';
import { visibleHistoryItems, visibleItemsOf } from '../../entry/src/main/ets/core/ChatVisibleItems.ts';

/**
 * 历史可见项过滤的测试 —— 逐条对应原工程 `ChatVisibleItemsTest.kt`。
 *
 * 为什么值得测：「思考不进消息流」这条口径以前只活在内联代码里，靠肉眼守。
 * 它错了在真机上表现为「会话里突然多出一堆灰色思考块」——不难看，但会让正文
 * 被挤得七零八落（正是这条过滤当初存在的理由），而且没人会以为是 bug。
 */

function item(id: string, kind: ChatItemKind): ChatDisplayItem {
  return new ChatDisplayItem(id, 1, kind);
}

test('思考永不显示（开关开着也不显示 —— 它由底部思考条承载）', () => {
  const items: ChatDisplayItem[] = [
    item('u', ChatItemKind.USER),
    item('r', ChatItemKind.REASONING),
    item('a', ChatItemKind.ASSISTANT),
  ];
  assert.deepEqual(
    visibleItemsOf(items, true).map((i: ChatDisplayItem): string => i.id), ['u', 'a']);
  assert.deepEqual(
    visibleItemsOf(items, false).map((i: ChatDisplayItem): string => i.id), ['u', 'a']);
});

test('上下文注入按开关显示', () => {
  const items: ChatDisplayItem[] = [
    item('c', ChatItemKind.CONTEXT),
    item('a', ChatItemKind.ASSISTANT),
  ];
  assert.deepEqual(
    visibleItemsOf(items, false).map((i: ChatDisplayItem): string => i.id), ['a']);
  assert.deepEqual(
    visibleItemsOf(items, true).map((i: ChatDisplayItem): string => i.id), ['c', 'a']);
});

test('顺序保持（过滤不重排 —— 重排会让时间线错位）', () => {
  const items: ChatDisplayItem[] = [
    item('a1', ChatItemKind.ASSISTANT),
    item('r1', ChatItemKind.REASONING),
    item('t1', ChatItemKind.TOOL),
    item('c1', ChatItemKind.CONTEXT),
    item('a2', ChatItemKind.ASSISTANT),
  ];
  assert.deepEqual(
    visibleItemsOf(items, true).map((i: ChatDisplayItem): string => i.id), ['a1', 't1', 'c1', 'a2']);
  assert.deepEqual(
    visibleItemsOf(items, false).map((i: ChatDisplayItem): string => i.id), ['a1', 't1', 'a2']);
});

test('空表进空表出（没有 history 时不抛错）', () => {
  assert.deepEqual(visibleItemsOf([], true), []);
  assert.deepEqual(visibleItemsOf([], false), []);
});

test('history 为 null（还没加载）→ 空表', () => {
  assert.deepEqual(visibleHistoryItems(null, true), []);
  assert.deepEqual(visibleHistoryItems(null, false), []);
});

test('空 history → 空表', () => {
  assert.deepEqual(visibleHistoryItems(new ChatHistory(), false), []);
});
