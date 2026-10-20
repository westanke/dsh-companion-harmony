import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HostCardState, hostCardState, shouldRecheckActiveConnection, shouldReconnectOnTap,
} from '../../entry/src/main/ets/core/ConnectionLiveness.ts';

/**
 * 连接页「此刻通不通」的判据 —— 移植自源工程 `ConnectionLivenessTest.kt`。
 *
 * 这一组用例钉的是同一个错误假设：把历史状态位 `connected`（「曾经连上过」）
 * 当成「此刻还连着」。三处各自错一次，真机症状分别是「断网仍显示已连接」
 * 「点按钮没反应」「连接页看不出这台断没过」。
 */

test('回前台复核：已进 App 且连着不重复探活', () => {
  assert.equal(shouldRecheckActiveConnection(true, true, true, false), false);
});

test('回前台复核：没有活动连接时无从探起', () => {
  assert.equal(shouldRecheckActiveConnection(false, false, false, false), false);
});

test('回前台复核：正在并发探活时别抢', () => {
  assert.equal(shouldRecheckActiveConnection(false, false, true, true), false);
});

test('回前台复核：停在连接页且有连接、不忙时才探', () => {
  assert.equal(shouldRecheckActiveConnection(false, false, true, false), true);
  // 已进 App 但连接掉了：也该探一次，否则用户回不到「已断开」这个真相。
  assert.equal(shouldRecheckActiveConnection(true, false, true, false), true);
});

test('点按重连：同一台且客户端还在手里，直接进入应用不重连', () => {
  assert.equal(shouldReconnectOnTap('host-1', 'host-1', true), false);
});

test('点按重连：同一台但客户端已经摘掉（断网被复核清掉）必须重连', () => {
  // 这里**不能**看 `connected`：它可能还是 true，那就短路了，按钮等于哑巴。
  assert.equal(shouldReconnectOnTap('host-1', 'host-1', false), true);
});

test('点按重连：换一台电脑总是发起连接', () => {
  assert.equal(shouldReconnectOnTap('host-2', 'host-1', true), true);
});

test('卡片三态：当前活跃且连着是 CONNECTED', () => {
  assert.equal(hostCardState('host-1', 'host-1', true), HostCardState.CONNECTED);
});

test('卡片三态：当前活跃但此刻断开是 DISCONNECTED（不是 IDLE）', () => {
  // 这两态必须分开：混成一个的话，用户看到的都是灰点，只能凭记忆猜。
  assert.equal(hostCardState('host-1', 'host-1', false), HostCardState.DISCONNECTED);
});

test('卡片三态：不是当前活跃连接的一律 IDLE', () => {
  assert.equal(hostCardState('host-2', 'host-1', true), HostCardState.IDLE);
  assert.equal(hostCardState('host-2', null, false), HostCardState.IDLE);
});
