/**
 * TimerBridge 的鸿蒙实现 —— 直接落在 ArkTS 全局 `setTimeout` / `clearTimeout` 上。
 *
 * 注入的理由（见 `DshClient.ts` 的 `TimerBridge`）是两条：WS 退避重连（1、2、4、8、16、30s）
 * 与聊天页 400ms 去抖刷新。单测里换成「手动触发」的假实现，就能离线断言退避序列。
 *
 * 句柄用 `number`，与 ArkTS 的 `setTimeout` 返回值一致；`-1` 保留作「无句柄」哨兵
 * （core 里 `EventsChannel.timerHandle` 就是这么用的）。
 */

import { TimerBridge } from '../core/DshClient';

export class SystemTimers implements TimerBridge {
  schedule(delayMs: number, action: () => void): number {
    return setTimeout(action, delayMs);
  }

  cancel(handle: number): void {
    if (handle >= 0) {
      clearTimeout(handle);
    }
  }
}
