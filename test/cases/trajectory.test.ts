import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JsonMap } from '../../entry/src/main/ets/core/JsonAccess.ts';
import { ChatHistory } from '../../entry/src/main/ets/core/ModelsEvents.ts';
import {
  TrajectoryNodeKind, TrajectoryTurn, UNKNOWN_TURN, shortDuration, trajectoryOf,
} from '../../entry/src/main/ets/core/Trajectory.ts';

/**
 * 轨迹折行的测试 —— 对位源工程 `TrajectoryTest.kt`。
 *
 * 为什么值得测：轨迹页是**排查工具**，它的价值全在「如实列出当时发生了什么」。
 * 分组错位 / 耗时算错，用户会据此得出错误结论（「这个工具没被调用过」「这一步很快」），
 * 而屏幕上不会有任何东西提示他看错了。
 */

function event(type: string, seq: number, time: number, data: JsonMap | null = null): JsonMap {
  return { event: { type: type, seq: seq, time: time, data: data } };
}

function history(events: JsonMap[]): ChatHistory {
  return ChatHistory.fromJson({ events: events });
}

// ── 分类 ──

test('认得的事件类型各归各类', () => {
  const turns: TrajectoryTurn[] = trajectoryOf(history([
    event('user/message', 1, 100, { turn: 1 }),
    event('assistant/message', 2, 200, { turn: 1 }),
    event('tool/call', 3, 300, { turn: 1, name: 'bash' }),
    event('deliverables/presented', 4, 400, { turn: 1 }),
    event('turn/end', 5, 500, { turn: 1 }),
  ]));
  assert.equal(turns.length, 1);
  const kinds: string[] = turns[0].nodes.map((n): string => n.kind);
  assert.deepEqual(kinds, [
    TrajectoryNodeKind.USER, TrajectoryNodeKind.ASSISTANT, TrajectoryNodeKind.TOOL,
    TrajectoryNodeKind.DELIVERABLE, TrajectoryNodeKind.TURN_END,
  ]);
});

test('不认的事件留成 OTHER，不丢（轨迹页的意义就在「都列出来」）', () => {
  const turns: TrajectoryTurn[] = trajectoryOf(history([
    event('step/end', 1, 100, { turn: 1 }),
  ]));
  assert.equal(turns[0].nodes.length, 1);
  assert.equal(turns[0].nodes[0].kind, TrajectoryNodeKind.OTHER);
});

test('节点保留事件类型原名：OTHER 节点靠它显示「这到底是什么」，而不是笼统的「其他」', () => {
  const turns: TrajectoryTurn[] = trajectoryOf(history([
    event('step/end', 1, 100, { turn: 1 }),
    event('assistant/message', 2, 200, { turn: 1 }),
  ]));
  assert.equal(turns[0].nodes[0].eventType, 'step/end');
  assert.equal(turns[0].nodes[1].eventType, 'assistant/message');
});

test('原始 data 原样保留（详情里的「原始」一栏）', () => {
  const turns: TrajectoryTurn[] = trajectoryOf(history([
    event('tool/call', 1, 100, { turn: 1, name: 'bash', unknownField: 'keep-me' }),
  ]));
  const raw: JsonMap | null = turns[0].nodes[0].raw as JsonMap | null;
  assert.notEqual(raw, null);
  assert.equal((raw as JsonMap)['unknownField'], 'keep-me');
});

// ── 标签 ──

test('工具节点取 data.name 当标签', () => {
  const turns: TrajectoryTurn[] = trajectoryOf(history([
    event('tool/call', 1, 100, { turn: 1, name: 'read_file' }),
  ]));
  assert.equal(turns[0].nodes[0].label, 'read_file');
});

test('工具没有 name / name 是空白 → 标签为 null（不猜别的字段名）', () => {
  const turns: TrajectoryTurn[] = trajectoryOf(history([
    event('tool/call', 1, 100, { turn: 1 }),
    event('tool/call', 2, 200, { turn: 1, name: '   ' }),
  ]));
  assert.equal(turns[0].nodes[0].label, null);
  assert.equal(turns[0].nodes[1].label, null);
});

test('非工具节点一律没有标签（哪怕 data 里有 name）', () => {
  const turns: TrajectoryTurn[] = trajectoryOf(history([
    event('assistant/message', 1, 100, { turn: 1, name: 'nope' }),
  ]));
  assert.equal(turns[0].nodes[0].label, null);
});

// ── 分组 ──

