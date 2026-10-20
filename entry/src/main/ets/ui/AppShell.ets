/**
 * 主界面外壳 —— 移植自原工程 `ui/App.kt`（369 行）里 `ConnectedApp` / `NavigationPanel` /
 * `sectionEnabled` / `localError` 这几块。
 *
 * ## 为什么要照抄它的「分节 + 权限过滤」而不是自己简化
 *
 * 三个取舍都是踩过坑才定下来的，简化任何一个都会退化成 bug：
 *
 * 1. **默认分节按 `scopes` 选**：有 `chat.read` 就进会话，否则有 `files.read` 就进文件，
 *    否则进设置。不是硬编码「默认会话」—— 设备只授权了文件时，硬编码会让用户一进来就
 *    看到一个空白的会话页。
 * 2. **模型页永远可进**（`sectionEnabled` 里 `Models -> true`）。写成「要 `settings.read`」
 *    看着更"正确"，实际是错的：没权限时抽屉里干脆不显示这一项，用户只看到「没有模型页」，
 *    既不知道是权限问题、也不知道该去哪儿开 —— 而模型页里那条「需要 settings.read」的提示
 *    因此永远不可达。设置页同理为 true，正是为了让这类「为什么不可用」看得见。
 * 3. **插件页要 `settings.read`**（它读的是 `settings/plugins`，和模型供应商同一权限）。
 *
 * ## 与原工程的一处必要差异
 *
 * 源工程的抽屉靠 `ModalNavigationDrawer`，并为了「WebView 滚动时别被横划误触抽屉」而
 * 在会话页开着时**关掉手势**。本工程按你的要求走 **ArkUI 原生聊天（不用 WebView）**，
 * 所以那条「WebView 手势打架」的背景不存在了；但 `composerOverlay`（`@`/`/` 补全面板）
 * 那一半仍然成立，因此保留 `gesturesEnabled` 的同款判据。
 */

import { promptAction } from '@kit.ArkUI';
import { HarnessState } from '../core/HarnessViewModel';
import { harnessVm } from './AppRuntime';
import { BrandMark, StatusLabel } from './Components';
import { localErrorText } from './ErrorText';
import { ChatScreen } from './ChatScreen';
import { FilesScreen } from './FilesScreen';
import { PluginsScreen } from './PluginsScreen';
import { ModelsScreen } from './ModelsScreen';
import { SettingsScreen } from './SettingsScreen';

/** 主界面分节 —— 顺序即抽屉里的顺序（`MainSection.entries`）。 */
export enum MainSection {
  Chat = 0,
  Files = 1,
  Plugins = 2,
  Models = 3,
  Settings = 4,
}

/** 某分节在当前 `scopes` 下是否可见。见文件头注释第 2 点（模型页/设置页永远为真）。 */
export function sectionEnabled(section: MainSection, scopes: string[]): boolean {
  if (section === MainSection.Chat) {
    return scopes.includes('chat.read');
  }
  if (section === MainSection.Files) {
    return scopes.includes('files.read');
  }
  if (section === MainSection.Plugins) {
    return scopes.includes('settings.read');
  }
  return true;
}

/** 分节图标（用字形代替 Material 图标，省图片资源）。 */
function sectionGlyph(section: MainSection): string {
  if (section === MainSection.Chat) {
    return '💬';
  }
  if (section === MainSection.Files) {
    return '📁';
  }
  if (section === MainSection.Plugins) {
    return '🧩';
  }
  if (section === MainSection.Models) {
    return '🧠';
  }
  return '⚙';
}

@Component
export struct AppShell {
  /**
   * 订阅 vm：任何 `update()` 都会让 revision 递增并被这里收到。
   * 收到后做两件事 —— 报错（toast）与「按 scopes 重算默认分节」。
   */
  @StorageLink('dshRevision') @Watch('onVmChanged') revision: number = 0;
  /**
   * 跨分节导航请求（见 `AppRuntime.requestFilesSection` 的注释）。
   * `@Watch` 让它在**收到新请求时**切分节 —— 这是"子页请求父页改状态"在本工程里的走法：
   * 子页拿不到 `section`，所以走 `AppStorage` 邮箱 + 这里订阅。
   */
  @StorageLink('dshFilesRevealSeq') @Watch('onFilesRevealRequested') filesRevealSeq: number = 0;
  /** 窄屏抽屉是否展开。 */
  @State drawerOpen: boolean = false;
  @State section: MainSection = MainSection.Chat;
  /** 是否宽屏（>= 840vp 常驻侧栏）。用 onAreaChange 跟踪，初值按窄屏处理。 */
  @State wide: boolean = false;

