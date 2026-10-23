/**
 * `mergeRefreshedHistory` 纯函数单测 —— 对位 Android 源工程
 * `app/src/test/java/.../data/HistoryMergeTest.kt`。
 *
 * 真机实测的现象：点「加载更早消息」→ 内容出现 → 一秒后整屏变空白。
 * 根因是刷新拿回的是最后一页，直接替换会把更早的那几页抹掉，列表从 5 条缩回 2 条，
 * 而视口还停在原来的像素偏移上，于是落在空白区。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ChatHistory, HistoryEntry, SessionEvent } from '../../entry/src/main/ets/core/Models';
import { mergeRefreshedHistory } from '../../entry/src/main/ets/core/ChatHistoryMerge';

function entry(seq: number): HistoryEntry {
  const ev = new SessionEvent();
  ev.type = 'assistant/message';
  ev.seq = seq;
  ev.time = seq * 1000;
  const e = new HistoryEntry();
  e.event = ev;
  return e;
}

function page(seqs: number[], hasMore: boolean = true): ChatHistory {
  const h = new ChatHistory();
  h.events = seqs.map(entry);
  h.hasMore = hasMore;
  return h;
}

test('mergeRefreshedHistory 刷新保留已加载的更早页', () => {
  const previous = page([1, 2, 3, 4, 5]);
  const fresh = page([10, 11, 12]);

  const merged = mergeRefreshedHistory(previous, fresh);

  assert.deepEqual(merged.events.map((e: HistoryEntry): number => e.event.seq),
    [1, 2, 3, 4, 5, 10, 11, 12]);
  // 更早的历史还在，所以「还能往前翻」的结论要在。
  assert.equal(merged.hasMore, true);
});

test('mergeRefreshedHistory 无已加载历史直接用新页', () => {
  const fresh = page([10, 11]);

  assert.deepEqual(mergeRefreshedHistory(null, fresh).events.map((e: HistoryEntry): number => e.event.seq),
    [10, 11]);
  assert.deepEqual(mergeRefreshedHistory(page([], true), fresh).events.map((e: HistoryEntry): number => e.event.seq),
    [10, 11]);
});

test('mergeRefreshedHistory 与已加载页重叠不重复', () => {
  const previous = page([1, 2, 10, 11]);
  const fresh = page([10, 11, 12], false);

  const merged = mergeRefreshedHistory(previous, fresh);

  assert.deepEqual(merged.events.map((e: HistoryEntry): number => e.event.seq),
    [1, 2, 10, 11, 12]);
  // 列表第一项是 seq=1，而它之前还有更早的（上一页报的是 hasMore=true），结论要延续。
  assert.equal(merged.hasMore, true);
});

test('mergeRefreshedHistory previous 是同一段尾巴时不丢东西', () => {
  const previous = page([10, 11, 12]);
  const fresh = page([10, 11, 12], false);

  const merged = mergeRefreshedHistory(previous, fresh);

  assert.deepEqual(merged.events.map((e: HistoryEntry): number => e.event.seq),
    [10, 11, 12]);
  assert.equal(merged.hasMore, false);
});
