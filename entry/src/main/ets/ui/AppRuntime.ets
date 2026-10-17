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
import { applyAppFontScale, applyAppThemeMode, createHarnessDeps } from '../platform/Platform';

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

/** 装配时的 Ability 上下文；「字号倍数 / 主题档位」变更时要拿它下发到平台。 */
let appContext: common.Context | null = null;

/**
 * 上一次已经下发给平台的外观三件套。
 *
 * 初值刻意**不可能等于任何真实取值**（`-1` / 空串 / 假），否则「首次装配」会被误判成
 * 「没变化」而整体跳过下发 —— 那表现就是「设置了主题，重启后又回跟随系统」。
 */
let appliedFontScale: number = -1;
let appliedFontFollowsSystem: boolean = false;
let appliedThemeMode: string = '';

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
  appContext = context;
  const vm: HarnessViewModel = new HarnessViewModel(createHarnessDeps(context));
  unsubscribe = vm.subscribe((): void => {
    AppStorage.setOrCreate(REVISION_KEY, vm.revision);
    syncAppearance();
  });
  instance = vm;
  AppStorage.setOrCreate(REVISION_KEY, vm.revision);
  // 冷启动时把「字号倍数 / 主题档位」落到平台上。**必须在 vm 建好之后**：
  // 偏好是在 vm 构造里读进 state 的（`applyPreferences`），在那之前读 state 只会拿到默认值。
  syncAppearance();
  // 注意：**不要**在这里再调 restoreConnection()。`HarnessViewModel` 的构造函数末尾
  // 已经 `void this.restoreConnection()`（对应 Kotlin 的 init 块），重复调用会读两遍盘、
  // 并且把「正在恢复」那一态闪两次。
}

/**
 * 把「字号倍数 / 主题档位」推给平台（幂等：值没变就一个系统调用都不发）。
 *
 * ## 为什么挂在 `subscribe` 里而不是各设置项的点击回调里
 *
 * `setFontScale` 等 vm 方法只改状态与落盘，**不知道界面层存在**（core 不碰平台 API）。
 * 挂在订阅回调上，任何一条改到这两个字段的路径都会自动生效 —— 点击设置项、切主题药丸、
 * 甚至冷启动恢复偏好，都走同一处。反过来若写在点击回调里，将来多一条修改路径就会漏一处。
 *
 * ## 为什么要比对「上次已应用的三个值」
 *
 * `update()` 的语义是「有状态变了」，它**不告诉你是哪个字段**：一次流式增量、
 * 一次工具输出刷新都会触发订阅。若不加这道闸，就会在每条 token 到达时都调一次
 * `setFontSizeScale` / `setColorMode` —— 两个系统级调用，代价不小，且反复重设
 * 极可能让界面持续重排（肉眼可见的抖动）。所以只在真正变化时下发。
 */
function syncAppearance(): void {
  const vm: HarnessViewModel | null = instance;
  const context: common.Context | null = appContext;
  if (vm === null || context === null) {
    return;
  }
  const state: HarnessState = vm.state;
  if (state.fontScale === appliedFontScale
    && state.fontFollowsSystem === appliedFontFollowsSystem
    && state.themeMode === appliedThemeMode) {
    return;
  }
  appliedFontScale = state.fontScale;
  appliedFontFollowsSystem = state.fontFollowsSystem;
  appliedThemeMode = state.themeMode;
  // 字号：跟随系统时由平台层取当前系统档位（原因见 `applyAppFontScale` 的注释）。
  applyAppFontScale(context, state.fontScale, state.fontFollowsSystem);
  applyAppThemeMode(context, state.themeMode);
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
  appContext = null;
}
