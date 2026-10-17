import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RequestGate } from '../../entry/src/main/ets/core/RequestGate.ts';

/**
 * 请求代际闸门的测试 —— 逐条对应原工程 `RequestGateTest.kt`。
 *
 * 为什么值得测：它挡的是**切会话看到别的会话内容**那种难复现的时序 bug。
 * 这条判据错了，真机上只表现为「偶尔跳回上一个会话」，靠肉眼回归永远抓不到。
 */

test('刚开始的代际是 0，领的号就是当前代际', () => {
  const gate: RequestGate = new RequestGate();
  assert.equal(gate.current(), 0);
  const token: number = gate.current();
  assert.equal(gate.isCurrent(token), true);
});

test('invalidate 之后，旧号立刻作废', () => {
  const gate: RequestGate = new RequestGate();
  const stale: number = gate.current();
  const fresh: number = gate.invalidate();
  assert.equal(fresh, stale + 1);
  assert.equal(gate.isCurrent(stale), false);
  assert.equal(gate.isCurrent(fresh), true);
});

test('invalidate 返回新号，且新号确实可用（不是「作废完就没有有效号」）', () => {
  const gate: RequestGate = new RequestGate();
  const first: number = gate.invalidate();
  const second: number = gate.invalidate();
  assert.equal(gate.isCurrent(second), true);
  assert.equal(gate.isCurrent(first), false);
});

test('没有 invalidate 时，同一个号一直有效（连续多次读取都是当前代际）', () => {
  const gate: RequestGate = new RequestGate();
  const token: number = gate.current();
  assert.equal(gate.isCurrent(token), true);
  assert.equal(gate.isCurrent(token), true);
});

test('同一代际里领的两个号相等（只领取号、不写状态的请求不制造新代际）', () => {
  const gate: RequestGate = new RequestGate();
  const a: number = gate.current();
  const b: number = gate.current();
  assert.equal(a, b);
  gate.invalidate();
  assert.equal(gate.isCurrent(a), false);
  assert.equal(gate.isCurrent(b), false);
});