test('按 turn 分组，轮次升序', () => {
  const turns: TrajectoryTurn[] = trajectoryOf(history([
    event('user/message', 5, 500, { turn: 2 }),
    event('user/message', 1, 100, { turn: 1 }),
    event('assistant/message', 2, 200, { turn: 1 }),
  ]));
  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((t): number => t.turn), [1, 2]);
  assert.equal(turns[0].nodes.length, 2);
});

test('turn 取不到 → 归入 UNKNOWN_TURN，且不丢弃', () => {
  const turns: TrajectoryTurn[] = trajectoryOf(history([
    event('user/message', 1, 100, { turn: 1 }),
    event('tool/call', 2, 200),
    event('tool/call', 3, 300, { other: true }),
  ]));
  assert.equal(turns.length, 2);
  // `UNKNOWN_TURN` 取 0（而不是 -1）正是为了让它在**升序**里自然排在最前，
  // 不必为「未知轮次」单开一条排序特例 —— 所以它排在有编号的轮次之前。
  assert.equal(turns[0].turn, UNKNOWN_TURN);
  assert.equal(turns[0].nodes.length, 2);
  assert.equal(turns[1].turn, 1);
});

test('组内按 seq 升序，不依赖数组顺序', () => {
  const turns: TrajectoryTurn[] = trajectoryOf(history([
    event('tool/call', 9, 900, { turn: 1, name: 'c' }),
    event('tool/call', 3, 300, { turn: 1, name: 'a' }),
    event('tool/call', 6, 600, { turn: 1, name: 'b' }),
  ]));
  assert.deepEqual(turns[0].nodes.map((n): string | null => n.label), ['a', 'b', 'c']);
});

test('history 为 null / 空 → 空列表', () => {
  assert.deepEqual(trajectoryOf(null), []);
  assert.deepEqual(trajectoryOf(new ChatHistory()), []);
});

// ── 每轮的时间与耗时 ──

test('起止时间按序号顺序取（首节点与末节点）', () => {
  const turns: TrajectoryTurn[] = trajectoryOf(history([
    event('user/message', 1, 100, { turn: 1 }),
    event('assistant/message', 3, 300, { turn: 1 }),
    event('tool/call', 2, 200, { turn: 1 }),
  ]));
  assert.equal(turns[0].startedAt(), 100);
  assert.equal(turns[0].endedAt(), 300);
});

test('耗时 = 序号首末的时间差', () => {
  const turns: TrajectoryTurn[] = trajectoryOf(history([
    event('user/message', 1, 1000, { turn: 1 }),
    event('assistant/message', 2, 4500, { turn: 1 }),
  ]));
  assert.equal(turns[0].durationMillis(), 3500);
});

test('时间戳随序号倒退 → 不给耗时（乱序的 time 不可信）', () => {
  const turns: TrajectoryTurn[] = trajectoryOf(history([
    event('user/message', 1, 5000, { turn: 1 }),
    event('assistant/message', 2, 1000, { turn: 1 }),
  ]));
  assert.equal(turns[0].durationMillis(), null);
});

test('跨度为零 → 不给耗时（显示 0 秒会让人以为瞬间完成）', () => {
  const turns: TrajectoryTurn[] = trajectoryOf(history([
    event('user/message', 1, 7000, { turn: 1 }),
    event('assistant/message', 2, 7000, { turn: 1 }),
  ]));
  assert.equal(turns[0].durationMillis(), null);
});

test('节点不足两个 → 不给耗时', () => {
  const turns: TrajectoryTurn[] = trajectoryOf(history([
    event('user/message', 1, 7000, { turn: 1 }),
  ]));
  assert.equal(turns[0].durationMillis(), null);
  assert.equal(turns[0].startedAt(), 7000);
  assert.equal(turns[0].endedAt(), 7000);
});

test('工具调用次数=工具节点个数', () => {
  const turns: TrajectoryTurn[] = trajectoryOf(history([
    event('tool/call', 1, 100, { turn: 1, name: 'a' }),
    event('tool/call', 2, 200, { turn: 1, name: 'b' }),
    event('assistant/message', 3, 300, { turn: 1 }),
  ]));
  assert.equal(turns[0].toolCalls(), 2);
});

// ── 短耗时格式 ──

test('不足一分钟给 1 位小数的秒', () => {
  assert.equal(shortDuration(0), '0.0s');
  assert.equal(shortDuration(12500), '12.5s');
  assert.equal(shortDuration(59900), '59.9s');
});

test('满一分钟给出 m:ss，秒补前导零', () => {
  assert.equal(shortDuration(60000), '1:00');
  assert.equal(shortDuration(185000), '3:05');
  assert.equal(shortDuration(600000), '10:00');
});