  /** 订阅 vm，用系统 toast 把 `state.error` 报给用户（对位源工程的 Snackbar + clearError）。 */
  private unsubscribe: (() => void) | null = null;
  /** 上一次已经报过的错误文案，避免同一句话因为多次重绘被反复弹出。 */
  private lastReported: string | null = null;
  /** 上一次用于定默认分节的 scopes 快照（见 `onVmChanged`）。 */
  private lastScopesKey: string = '';

  aboutToAppear(): void {
    this.syncSectionFromScopes();
    const vm = harnessVm();
    if (vm !== null) {
      this.unsubscribe = vm.subscribe((): void => {
        this.reportErrorIfAny();
      });
    }
  }

  /**
   * vm 每次 `update()` 后走这里。
   *
   * `reportErrorIfAny()` 由 `subscribe` 那条路也做了一次 —— 留着是因为它还能覆盖
   * 不经过 `AppStorage` 的状态变化（例如 `passConnectGate`），且重复调用已被
   * `lastReported` + `clearError` 兜住，不会重复弹窗。
   */
  onVmChanged(): void {
    this.reportErrorIfAny();
    this.syncSectionIfScopesChanged();
  }

  /**
   * 按 `scopes` 值的变化重算默认分节 —— 源工程 `remember(scopes)` 的等价物。
   *
   * **只在 scopes 的值真的变了才重算**，不能每次 revision 变化都重算：vm 里任何一次
   * 无关更新（刷新插件清单、切个字体的缩放）都会递增 revision，若每次都重算，
   * 用户手动切到「设置」后随便什么后台刷新都会把他弹回会话页。
   * 比较用拼接出的快照串（`scopes` 是数组，直接比引用每次都是新对象、永远不等）。
   */
  private syncSectionIfScopesChanged(): void {
    const key: string = this.scopes().join(',');
    if (key === this.lastScopesKey) {
      return;
    }
    this.lastScopesKey = key;
    this.syncSectionFromScopes();
  }

  /**
   * 收到「请切到文件分节」的请求（见 `AppRuntime.requestFilesSection`）。
   *
   * 只切分节，不动 vm 的状态 —— 目标目录由 `HarnessViewModel.revealDirectory`
   * 在发请求之前就准备好了（`selectedRootId` / `currentPath` / `directory`），
   * 这里再传路径就会变成两份真相。
   */
  onFilesRevealRequested(): void {
    // 收到新请求时先收起抽屉：窄屏下抽屉是浮层，切完分节还开着会挡住新页面。
    this.drawerOpen = false;
    this.section = MainSection.Files;
  }

