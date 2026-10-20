import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatDisplayItem, ChatItemKind, displayItemsOf,
} from '../../entry/src/main/ets/core/ChatPresentation.ts';
import {
  applyTurnBoundary, isTurnMaxTokens, truncationItemsOf, truncatedItemFor,
} from '../../entry/src/main/ets/core/ChatTruncation.ts';
import { HarnessState } from '../../entry/src/main/ets/core/HarnessTypes.ts';
import {
  ChatDisplayEntry, ChatDisplayEntryKind, groupChatDisplay,
} from '../../entry/src/main/ets/core/ChatDisplayGroups.ts';
import { ChatHistory, HistoryEntry, SessionEvent, WorkspaceEvent } from '../../entry/src/main/ets/core/Models.ts';
import { JsonAccess } from '../../entry/src/main/ets/core/JsonAccess.ts';

/**
 * 「回答被截断」提示的测试 —— 移植自源工程 `ChatTurnMaxTokensTest.kt`。
 *
 * 这一条提示的坑不在渲染，而在**它从哪来**：内核发的是 `turn/end { reason: { kind: 'max-tokens' } }`
 * 而不是失败帧，且 `sessions.history` 不返回 `turn/end`。所以判据一旦写错，
 * 屏幕上的表现只有一种 —— 整条提示消失，用户只看到回答戛然而止。
 */

function entry(type: string, seq: number, dataJson: string): HistoryEntry {
  const row: HistoryEntry = new HistoryEntry();
  const event: SessionEvent = new SessionEvent();
  event.type = type;
  event.seq = seq;
  event.time = seq * 1000;
  event.data = JsonAccess.parse(dataJson);
  row.event = event;
  row.view = null;
  return row;
}

function history(events: HistoryEntry[]): ChatHistory {
  const value: ChatHistory = new ChatHistory();
  value.events = events;
  value.hasMore = false;
  value.projections = null;
  return value;
}

function wsEvent(type: string, dataJson: string): WorkspaceEvent {
  const event: WorkspaceEvent = new WorkspaceEvent();
  event.id = type;
  event.type = type;
  event.time = 1;
  event.data = JsonAccess.parse(dataJson);
  return event;
}

test('历史里的 max-tokens 收尾产出 TRUNCATED 行', () => {
  const items: ChatDisplayItem[] = displayItemsOf(history([
    entry('turn/end', 42, '{"reason":{"kind":"max-tokens"}}'),
  ]));
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, ChatItemKind.TRUNCATED);
  assert.equal(items[0].id, '42-turn-max-tokens');
  assert.equal(items[0].seq, 42);
  assert.equal(items[0].time, 42000);
});

test('截断不是失败：kind 不是 FAILURE，failure 为 null', () => {
  const items: ChatDisplayItem[] = displayItemsOf(history([
    entry('turn/end', 7, '{"reason":{"kind":"max-tokens"}}'),
  ]));
  assert.equal(items[0].kind === ChatItemKind.FAILURE, false);
  assert.equal(items[0].failure, null);
});

test('error 仍然产出 FAILURE，不被截断分支抢走', () => {
  const items: ChatDisplayItem[] = displayItemsOf(history([
    entry('turn/end', 8, '{"reason":{"kind":"error","error":{"message":"rate limited","code":"429"}}}'),
  ]));
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, ChatItemKind.FAILURE);
  assert.equal(items[0].failure?.message, 'rate limited');
  assert.equal(items[0].failure?.code, '429');
});

test('登出 aborted 仍然产出 FAILURE 且 stopped 为 true', () => {
  const items: ChatDisplayItem[] = displayItemsOf(history([
    entry('turn/end', 9,
      '{"reason":{"kind":"aborted","reason":{"kind":"hook","reason":"deepseek-account/signed-out"}}}'),
  ]));
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, ChatItemKind.FAILURE);
  assert.equal(items[0].failure?.stopped, true);
  assert.equal(items[0].failure?.code, 'ACCOUNT_SIGNED_OUT');
});

