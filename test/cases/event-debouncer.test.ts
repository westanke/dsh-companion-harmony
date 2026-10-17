import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventDebouncer, TimerPort } from '../../entry/src/main/ets/core/EventDebouncer.ts';

/**
 * 事件去抖的测试 —— 逐条对应原工程 `EventDebouncerTest.kt`。
 *
 * ## 为什么要喂一个假定时器
 *
 * 这个类唯一的价值就是**时序语义**：「窗口内多次触发只执行最后一次」。
 * 用真实 `setTimeout` 测它，要么得 `await` 真实时间（测试变慢且不稳），
 * 要么只能断言「触发一次会执行一次」—— 那就完全没测到去抖。
 * 假定时器让「推进时间」成为一个显式动作，语义才能被钉死。
 *
 * ## 假定时器为什么要有「到点」的独立动作
 *
 * 真定时器到点会自动回调。假定时器若在 `after()` 里直接回调，就等于「窗口长度 0」，
 * 测不出「安静满窗口才执行」。所以这里把「到点」拆成显式的 `fire()`。
 */

class FakeTimer implements TimerPort {
  private next: number = 1;
  private scheduled: number[] = [];
  private actions: Map<number, () => void> = new Map<number, () => void>();

  after(millis: number, action: () => void): number {
    const handle: number = this.next;
    this.next += 1;
    this.scheduled.push(handle);
    this.actions.set(handle, action);
    return handle;
  }

  cancel(handle: number): void {
    this.actions.delete(handle);
  }

  /** 让当前所有待执行的窗口「到点」（对应真实时间的流逝）。 */
  fire(): void {
    const due: number[] = this.scheduled;
    this.scheduled = [];
    for (let i = 0; i < due.length; i++) {
      const action: (() => void) | undefined = this.actions.get(due[i]);
      if (action !== undefined) {
        this.actions.delete(due[i]);
        action();
      }
    }
  }

  /** 还没到点的窗口数。 */
  pendingCount(): number {
    return this.actions.size;
  }
}

test('安静满窗口后执行一次', () => {
  const timer: FakeTimer = new FakeTimer();
  let runs: number = 0;
  const debouncer: EventDebouncer = new EventDebouncer(400, (): void => {
    runs += 1;
  }, timer);

  debouncer.trigger();
  assert.equal(runs, 0);
  assert.equal(debouncer.pending(), true);
  timer.fire();
  assert.equal(runs, 1);
  assert.equal(debouncer.pending(), false);
});

test('窗口内多次触发只执行最后一次（这正是去抖与节流的区别）', () => {
  const timer: FakeTimer = new FakeTimer();
  let runs: number = 0;
  const debouncer: EventDebouncer = new EventDebouncer(400, (): void => {
    runs += 1;
  }, timer);

  debouncer.trigger();
  debouncer.trigger();
  debouncer.trigger();
  // 前两次的窗口都该被取消：只有最后一次还等着。
  assert.equal(timer.pendingCount(), 1);
  timer.fire();
  assert.equal(runs, 1);
  assert.equal(timer.pendingCount(), 0);
});

test('执行完之后再触发，会重新排一次', () => {
  const timer: FakeTimer = new FakeTimer();
  let runs: number = 0;
  const debouncer: EventDebouncer = new EventDebouncer(400, (): void => {
    runs += 1;
  }, timer);

  debouncer.trigger();
  timer.fire();
  assert.equal(runs, 1);
  debouncer.trigger();
  timer.fire();
  assert.equal(runs, 2);
});

test('cancel 之后到点也不执行（页面销毁 / 上下文切换的路径）', () => {
  const timer: FakeTimer = new FakeTimer();
  let runs: number = 0;
  const debouncer: EventDebouncer = new EventDebouncer(400, (): void => {
    runs += 1;
  }, timer);

  debouncer.trigger();
  debouncer.cancel();
  assert.equal(debouncer.pending(), false);
  timer.fire();
  assert.equal(runs, 0);
});

test('没有待执行动作时 cancel 是安全的空操作', () => {
  const timer: FakeTimer = new FakeTimer();
  const debouncer: EventDebouncer = new EventDebouncer(400, (): void => {}, timer);
  debouncer.cancel();
  debouncer.cancel();
  assert.equal(debouncer.pending(), false);
});

test('执行后再 cancel 不会把已经跑过的动作再取消一次', () => {
  const timer: FakeTimer = new FakeTimer();
  let runs: number = 0;
  const debouncer: EventDebouncer = new EventDebouncer(400, (): void => {
    runs += 1;
  }, timer);
  debouncer.trigger();
  timer.fire();
  debouncer.cancel();
  assert.equal(runs, 1);
  assert.equal(debouncer.pending(), false);
});