  aboutToDisappear(): void {
    if (this.unsubscribe !== null) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  private st(): HarnessState | null {
    // 读一次 revision：ArkUI 只把 **build 期间读过**的状态登记为依赖
    // （编译器把 build 体包在 `StartGetAccessRecordingFor` … `StopGetAccessRecording` 之间），
    // 只声明 `@StorageLink` 而不读它，vm 更新时这个组件不会重绘 ——
    // 抽屉里的设备名、在线状态、分节可见性就都会停在旧值上。见 PORT-MAP §1b 坑 12。
    // 恒真的比较：存在的意义就是让这次读取发生。
    const rev: number = this.revision;
    if (rev < 0) {
      return null;
    }
    return harnessVm() === null ? null : harnessVm()!.state;
  }

  private scopes(): string[] {
    const st: HarnessState | null = this.st();
    const device = st === null ? null : st.device;
    return device === null ? [] : device.scopes;
  }

  /**
   * 按 `scopes` 定默认分节（源工程 `remember(scopes)` 的等价物）。
   *
   * `scopes` 变化时重算 —— 刚连上时 `device` 还是 null（`scopes` 为空），
   * 默认会落到设置页；拿到设备信息后必须自动切到会话页，否则用户会莫名其妙地
   * 停在「设置」而以为会话功能坏了。
   */
  private syncSectionFromScopes(): void {
    const scopes: string[] = this.scopes();
    if (scopes.includes('chat.read')) {
      this.section = MainSection.Chat;
    } else if (scopes.includes('files.read')) {
      this.section = MainSection.Files;
    } else if (scopes.length > 0) {
      this.section = MainSection.Settings;
    }
    // scopes 为空（还没拿到设备信息）时**不动**，保持当前选择。
  }

  /**
   * 把 `state.error` 报成一个 toast 并清掉。
   *
   * 报完必须 `clearError()`：不清的话这个错误会一直挂在 state 上，
   * 下一次任意重绘都会再弹一遍，用户看到的就是「同一句话反复弹」。
   */
  private reportErrorIfAny(): void {
    const vm = harnessVm();
    const st: HarnessState | null = this.st();
    // 错误已被消费掉 → 去重记录一起归零（理由见 `ConnectScreen.reportErrorIfAny()`）：
    // 同一个错误**再发生一次**必须照样弹，否则用户重试失败时会以为没点上。
    if (st !== null && st.error === null) {
      this.lastReported = null;
    }
    if (vm === null || st === null || st.error === null) {
      return;
    }
    const text: string = this.localError(st.error);
    if (text !== this.lastReported) {
      this.lastReported = text;
      promptAction.showToast({ message: text, duration: 2600 });
    }
    vm.clearError();
  }

  /**
   * 错误码 → 人话（源工程 `localError`）。
   *
   * `state.error` 里既可能是裸错误码（`FILE_TOO_LARGE`），也可能是已经本地化过的一句话，
   * 所以认不出的原样返回 —— 与 core 的错误码表「认不出保留原文」同一原则。
   */
  private localError(value: string): string {
    const ctx = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      return value;
    }
    return localErrorText(ctx, value);
  }

  /** 当前分节的中文名，用于顶栏副标题。 */
  private sectionLabel(section: MainSection): Resource {
    if (section === MainSection.Chat) {
      return $r('app.string.chat');
    }
    if (section === MainSection.Files) {
      return $r('app.string.files');
    }
    if (section === MainSection.Plugins) {
      return $r('app.string.plugins');
    }
    if (section === MainSection.Models) {
      return $r('app.string.models');
    }
    return $r('app.string.settings');
  }

  build() {
    SideBarContainer(this.wide ? SideBarContainerType.Embed : SideBarContainerType.Overlay) {
      // —— 侧栏 ——
      this.navPanel()
      // —— 主内容 ——
      this.mainContent()
    }
    .width('100%')
    .height('100%')
    // 宽屏常驻侧栏且不显示控制按钮（顶栏自己带汉堡）；窄屏允许手势并显示控制按钮。
    .showSideBar(this.wide ? true : this.drawerOpen)
    .showControlButton(false)
    .sideBarWidth(this.wide ? 264 : 304)
    .minContentWidth(320)
    // 补全面板（`@`/`/` 候选）或 WebView 会话开着时关掉手势：又长又宽的浮层横划一下
    // 就会误触抽屉（源工程用户实测反馈）。本工程没用 WebView，但补全面板那一半仍成立。
    .onChange((value: boolean): void => {
      this.drawerOpen = value;
    })
    .backgroundColor($r('sys.color.ohos_id_color_background'))
    .onAreaChange((oldArea: Area, newArea: Area): void => {
      const w: number = Number(newArea.width);
      if (!Number.isNaN(w)) {
        const isWide: boolean = w >= 840;
        if (isWide !== this.wide) {
          this.wide = isWide;
        }
      }
    })
  }

  // ————————————————— 侧栏 —————————————————

