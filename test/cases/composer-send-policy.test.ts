import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEND_MODE_QUEUE, SEND_MODE_STEER, canSubmit, oppositeSendMode, resolveSendMode,
} from '../../entry/src/main/ets/core/ComposerSendPolicy.ts';

/**
 * 「按下发送之后走哪条路」的决策测试 —— 逐条对应原工程 `ComposerSendPolicyTest.kt`。
 *
 * 这段逻辑此前在旧版根本不存在：旧的输入框用全局 `busy` 去禁用两个发送按钮，于是智能体
 * 运行时**既不能排队也不能插话**（发送键还会变成转圈）。抽出来单测，是为了让
 * 「空闲 / 运行中 × 默认 / 反向」这几个组合有据可查。
 */

test('空闲时一律排队，即使用户把默认设成了插话', () => {
  // 空闲时没有正在运行的一轮可插话，steer 没有意义，必须回落 queue（等价普通发送）。
  assert.equal(resolveSendMode(false, SEND_MODE_STEER), SEND_MODE_QUEUE);
  assert.equal(resolveSendMode(false, SEND_MODE_QUEUE), SEND_MODE_QUEUE);
});

test('空闲时按备用组合键也不产生插话', () => {
  assert.equal(resolveSendMode(false, SEND_MODE_STEER, true), SEND_MODE_QUEUE);
  assert.equal(resolveSendMode(false, SEND_MODE_QUEUE, true), SEND_MODE_QUEUE);
});

test('运行中按用户设置的默认行为走', () => {
  assert.equal(resolveSendMode(true, SEND_MODE_QUEUE), SEND_MODE_QUEUE);
  assert.equal(resolveSendMode(true, SEND_MODE_STEER), SEND_MODE_STEER);
});

test('运行中按备用组合键会翻转行为', () => {
  // 这正是「Cmd/Ctrl+Enter 使用另一行为」的可验证形式。
  assert.equal(resolveSendMode(true, SEND_MODE_QUEUE, true), SEND_MODE_STEER);
  assert.equal(resolveSendMode(true, SEND_MODE_STEER, true), SEND_MODE_QUEUE);
});

test('opposite 是对合运算（连按两次回到原状）', () => {
  assert.equal(oppositeSendMode(SEND_MODE_STEER), SEND_MODE_QUEUE);
  assert.equal(oppositeSendMode(SEND_MODE_QUEUE), SEND_MODE_STEER);
  assert.equal(oppositeSendMode(oppositeSendMode(SEND_MODE_QUEUE)), SEND_MODE_QUEUE);
});

test('opposite 对未知取值也回落到 queue（不猜）', () => {
  // 原实现是 `if (this == QUEUE) STEER else QUEUE`，任何非 queue 的值都落到 queue。
  assert.equal(oppositeSendMode('steer-ish'), SEND_MODE_QUEUE);
});

test('canSubmit 同时要求有内容与写权限', () => {
  assert.equal(canSubmit('hi', true), true);
  assert.equal(canSubmit('', true), false);
  // 只有空白也不算内容。
  assert.equal(canSubmit('   \n ', true), false);
  assert.equal(canSubmit('hi', false), false);
});

test('canSubmit 的空白口径与 Kotlin 一致：U+FEFF 不算空白', () => {
  // Kotlin 的 Char.isWhitespace() = isWhitespace || isSpaceChar，两者都不认 U+FEFF，
  // 所以「只含 BOM 的输入框」在两端同样都算有内容（发送键可点）。
  assert.equal(canSubmit('\uFEFF', true), true);
  // 而不换行空格 U+00A0 属于 Zs，Kotlin 认它是空白 —— 只含它的输入框两端都算空。
  assert.equal(canSubmit('\u00A0', true), false);
});

test('canSubmit 对全角空格与制表符同样按空白处理', () => {
  assert.equal(canSubmit('\u3000\t', true), false);
});
