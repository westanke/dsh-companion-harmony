import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SeqVerdict, baselineBehind, seqVerdict,
} from '../../entry/src/main/ets/core/ChatSeqMonitor.ts';

/**
 * 断档判据的测试 —— 对位源工程 `ChatSeqMonitorTest.kt`。
 *
 * 为什么值得测：这两条判据决定「要不要把整份历史重拉一遍」这个代价不低的动作。
 * 判错成 RESYNC → 每次重连都白拉一份历史（列表无谓地闪一下）；
 * 判错成 CONTINUE → 用户**永远看不到**中间丢掉的那一段，且没有任何提示。
 */

// ── seqVerdict：严格跳号才算断档 ──

test('紧接上一条（last + 1）→ 继续', () => {
  assert.equal(seqVerdict(10, 11), SeqVerdict.CONTINUE);
});

test('跳号（last + 2）→ 必须 resync', () => {
  assert.equal(seqVerdict(10, 12), SeqVerdict.RESYNC);
});

test('跨一大段（last + 40）→ 必须 resync', () => {
  assert.equal(seqVerdict(100, 140), SeqVerdict.RESYNC);
});

test('重复（等于上一条）→ 不算断档：那是去重该管的事', () => {
  assert.equal(seqVerdict(10, 10), SeqVerdict.CONTINUE);
});

test('倒退（小于上一条）→ 不算断档：重连时服务端可能重发一小段', () => {
  assert.equal(seqVerdict(10, 7), SeqVerdict.CONTINUE);
});

test('这条事件没有序号（流式 delta 不参与）→ 继续', () => {
  assert.equal(seqVerdict(10, null), SeqVerdict.CONTINUE);
});

test('还没有起点（刚订阅 / 刚 resync 完）→ 继续，由调用方记下这条当新起点', () => {
  assert.equal(seqVerdict(null, 12), SeqVerdict.CONTINUE);
});

test('两边都没有 → 继续（不抛异常）', () => {
  assert.equal(seqVerdict(null, null), SeqVerdict.CONTINUE);
});

test('从 1 开始不算断档（起点是 0 时 seq = 1 是紧接）', () => {
  assert.equal(seqVerdict(0, 1), SeqVerdict.CONTINUE);
});

// ── baselineBehind：REST 快照与 WS 订阅之间的洞 ──

test('基线没给（老服务端）→ 不判定为落后', () => {
  assert.equal(baselineBehind(100, null), false);
});

test('本地一条都没有、服务端有内容 → 落后（最该立刻拉一次的情形）', () => {
  assert.equal(baselineBehind(null, 140), true);
});

test('本地没到基线 → 落后', () => {
  assert.equal(baselineBehind(100, 140), true);
});

test('本地正好到基线 → 不落后', () => {
  assert.equal(baselineBehind(140, 140), false);
});

test('本地超过基线 → 不落后（本地更全，不该被重拉覆盖）', () => {
  assert.equal(baselineBehind(150, 140), false);
});