test('正常收尾（completed）不产出行', () => {
  const items: ChatDisplayItem[] = displayItemsOf(history([
    entry('turn/end', 10, '{"reason":{"kind":"completed"}}'),
  ]));
  assert.equal(items.length, 0);
});

test('TRUNCATED 不被折进过程组，独立成消息', () => {
  const context: ChatDisplayItem = new ChatDisplayItem('1-context', 1, ChatItemKind.CONTEXT, '上下文');
  const tool: ChatDisplayItem = new ChatDisplayItem('2-tool', 2, ChatItemKind.TOOL);
  const truncated: ChatDisplayItem = new ChatDisplayItem('3-turn-max-tokens', 3, ChatItemKind.TRUNCATED);
  const assistant: ChatDisplayItem = new ChatDisplayItem('4-assistant', 4, ChatItemKind.ASSISTANT, null, '正文');

  const entries: ChatDisplayEntry[] = groupChatDisplay([context, tool, truncated, assistant]);
  // 前两项折成一组，TRUNCATED 把组切断并独立成行，助手正文再独立一行。
  assert.equal(entries.length, 3);
  assert.equal(entries[0].kind, ChatDisplayEntryKind.PROCESS_GROUP);
  assert.equal(entries[1].kind, ChatDisplayEntryKind.MESSAGE);
  assert.equal(entries[1].item?.kind, ChatItemKind.TRUNCATED);
  assert.equal(entries[2].kind, ChatDisplayEntryKind.MESSAGE);
});

test('实时帧判据：只认 chat.turn.end + reason.kind === max-tokens', () => {
  assert.equal(isTurnMaxTokens(wsEvent('chat.turn.end', '{"reason":{"kind":"max-tokens"}}')), true);
  assert.equal(isTurnMaxTokens(wsEvent('chat.turn.start', '{"reason":{"kind":"max-tokens"}}')), false);
  assert.equal(isTurnMaxTokens(wsEvent('chat.turn.end', '{"reason":{"kind":"completed"}}')), false);
  assert.equal(isTurnMaxTokens(wsEvent('chat.turn.end', '{}')), false);
  assert.equal(isTurnMaxTokens(wsEvent('chat.turn.end', '{"reason":"max-tokens"}')), false);
});

test('实时截断帧落进状态，本轮开始时清掉、别的会话不动它', () => {
  const state: HarnessState = new HarnessState();

  applyTurnBoundary(state, wsEvent('chat.turn.end', '{"reason":{"kind":"max-tokens"}}'), 's1');
  assert.equal(state.truncatedNoticeSession, 's1');
  assert.equal(state.truncatedNotice?.kind, ChatItemKind.TRUNCATED);

  // 别的会话开新一轮：这条提示属于 s1，不能被顺手清掉。
  applyTurnBoundary(state, wsEvent('chat.turn.start', '{}'), 's2');
  assert.equal(state.truncatedNoticeSession, 's1');
  assert.notEqual(state.truncatedNotice, null);

  // 本会话开新一轮：上一轮的提示必须消失。
  applyTurnBoundary(state, wsEvent('chat.turn.start', '{}'), 's1');
  assert.equal(state.truncatedNoticeSession, null);
  assert.equal(state.truncatedNotice, null);

  // 缺 sessionId 的帧是畸形数据，无视。
  applyTurnBoundary(state, wsEvent('chat.turn.end', '{"reason":{"kind":"max-tokens"}}'), null);
  assert.equal(state.truncatedNotice, null);
});

test('截断提示只在所属会话里显示，且伪 seq 恒为 0', () => {
  const item: ChatDisplayItem = truncatedItemFor('s1');
  assert.equal(item.id, 's1-turn-max-tokens');
  // 历史里不存在这条提示，给真 seq 会让轨迹出现查无此号的值。
  assert.equal(item.seq, 0);
  assert.equal(item.kind, ChatItemKind.TRUNCATED);

  assert.equal(truncationItemsOf('s1', item, 's1').length, 1);
  assert.equal(truncationItemsOf('s1', item, 's2').length, 0);
  assert.equal(truncationItemsOf('s1', item, null).length, 0);
  assert.equal(truncationItemsOf(null, null, 's1').length, 0);
});
