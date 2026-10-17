/**
 * 事件驱动的副作用闸门：把「每来一帧就干一次」压成「安静一段时间后干一次」 ——
 * 移植自源工程 `data/EventDebouncer.kt`。
 *
 * ## 为什么需要它
 *
 * 服务端推来的事件是**逐个**到达的，而客户端对某些事件的反应是**发一次网络请求**
 * （最典型的是 `file.*` → 重新拉目录）。内核在批量改写文件时（构建产物、格式化多个文件）
 * 会连着发很多帧，于是一个「事件驱动的界面」就变成了**事件驱动的轮询风暴** ——
 * 手机这头连发几十个请求，服务端逐个应答，电量与流量都白烧。
 *
 * ## 语义
 *
 * - 窗口内多次 `trigger()` 会**不断重置**窗口，直到**安静满 `windowMillis`** 才执行**一次** action；
 * - 同一个闸门**同时最多一个**在飞任务。
 *
 * 这是**去抖（trailing）不是节流（throttle）**：事件风暴期间一次都不执行，等它停下来
 * 才做那唯一一次。节流会在风暴中每 400ms 干一次 —— 那正是要消除的请求风暴。
 *
 * > 已知取舍：事件**永不停歇**时 action 会被饿死。这与本工程既有的 `scheduleChatRefresh`
 * > 同样取舍，换来的是「风暴中零请求」。
 *
 * ## 为什么要把定时器做成接缝（`TimerPort`）
 *
 * 源工程那条路在 Kotlin 上能用 `kotlinx.coroutines` 的虚拟时间跑测试；ArkTS 这边的
 * `setTimeout` 无法被虚拟时间替换，若直接调它，这个类的时序语义（尤其是「窗口内多次触发
 * 只执行最后一次」——正是它唯一的价值）就**根本测不了**。把「怎么定时」抽成一个端口后，
 * 单测可以喂一个手动推进的假定时器，把语义逐条钉死。
 */
export interface TimerPort {
  /** 推迟执行；返回一个可用于 `cancel` 的句柄。 */
  after(millis: number, action: () => void): number;
  /** 取消一个尚未到点的定时。对已经跑过的句柄调用必须是安全的空操作。 */
  cancel(handle: number): void;
}

/** 默认端口：包一层全局 `setTimeout` / `clearTimeout`（应用里用这一个）。 */
export class GlobalTimer implements TimerPort {
  after(millis: number, action: () => void): number {
    return setTimeout(action, millis);
  }

  cancel(handle: number): void {
    clearTimeout(handle);
  }
}

/** 无待执行动作时的句柄值。用 `-1` 而不是 `null`：ArkTS 里 `number` 端口下它更省事。 */
const NO_HANDLE: number = -1;

export class EventDebouncer {
  private readonly windowMillis: number;
  private readonly action: () => void;
  private readonly timer: TimerPort;
  /** 待执行动作的句柄；`-1` = 没有在等。 */
  private handle: number = NO_HANDLE;

  constructor(windowMillis: number, action: () => void, timer: TimerPort = new GlobalTimer()) {
    this.windowMillis = windowMillis;
    this.action = action;
    this.timer = timer;
  }

  /**
   * 记一次「有事发生」，并把等待窗口重新计时。
   *
   * 重置 = 取消上一个还没到点的窗口再起一个。**取消即丢弃**，所以不需要额外的 pending 标志：
   * 标志与句柄是同一件事的两种表达，留两个反而会出现「标志说该跑、定时器已被取消」的分裂状态。
   */
  trigger(): void {
    this.dropPending();
    this.handle = this.timer.after(this.windowMillis, (): void => {
      this.handle = NO_HANDLE;
      this.action();
    });
  }

  /** 取消待执行的动作（页面销毁 / 上下文切换时调用）。 */
  cancel(): void {
    this.dropPending();
  }

  /** 现在有没有在等的动作（诊断与测试用）。 */
  pending(): boolean {
    return this.handle !== NO_HANDLE;
  }

  private dropPending(): void {
    if (this.handle !== NO_HANDLE) {
      this.timer.cancel(this.handle);
      this.handle = NO_HANDLE;
    }
  }
}
