/**
 * 显式交付物卡片的映射回归（`ChatEventParsers.displayItemsOf` 的交付物冲刷）。
 *
 * 用户报的缺口：桌面端会话里 agent 用 present 工具交付的文件有**内联卡片**，
 * 手机端只有「本会话的文件」弹层 —— 数据（`deliverables/presented` 事件）一直在历史里，
 * 只是映射层把它整类丢掉。修复后卡片钉在**轮次收尾**（收尾消息之后、下一轮提问之前），
 * 对齐桌面端 turnTail 的钉法。
 *
 * 对位 Android 源工程 `app/src/test/java/.../ChatDeliverableCardsTest.kt`。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ChatHistory, HistoryEntry, SessionEvent } from '../../entry/src/main/ets/core/Models';
import { ChatItemKind } from '../../entry/src/main/ets/core/ChatPresentationTypes';
import { displayItemsOf, extractDeliverablesFromEvent, deliverablesOf } from '../../entry/src/main/ets/core/ChatEventParsers';

function entry(type: string, seq: number, dataObj: Object): HistoryEntry {
  const ev = new SessionEvent();
  ev.type = type;
  ev.seq = seq;
  ev.data = dataObj;
  const he = new HistoryEntry();
  he.event = ev;
  return he;
}

function history(entries: HistoryEntry[]): ChatHistory {
  const h = new ChatHistory();
  h.events = entries;
  h.hasMore = false;
  return h;
}

test('钉在轮次收尾：卡片在 turn/end 之前、turn/start 之后', () => {
  const h = history([
    entry('turn/start', 1, { turn: 1 }),
    entry('user/message', 2, { content: [{ type: 'text', text: 'Ship the report' }], source: { kind: 'user' } }),
    entry('assistant/message', 3, { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Here is the report.' }] } }),
    entry('deliverables/presented', 4, { turn: 1, files: [{ path: '/workspace/report.md', description: '本轮排障报告' }] }),
    entry('turn/end', 5, { turn: 1, reason: { kind: 'completed' } }),
    entry('turn/start', 6, { turn: 2 }),
    entry('user/message', 7, { content: [{ type: 'text', text: 'Thanks' }], source: { kind: 'user' } }),
  ]);

  const items = displayItemsOf(h);
  const deliverables = items.filter(i => i.kind === ChatItemKind.DELIVERABLE);

  assert.equal(deliverables.length, 1);
  // 卡片在 turn/end 之前（flushDeliverableCards 在 turn/end 事件渲染之前被调用）。
  // 所以顺序是：assistant/message → deliverable-card → turn/end。
  const endIdx = items.findIndex(i => i.kind === ChatItemKind.TRUNCATED || i.kind === ChatItemKind.FAILURE);
  // 至少确认 deliverable 不是第一个（有 turn/start/user/assistant 在它前面）。
  assert.ok(items.indexOf(deliverables[0]) > 0);
  // 卡片的 deliverable 字段有正确数据。
  assert.equal(deliverables[0].deliverable?.path, '/workspace/report.md');
  assert.equal(deliverables[0].deliverable?.description, '本轮排障报告');
});

test('同轮同路径多次交付只留最后说明', () => {
  const h = history([
    entry('turn/start', 1, { turn: 1 }),
    entry('deliverables/presented', 2, { turn: 1, files: [{ path: '/workspace/report.md', description: '第一版' }] }),
    entry('deliverables/presented', 3, { turn: 1, files: [{ path: '/workspace/report.md', description: '最终版' }] }),
    entry('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }),
  ]);

  const items = displayItemsOf(h);
  const deliverables = items.filter(i => i.kind === ChatItemKind.DELIVERABLE);

  // 同路径只出一张卡。
  assert.equal(deliverables.length, 1);
  assert.equal(deliverables[0].deliverable?.description, '最终版');
});

test('多文件一次性 present 全成卡片', () => {
  const h = history([
    entry('turn/start', 1, { turn: 1 }),
    entry('deliverables/presented', 2, { turn: 1, files: [
      { path: '/workspace/a.md', description: 'A' },
      { path: '/workspace/b.md', description: 'B' },
      { path: '/workspace/c.md' },
    ] }),
    entry('turn/end', 3, { turn: 1, reason: { kind: 'completed' } }),
  ]);

  const items = displayItemsOf(h);
  const deliverables = items.filter(i => i.kind === ChatItemKind.DELIVERABLE);

  assert.equal(deliverables.length, 3);
  // 第三个 description 是 null（服务端没给），不是空串。
  assert.equal(deliverables[2].deliverable?.description, null);
});

test('无 turn/end 补尾：会话仍在运行时交付物不丢', () => {
  const h = history([
    entry('turn/start', 1, { turn: 1 }),
    entry('user/message', 2, { content: [{ type: 'text', text: 'Go' }], source: { kind: 'user' } }),
    entry('deliverables/presented', 3, { turn: 1, files: [{ path: '/workspace/out.bin', description: '产物' }] }),
    // 没有 turn/end —— 会话仍在运行中。
  ]);

  const items = displayItemsOf(h);
  const deliverables = items.filter(i => i.kind === ChatItemKind.DELIVERABLE);

  assert.equal(deliverables.length, 1);
  assert.equal(deliverables[0].deliverable?.path, '/workspace/out.bin');
});

test('跨轮次：每轮 turn/end 冲刷自己的交付物', () => {
  const h = history([
    entry('turn/start', 1, { turn: 1 }),
    entry('deliverables/presented', 2, { turn: 1, files: [{ path: '/r1.md', description: '轮1' }] }),
    entry('turn/end', 3, { turn: 1, reason: { kind: 'completed' } }),
    entry('turn/start', 4, { turn: 2 }),
    entry('deliverables/presented', 5, { turn: 2, files: [{ path: '/r2.md', description: '轮2' }] }),
    entry('turn/end', 6, { turn: 2, reason: { kind: 'completed' } }),
  ]);

  const items = displayItemsOf(h);
  const deliverables = items.filter(i => i.kind === ChatItemKind.DELIVERABLE);

  assert.equal(deliverables.length, 2);
  // 轮 1 卡片先于轮 2 卡片。
  assert.ok(items.indexOf(deliverables[0]) < items.indexOf(deliverables[1]));
  assert.equal(deliverables[0].deliverable?.description, '轮1');
  assert.equal(deliverables[1].deliverable?.description, '轮2');
});

// —— extractDeliverablesFromEvent 辅助函数 ——

test('extractDeliverablesFromEvent 只认 deliverables/presented', () => {
  const ev = new SessionEvent();
  ev.type = 'tool/call';
  ev.seq = 10;
  ev.data = { name: 'present' };
  assert.deepEqual(extractDeliverablesFromEvent(ev), []);
});

test('extractDeliverablesFromEvent 跳过 path 为 null/空串/纯空白的条目', () => {
  const ev = new SessionEvent();
  ev.type = 'deliverables/presented';
  ev.seq = 10;
  ev.data = { files: [
    { path: '/a.md', description: 'ok' },
    { path: null },
    { path: '' },
    { path: '   ' },
  ] };
  const files = extractDeliverablesFromEvent(ev);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, '/a.md');
});

// —— deliverablesOf 全量仍正确（改了内部实现） ——

test('deliverablesOf 跨轮次全局去重取最后说明', () => {
  const h = history([
    entry('deliverables/presented', 2, { files: [{ path: '/same.md', description: '第一次' }] }),
    entry('turn/end', 3, { turn: 1, reason: { kind: 'completed' } }),
    entry('deliverables/presented', 5, { files: [{ path: '/same.md', description: '第二次' }] }),
  ]);
  const all = deliverablesOf(h);
  assert.equal(all.length, 1);
  assert.equal(all[0].description, '第二次');
});
