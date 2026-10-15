/**
 * UI 运行时 —— 全 App 唯一的 [HarnessViewModel] 实例，以及把它的变更广播给 ArkUI。
 *
 * ## 为什么需要这一层
 *
 * core 的 `HarnessViewModel` 是**平台无关**的：状态是一个普通可变对象（`HarnessState`），
 * 变更靠 `update(fn)` + `revision++` + `subscribe(listener)`。它刻意不依赖 ArkUI 的
 * `@Observed`/`@State` —— 那样 core 就没法在 node 下跑那 488 个单测了。
 *
 * 于是这里做**桥**：把 vm 的 `revision` 写进 `AppStorage`，各页面用
 * `@StorageLink('dshRevision') revision: number` 订阅。任何一次 `update()` 都会
 * 递增 revision → ArkUI 重跑相关页面的 `build()` → 界面自动跟上。
 * 组件里读 `vm.state.xxx` 永远是**最新值**（同一个对象原地改），不需要深拷贝。
 *
 * ## 生命周期
 *
 * - `initHarness(context)`：装配 deps、建 vm、订阅、启动冷启动重连，**只做一次**。
 * - `pauseHarnessEvents()` / `resumeHarnessEvents()`：由 `EntryAbility` 的前后台回调驱动。
 *   源工程的策略是**熄屏只关事件流**（不关连接），因为 `pauseEvents()` 只影响 WS 订阅，
 *   REST 会话仍在；回到前台 `resumeEvents()` 会重新订阅并按需补齐状态。
 */

import { common } from '@kit.AbilityKit';
import { HarnessState, HarnessViewModel } from '../core/HarnessViewModel';
import { createHarnessDeps } from '../platform/Platform';

/** AppStorage 里放 revision 的键名。 */
export const REVISION_KEY: string = 'dshRevision';

/**
 * 跨分节导航的请求序号（当前只有「打开目录 → 切到文件分节」一例）。
 *
 * 为什么要这么一个键：分节状态（`AppShell.section`）是**外壳自己的局部 `@State`**，
 * 而发起方在会话详情页里 —— 子页拿不到父页的状态，也没有"路由参数"这种东西。
 * 于是用 `AppStorage` 当**邮箱**：发起方写一个递增序号，`AppShell` 用
 * `@StorageLink` + `@Watch` 收到后切分节。
 *
 * 为什么是**序号**而不是把目标路径也塞进来：路径已经在 vm 的 state 上
 * （`revealDirectory` 写好了 `selectedRootId` / `currentPath` / `directory`），
 * 再传一份就会出现"两份真相"。序号的作用只是"这是一次新请求"——
 * 同一个目录连点两次也要能触发（只比较路径的话第二次会被当成没变化而忽略）。
 *
 * 注：装饰器里写的是字符串字面量（与 `REVISION_KEY` 同样的约定，见各页面的
 * `@StorageLink('dshRevision')`），常量只供本文件的写入方使用。
 */
export const FILES_REVEAL_SEQ_KEY: string = 'dshFilesRevealSeq';

/** 发一次「请切到文件分节」的请求。目录内容由 `revealDirectory` 负责准备好。 */
export function requestFilesSection(): void {
  const seq: number = AppStorage.get<number>(FILES_REVEAL_SEQ_KEY) ?? 0;
  AppStorage.setOrCreate(FILES_REVEAL_SEQ_KEY, seq + 1);
}

let instance: HarnessViewModel | null = null;
let unsubscribe: (() => void) | null = null;

/**
 * 装配并启动（幂等：重复调用直接返回已有实例）。
 *
 * 必须在 UI 上下文里调用（`context` 来自 `getUIContext().getHostContext()`），
 * 因为 preferences 需要一个 Ability 的 Context。
 */
export function initHarness(context: common.Context): void {
  if (instance !== null) {
    return;
  }
  const vm: HarnessViewModel = new HarnessViewModel(createHarnessDeps(context));
  unsubscribe = vm.subscribe((): void => {
    AppStorage.setOrCreate(REVISION_KEY, vm.revision);
  });
  instance = vm;
  AppStorage.setOrCreate(REVISION_KEY, vm.revision);
  // 注意：**不要**在这里再调 restoreConnection()。`HarnessViewModel` 的构造函数末尾
  // 已经 `void this.restoreConnection()`（对应 Kotlin 的 init 块），重复调用会读两遍盘、
  // 并且把「正在恢复」那一态闪两次。
}

/** 当前实例；未装配时为 null（页面里不要假设它一定在）。 */
export function harnessVm(): HarnessViewModel | null {
  return instance;
}

/** 当前状态快照；未装配时返回 null。 */
export function harnessState(): HarnessState | null {
  const vm: HarnessViewModel | null = instance;
  return vm === null ? null : vm.state;
}

/** 退到后台：只关事件流（连接与已加载数据都保留，回来时是即时的）。 */
export function pauseHarnessEvents(): void {
  const vm: HarnessViewModel | null = instance;
  if (vm !== null) {
    vm.pauseEvents();
  }
}

/** 回到前台：重新订阅事件流并按需补齐。 */
export function resumeHarnessEvents(): void {
  const vm: HarnessViewModel | null = instance;
  if (vm !== null) {
    void vm.resumeEvents();
  }
}

/** 释放（当前只在进程真正退出时用，正常切后台不要调）。 */
export function disposeHarness(): void {
  const vm: HarnessViewModel | null = instance;
  if (vm === null) {
    return;
  }
  if (unsubscribe !== null) {
    unsubscribe();
    unsubscribe = null;
  }
  vm.dispose();
  instance = null;
}
