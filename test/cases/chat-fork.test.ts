import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatDisplayItem, ChatItemKind } from '../../entry/src/main/ets/core/ChatPresentation.ts';
import { forkPointOf } from '../../entry/src/main/ets/core/ChatFork.ts';

/**
 * 消息级分叉点判据的测试 —— 逐条对应原工程 `ChatForkPointTest.kt`。
 *
 * 为什么值得单独测：这条判据错了，真机上只表现为「某几条消息莫名多/少一个按钮」，
 * 当场看不出是哪一步错的；而少一个按钮时用户根本不知道那里本该有东西。
 */

function item(kind: ChatItemKind, seq: number): ChatDisplayItem {
  return new ChatDisplayItem('x', seq, kind);
}

test('用户消息且 seq > 0 → 给分叉点（返回值就是这条的 seq）', () => {
  assert.equal(forkPointOf(item(ChatItemKind.USER, 7)), 7);
});

test('助手消息不给分叉点 —— 分叉的真实场景总是「这次提问的走向不对」', () => {
  assert.equal(forkPointOf(item(ChatItemKind.ASSISTANT, 7)), null);
});

test('工具 / 上下文 / 思考行都不给分叉点', () => {
  assert.equal(forkPointOf(item(ChatItemKind.TOOL, 7)), null);
  assert.equal(forkPointOf(item(ChatItemKind.CONTEXT, 7)), null);
  assert.equal(forkPointOf(item(ChatItemKind.REASONING, 7)), null);
});

test('seq = 0 不给分叉点：0 不是内核认识的事件序号（流式项与本地占位项）', () => {
  assert.equal(forkPointOf(item(ChatItemKind.USER, 0)), null);
});

test('seq < 0 也不给 —— 判据是 > 0 而不是 != 0', () => {
  assert.equal(forkPointOf(item(ChatItemKind.USER, -1)), null);
});

test('失败行不给分叉点（它是终局提示，不是可重来的一步）', () => {
  assert.equal(forkPointOf(item(ChatItemKind.FAILURE, 7)), null);
});
