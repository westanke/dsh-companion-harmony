import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JsonMap } from '../../entry/src/main/ets/core/JsonAccess.ts';
import { ChatHistory } from '../../entry/src/main/ets/core/ModelsEvents.ts';
import { SessionStats, sessionStatsOf } from '../../entry/src/main/ets/core/SessionStats.ts';

/**
 * 会话执行统计的测试 —— 对位源工程 `SessionStatsTest.kt`。
 *
 * 为什么值得测：面板上的每个数字都是拿去和别处对照的事实（尤其「数据截至事件 #N」）。
 * 数错了用户看不出来 —— 他没有第二份数据可对，只会相信屏幕上这个数。
 */

function event(type: string, seq: number, time: number = 1000): JsonMap {
  return { event: { type: type, seq: seq, time: time } };
}

function history(events: JsonMap[]): ChatHistory {
  return ChatHistory.fromJson({ events: events });
}

test('history 为 null（还没加载 / 加载失败）→ 空统计，不抛错', () => {
  const stats: SessionStats = sessionStatsOf(null);
  assert.equal(stats.isEmpty(), true);
  assert.equal(stats.events, 0);
  assert.equal(stats.lastSeq, null);
});

test('空历史 → 空统计', () => {
  const stats: SessionStats = sessionStatsOf(new ChatHistory());
  assert.equal(stats.isEmpty(), true);
  assert.equal(stats.lastSeq, null);
});

test('按类型分派：用户轮次 / 助手正文 / 工具调用各数各的', () => {
  const stats: SessionStats = sessionStatsOf(history([
    event('user/message', 1),
    event('assistant/message', 2),
    event('tool/call', 3),
    event('user/message', 4),
    event('tool/call', 5),
  ]));
  assert.equal(stats.turns, 2);
  assert.equal(stats.assistantMessages, 1);
  assert.equal(stats.toolCalls, 2);
  assert.equal(stats.events, 5);
});

test('认不出的事件仍计入总数（只影响分项，不影响「有多少事件」）', () => {
  const stats: SessionStats = sessionStatsOf(history([
    event('step/end', 1),
    event('reasoning/delta', 2),
    event('user/message', 3),
  ]));
  assert.equal(stats.events, 3);
  assert.equal(stats.turns, 1);
  assert.equal(stats.toolCalls, 0);
});

test('lastSeq 取最大序号，不是数组末条的序号（历史数组不保证有序）', () => {
  const stats: SessionStats = sessionStatsOf(history([
    event('user/message', 40),
    event('assistant/message', 12),
    event('tool/call', 31),
  ]));
  assert.equal(stats.lastSeq, 40);
});

test('只有一条事件时 lastSeq 就是它', () => {
  const stats: SessionStats = sessionStatsOf(history([event('user/message', 7)]));
  assert.equal(stats.lastSeq, 7);
  assert.equal(stats.turns, 1);
});

test('同一类型重复只累加一次一个（不把一条算成两条）', () => {
  const stats: SessionStats = sessionStatsOf(history([event('tool/call', 1)]));
  assert.equal(stats.toolCalls, 1);
  assert.equal(stats.events, 1);
});