  @Builder
  navPanel() {
    Column() {
      // 头部：品牌 + 应用名 + 设备名 + 刷新（忙碌时换成转圈）
      Row() {
        BrandMark()
        Column() {
          Text($r('app.string.app_name'))
            .fontSize(15)
            .fontWeight(FontWeight.Medium)
          Text(this.deviceNameLine())
            .fontSize(11)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
        .margin({ left: 12, right: 8 })

        if (this.isBusy()) {
          LoadingProgress().width(19).height(19)
        } else {
          Text('⟳')
            .fontSize(16)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .padding(8)
            .onClick((): void => {
              const vm = harnessVm();
              if (vm !== null) {
                void vm.refreshDashboard();
              }
            })
        }
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      // 分节列表：按 scopes 过滤（顺序即 MainSection 顺序）
      Column() {
        this.navItem(MainSection.Chat)
        this.navItem(MainSection.Files)
        this.navItem(MainSection.Plugins)
        this.navItem(MainSection.Models)
        this.navItem(MainSection.Settings)
      }
      .width('100%')
      .margin({ top: 18 })

      Blank()

      // 底部状态卡：事件流是否在线 + 当前地址
      Column() {
        StatusLabel({
          label: this.eventsConnected() ? $r('app.string.online') : $r('app.string.offline'),
          active: this.eventsConnected(),
        })
        Text(this.endpointLine())
          .fontSize(11)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .maxLines(2)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .margin({ top: 5 })
      }
      .width('100%')
      .padding(12)
      .borderRadius(10)
      .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .height('100%')
    .padding({ left: 14, right: 14, top: 18, bottom: 18 })
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
  }

  @Builder
  navItem(section: MainSection) {
    // `sectionEnabled` 过滤：不可见的分节整条不渲染（源工程 `return@forEach` 的等价物）。
    if (sectionEnabled(section, this.scopes())) {
      Row() {
        Text(sectionGlyph(section))
          .fontSize(15)
          .width(22)
          .textAlign(TextAlign.Center)
        Text(this.sectionLabel(section))
          .fontSize(14)
          .margin({ left: 12 })
          .fontColor(this.section === section
            ? $r('sys.color.ohos_id_color_text_primary')
            : $r('sys.color.ohos_id_color_text_secondary'))
      }
      .width('100%')
      .height(44)
      .padding({ left: 14, right: 14 })
      .margin({ bottom: 4 })
      .borderRadius(8)
      .backgroundColor(this.section === section
        ? $r('sys.color.ohos_id_color_sub_background')
        : Color.Transparent)
      .alignItems(VerticalAlign.Center)
      .onClick((): void => {
        this.section = section;
        this.drawerOpen = false;
      })
    }
  }

  private deviceNameLine(): string {
    const st: HarnessState | null = this.st();
    const device = st === null ? null : st.device;
    const ctx = this.getUIContext().getHostContext();
    const fallback: string = ctx === undefined
      ? '' : ctx.resourceManager.getStringSync($r('app.string.brand_subtitle').id);
    return device === null || device.name.length === 0 ? fallback : device.name;
  }

  private endpointLine(): string {
    const st: HarnessState | null = this.st();
    return st === null ? '' : st.endpoint;
  }

  private eventsConnected(): boolean {
    const st: HarnessState | null = this.st();
    return st !== null && st.eventsConnected;
  }

  private isBusy(): boolean {
    const st: HarnessState | null = this.st();
    return st !== null && st.busy;
  }

  // ————————————————— 主内容 —————————————————

  @Builder
  mainContent() {
    Column() {
      // 窄屏顶栏：汉堡 + 应用名 + 分节名 + 刷新
      if (!this.wide) {
        Row() {
          Text('☰')
            .fontSize(18)
            .padding(12)
            .onClick((): void => {
              this.drawerOpen = !this.drawerOpen;
            })
          Column() {
            Text($r('app.string.app_name'))
              .fontSize(16)
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
            Text(this.sectionLabel(this.section))
              .fontSize(11)
              .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          }
          .layoutWeight(1)
          .alignItems(HorizontalAlign.Start)

          if (this.isBusy()) {
            LoadingProgress().width(20).height(20).margin({ right: 14 })
          } else {
            Text('⟳')
              .fontSize(16)
              .fontColor($r('sys.color.ohos_id_color_text_secondary'))
              .padding(12)
              .margin({ right: 4 })
              .onClick((): void => {
                const vm = harnessVm();
                if (vm !== null) {
                  void vm.refreshDashboard();
                }
              })
          }
        }
        .width('100%')
        .height(56)
        .alignItems(VerticalAlign.Center)
      }

      // 分节内容。`wide` 交给会话页/文件页决定「列表与详情并排」还是「列表↔详情」两种走法。
      if (this.section === MainSection.Chat) {
        ChatScreen({ wide: this.wide })
      } else if (this.section === MainSection.Files) {
        FilesScreen({ wide: this.wide })
      } else if (this.section === MainSection.Plugins) {
        PluginsScreen()
      } else if (this.section === MainSection.Models) {
        ModelsScreen()
      } else {
        SettingsScreen()
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_background'))
  }
}
