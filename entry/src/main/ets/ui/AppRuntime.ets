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

import { common, ConfigurationConstant } from '@kit.AbilityKit';
import { HarnessState, HarnessViewModel } from '../core/HarnessViewModel';
import { applyAppFontScale, applyAppThemeMode, createHarnessDeps } from '../platform/Platform';
import { getPalette, normalizePaletteName } from '../core/ThemePalettes';

/** AppStorage 里放 revision 的键名。 */
export const REVISION_KEY: string = 'dshRevision';

/**
 * 当前配色名在 `AppStorage` 里的键（`paper` / `warm` / `mist` / `ink`）。
 *
 * 为什么不复用 `dshRevision`：配色页面底色（方案 A）的接线点是各容器属性表达式里的
 * `themedPageBgColor(...)` 调用，而 revision 的读取往往隔在 `st()` / `@Builder` 的
 * 另一层作用域里，根容器的属性表达式登记不到这条依赖。配色名单独占一个键，
 * 让组件用 `@StorageLink('dshPaletteName')` 并在属性表达式里**直读**它 ——
 * 依赖一定登记在「刷底色」的那个组件自己身上。附带好处是只有配色变化才触发这几处
 * 重绘，比 revision 那个「什么都广播」的键窄得多。
 */
export const PALETTE_KEY: string = 'dshPaletteName';

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

/**
 * 「系统返回键要求弹未保存确认」的请求序号。
 *
 * 与 `FILES_REVEAL_SEQ_KEY` 是同一套邮箱走法，只是方向反过来：这一次是**父页（入口页）
 * 请求子页弹面板**。`onBackPress` 只能挂在 `@Entry` 组件上（`pages/Index.ets`），
 * 而那个「未保存改动」的面板由 `ui/FilesScreen.ets` 持有（它才有 `bindSheet` 宿主）。
 * 入口页拿不到子组件的方法，于是写一个递增序号，`FilesScreen` 用 `@StorageLink` +
 * `@Watch` 收到后开面板。
 *
 * 为什么**必须**有这一条：顶栏返回箭头只是离开编辑器的其中一条路径，
 * 系统返回键/侧滑手势是另一条 —— 只拦一处，等于「不用点那个按钮就能绕过未保存确认」，
 * 那道确认就白做了（源工程 `FilesScreen.kt:216` 的原话）。
 */
export const UNSAVED_BACK_SEQ_KEY: string = 'dshUnsavedBackSeq';

/** 发一次「请弹出未保存改动确认」的请求（由入口页的系统返回拦截调用）。 */
export function requestUnsavedPrompt(): void {
  const seq: number = AppStorage.get<number>(UNSAVED_BACK_SEQ_KEY) ?? 0;
  AppStorage.setOrCreate(UNSAVED_BACK_SEQ_KEY, seq + 1);
}

/**
 * 当前主界面分节（`MainSection` 的原始数值）在 `AppStorage` 里的键。
 *
 * 入口页的 `onBackPress` 需要知道「此刻停在哪个分节」才能决定要不要为未保存改动
 * 拦下这次返回 —— 而分节是外壳 `AppShell` 自己的 `@State`，入口页读不到。
 * 于是外壳每次切分节就把它写进 `AppStorage`，入口页现读现用。
 *
 * 存原始数值而不是 `MainSection`：`AppRuntime` 是 core 与 UI 之间的桥，
 * 不该反过来依赖 `ui/AppShell.ets`（那会绕成环）。
 */
export const MAIN_SECTION_KEY: string = 'dshMainSection';

/** 分节原始数值（`MainSection.Files` 见 `ui/AppShell.ets`）；不可知时返回 -1。 */
export function currentMainSection(): number {
  return AppStorage.get<number>(MAIN_SECTION_KEY) ?? -1;
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
    AppStorage.setOrCreate(PALETTE_KEY, vm.state.paletteName);
    syncAppearance();
  });
  instance = vm;
  AppStorage.setOrCreate(REVISION_KEY, vm.revision);
  AppStorage.setOrCreate(PALETTE_KEY, vm.state.paletteName);
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

/**
 * 当前配色下的页面背景色；PAPER（默认）返回 `null` —— 调用方回落系统背景资源。
 *
 * ## 为什么配色要管到页面背景
 *
 * 手势导航模式下系统**不渲染**导航条底色（真机实测像素恒白，见 PORT-MAP），
 * 配色只写 `navigationBarColor` 等于什么都没干 —— 用户反馈「配色点了没变化」。
 * 所以非默认配色把整页底色刷成与导航栏同色（`ThemePalette.pageBg`），让选择真正可见。
 *
 * ## 为什么 PAPER 返回 null 而不是一个白 hex
 *
 * 默认外观必须与接入前**像素级一致**（ThemePalettes 文件头的纪律）：
 * 系统背景资源（`ohos_id_color_background`）随深浅色自动走，硬编码一份 hex 反而漂移。
 *
 * ## 响应式前提
 *
 * 调用组件必须自己持有 `@StorageLink('dshPaletteName')` 并在**本组件 build 作用域的
 * 属性表达式里直读它**、作为 `paletteName` 参数传进来（不复用 `dshRevision`，
 * 理由见 `PALETTE_KEY` 的注释）。本函数体内不读任何响应式状态。
 * 深浅色切换靠页面上其它 `sys.color.*` 资源引用触发重绘，届时本函数重读 colorMode。
 */
export function themedPageBgColor(hostContext: common.Context | undefined,
  paletteName: string): string | null {
  const name: string = normalizePaletteName(paletteName);
  let dark: boolean = false;
  if (hostContext !== undefined) {
    // COLOR_MODE_DARK = 0，别按直觉记反（PORT-MAP 坑 20）。
    dark = (hostContext as common.UIAbilityContext).config.colorMode
      === ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
  }
  return getPalette(name, dark).pageBg;
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
    // 先发起复核，再接事件流。复核是异步的（真正的结果要等 health 返回），
    // 所以它并不能"挡住"事件流；两者的收敛路径是各自的：复核失败摘掉 `active`，
    // 事件流断开走它自己的重连/报错。放在前面只是为了让它尽早开始。
    // 对应源工程 `MainActivity.onResume` 里的 `recheckConnectionIfOnConnectScreen()`。
    vm.recheckConnectionIfOnConnectScreen();
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
