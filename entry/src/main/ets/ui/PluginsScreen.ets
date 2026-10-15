/**
 * 插件分节 —— 移植自原工程 `ui/PluginsScreen.kt`（464 行）的
 * `PluginsScreen` / `PluginRow` / `PluginStateBadge` / `OfficialBadge` / `InventoryStat` /
 * `LoadingInventory` / `UnavailableInventory`。
 *
 * ## 这个分节解决什么问题
 *
 * 看清当前 profile 里装了什么插件、哪些真的加载了。「声明了要加载、实际却缺失」
 * （`declared-missing`）是这里最需要提醒用户的异常状态：**对应的功能会静默不可用**，
 * 而插件是否加载只由服务器决定，App 无法代劳 —— 所以问题条数用警告色 + 提示条单独顶出来，
 * 而不是混在普通列表里（照抄源工程的做法）。
 *
 * ## 四条判据照抄源工程，不许"优化"
 *
 * 1. **四种插件状态必须都认得**（`loaded` / `runtime-provided` / `installed-not-loaded` /
 *    `declared-missing`）。`runtime-provided` 是官方包随 DSH 运行时自带的正常状态
 *    （它们不在 profile 的 node_modules 里），服务端已把它排除在 `problemCount` 之外；
 *    UI 若不认识它，一台健康的机器会冒出一排「状态未知」。未知取值走兜底，不在解码层抛错。
 * 2. **启停不直接在开关上执行**：改 profile 的 package.json 是**有后果**的操作
 *    （写坏了 dsh 下次起不来），先弹一句确认、让用户看清要动的是哪个插件。
 * 3. **不能启停的原因要说出来**（官方包 / 声明缺失 / 没装），否则用户会去找一个根本不存在的开关。
 * 4. **更新提示三态**：只在 `updateAvailable == true && latestVersion != null` 时显示
 *    「有新版本 x」；`updateAvailable == null`（没查）什么都不显示 —— 显示「已是最新」是撒谎，
 *    显示「未知」是噪音。
 *
 * ## 三处平台差异
 *
 * 1. **`Switch` → `Toggle({ type: ToggleType.Switch })`**；`enabled` 用通用属性 `.enabled()`。
 * 2. **确认弹窗用系统 `showAlertDialog`**。本页只有一个弹窗（不像详情页/文件页要合成 `bindSheet`），
 *    而且内容就是「标题 + 一句话 + 两个按钮」，与源工程的 `AlertDialog` 结构一致，
 *    所以走系统弹窗这条最短路径。
 * 3. **`widthIn(max = 720.dp)` → `constraintSize({ maxWidth: 720 })`**，外层 `Column`
 *    用 `alignItems(HorizontalAlign.Center)` 复现 `horizontalAlignment = CenterHorizontally`。
 */

import { common } from '@kit.AbilityKit';
import { PluginEntry, PluginInventory } from '../core/Models';
import { HarnessState, HarnessViewModel } from '../core/HarnessViewModel';
import { harnessState, harnessVm } from './AppRuntime';
import { WarningBanner } from './Components';
import { openExternalUrl } from '../platform/ExternalOpen';

/** 服务端约定的四种插件状态（见文件头判据 1）。 */
const STATE_LOADED: string = 'loaded';
const STATE_RUNTIME_PROVIDED: string = 'runtime-provided';
const STATE_INSTALLED_NOT_LOADED: string = 'installed-not-loaded';
const STATE_DECLARED_MISSING: string = 'declared-missing';

/** 内容最大宽度（对位源工程 `widthIn(max = 720.dp)`）。 */
const CONTENT_MAX_WIDTH: number = 720;

/** 状态徽章的五档（`stateKind` 的返回值）。 */
const STATE_KIND_LOADED: number = 0;
const STATE_KIND_RUNTIME_PROVIDED: number = 1;
const STATE_KIND_INSTALLED_NOT_LOADED: number = 2;
const STATE_KIND_DECLARED_MISSING: number = 3;
const STATE_KIND_UNKNOWN: number = 4;

/**
 * 一个插件行。
 *
 * 单独成一个组件而不是 `@Builder`：它自己要看状态、算文案、画开关，
 * 拆出来能让「读一次 entry 的各个可空字段」这件事落在方法体里
 * （`@Builder` 里不能声明局部变量，也不能对可空取值做两次调用的窄化 —— 见 PORT-MAP §1b 坑 5、坑 8）。
 */
@Component
struct PluginRow {
  entry: PluginEntry = new PluginEntry();
  canWrite: boolean = false;
  busy: boolean = false;
  onToggle: (name: string, enable: boolean) => void = (): void => {};

  // ——— 状态徽章 ———

  private stateKind(): number {
    const state: string = this.entry.state;
    if (state === STATE_LOADED) {
      return STATE_KIND_LOADED;
    }
    if (state === STATE_RUNTIME_PROVIDED) {
      return STATE_KIND_RUNTIME_PROVIDED;
    }
    if (state === STATE_INSTALLED_NOT_LOADED) {
      return STATE_KIND_INSTALLED_NOT_LOADED;
    }
    if (state === STATE_DECLARED_MISSING) {
      return STATE_KIND_DECLARED_MISSING;
    }
    return STATE_KIND_UNKNOWN;
  }

  private stateLabel(): ResourceStr {
    const kind: number = this.stateKind();
    if (kind === STATE_KIND_LOADED) {
      return $r('app.string.plugins_state_loaded');
    }
    if (kind === STATE_KIND_RUNTIME_PROVIDED) {
      return $r('app.string.plugins_state_runtime_provided');
    }
    if (kind === STATE_KIND_INSTALLED_NOT_LOADED) {
      return $r('app.string.plugins_state_installed_not_loaded');
    }
    if (kind === STATE_KIND_DECLARED_MISSING) {
      return $r('app.string.plugins_state_declared_missing');
    }
    return $r('app.string.plugins_state_unknown');
  }

  /**
   * 徽章底色。
   *
   * 鸿蒙的语义色里没有与 `primaryContainer` / `errorContainer` 成对的容器色，
   * 这里用系统定义的两档填充色 + 一个「警告色整块」来对应，
   * 并让标签文字自己是白色（`foreground_contrary`）—— 深浅色下都读得清。
   */
  private stateBg(): Resource {
    const kind: number = this.stateKind();
    if (kind === STATE_KIND_LOADED) {
      return $r('sys.color.ohos_id_color_emphasize');
    }
    if (kind === STATE_KIND_DECLARED_MISSING) {
      return $r('sys.color.ohos_id_color_warning');
    }
    return $r('sys.color.ohos_id_color_component_normal');
  }

  private stateFg(): Resource {
    const kind: number = this.stateKind();
    if (kind === STATE_KIND_LOADED || kind === STATE_KIND_DECLARED_MISSING) {
      return $r('sys.color.ohos_id_color_foreground_contrary');
    }
    if (kind === STATE_KIND_RUNTIME_PROVIDED) {
      return $r('sys.color.ohos_id_color_text_primary');
    }
    return $r('sys.color.ohos_id_color_text_secondary');
  }

  // ——— 文本行 ———

  private hasDescription(): boolean {
    const description: string | null = this.entry.description;
    return description !== null && description.trim().length > 0;
  }

  private descriptionText(): string {
    return this.entry.description ?? '';
  }

  /**
   * 「实际版本 x」那一行。
   *
   * 官方包不在 profile 的 node_modules 里，报「版本未知」会制造假警报 ——
   * 所以 `runtime-provided` 走另一句文案。
   */
  private installedLine(): ResourceStr {
    const installed: string | null = this.entry.installed;
    if (installed !== null) {
      return $r('app.string.plugins_installed_version', installed);
    }
    if (this.entry.state === STATE_RUNTIME_PROVIDED) {
      return $r('app.string.plugins_version_runtime_provided');
    }
    return $r('app.string.plugins_installed_version', this.resText($r('app.string.plugins_version_unknown')));
  }

  private hasDeclared(): boolean {
    return this.entry.declared !== null;
  }

  private declaredLine(): ResourceStr {
    return $r('app.string.plugins_declared', this.entry.declared ?? '');
  }

  /** 更新提示只在**确实有新版本**时出现（见文件头判据 4）。 */
  private hasUpdate(): boolean {
    return this.entry.updateAvailable === true && this.entry.latestVersion !== null;
  }

  private updateLine(): ResourceStr {
    return $r('app.string.plugins_update_available', this.entry.latestVersion ?? '');
  }

  private hasHomepage(): boolean {
    const homepage: string | null = this.entry.homepage;
    return homepage !== null && homepage.trim().length > 0;
  }

  private homepageUrl(): string {
    return this.entry.homepage ?? '';
  }

  /** 用系统浏览器打开插件主页；失败只静默（主页来自第三方包的 package.json，值可能系统不认）。 */
  private openHomepage(): void {
    const ctx: common.Context | undefined = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      return;
    }
    openExternalUrl(ctx, this.homepageUrl());
  }

  /** 不能启停的原因（见文件头判据 3）。 */
  private lockedReason(): ResourceStr {
    if (this.entry.official) {
      return $r('app.string.plugins_toggle_official_locked');
    }
    if (this.entry.state === STATE_DECLARED_MISSING) {
      return $r('app.string.plugins_toggle_missing_locked');
    }
    return $r('app.string.plugins_toggle_not_installed_locked');
  }

  /** 开关只在「能启停 + 有写权限」时出现（源工程同款判据）。 */
  private showSwitch(): boolean {
    return this.entry.toggleable && this.canWrite;
  }

  private resText(res: Resource): string {
    const ctx: common.Context | undefined = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      return '';
    }
    return ctx.resourceManager.getStringSync(res.id);
  }

  @Builder
  stateBadge() {
    Text(this.stateLabel())
      .fontSize(11)
      .fontColor(this.stateFg())
      .padding({ left: 8, right: 8, top: 4, bottom: 4 })
      .borderRadius(4)
      .backgroundColor(this.stateBg())
      .maxLines(1)
  }

  @Builder
  officialBadge() {
    Text($r('app.string.plugins_official'))
      .fontSize(11)
      .fontColor($r('sys.color.ohos_id_color_text_secondary'))
      .padding({ left: 6, right: 6, top: 2, bottom: 2 })
      .borderRadius(4)
      .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
      .margin({ left: 8 })
  }

  build() {
    Row() {
      Column() {
        Row() {
          Text(this.entry.name)
            .fontSize(14)
            .fontWeight(FontWeight.Medium)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1)
          if (this.entry.official) {
            this.officialBadge()
          }
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)

        // 简介：手机上只有一串 @scope/name@1.2.3 时，用户没法判断「这个能不能停用」。
        if (this.hasDescription()) {
          Text(this.descriptionText())
            .fontSize(12)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .margin({ top: 2 })
            .width('100%')
        }

        Text(this.installedLine())
          .fontSize(12)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .margin({ top: 2 })
          .width('100%')

        if (this.hasDeclared()) {
          Text(this.declaredLine())
            .fontSize(12)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .width('100%')
        }

        if (this.hasUpdate()) {
          Text(this.updateLine())
            .fontSize(12)
            .fontColor($r('sys.color.ohos_id_color_emphasize'))
            .margin({ top: 2 })
            .width('100%')
        }

        if (this.hasHomepage()) {
          Text($r('app.string.plugins_homepage'))
            .fontSize(12)
            .fontColor($r('sys.color.ohos_id_color_emphasize'))
            .margin({ top: 4 })
            .onClick((): void => {
              this.openHomepage();
            })
        }

        if (!this.entry.toggleable) {
          Text(this.lockedReason())
            .fontSize(11)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .margin({ top: 3 })
            .width('100%')
        }
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      Column() {
        this.stateBadge()
        // 没权限时**不画一个点了会失败的开关**（页面顶部那条横幅已经说明缺什么）。
        if (this.showSwitch()) {
          Toggle({ type: ToggleType.Switch, isOn: this.entry.loaded })
            .enabled(!this.busy)
            .margin({ top: 3 })
            .onChange((isOn: boolean): void => {
              this.onToggle(this.entry.name, isOn);
            })
        }
      }
      .alignItems(HorizontalAlign.End)
      .margin({ left: 12 })
    }
    .width('100%')
    .padding(16)
    .alignItems(VerticalAlign.Center)
  }
}

/** 插件分节的宿主：按权限/清单状态四态分派（源工程 `when {}`）。 */
@Component
export struct PluginsScreen {
  @StorageLink('dshRevision') revision: number = 0;

  /** vm 还没装配时的兜底状态。 */
  private fallback: HarnessState = new HarnessState();
  /** 清单为 null 时用的空对象（避免在 `@Builder` 里对可空取值做窄化，见 PORT-MAP §1b 坑 8）。 */
  private emptyInventory: PluginInventory = new PluginInventory();
  /** 「进来且清单为空」只自动补拉一次（对位源工程 `LaunchedEffect(canRead, inventory)` 的语义）。 */
  private requestedOnce: boolean = false;

  aboutToAppear(): void {
    this.refreshIfNeeded();
  }

  private st(): HarnessState {
    // 读一次 revision：ArkUI 只把 **build 期间读过**的状态登记为依赖
    // （编译器把 build 体包在 `StartGetAccessRecordingFor` … `StopGetAccessRecording` 之间），
    // 只声明 `@StorageLink` 而不读它，vm 更新时这个组件不会重绘。见 PORT-MAP §1b 坑 12。
    // 恒真的比较：存在的意义就是让这次读取发生。
    const rev: number = this.revision;
    return rev >= 0 ? (harnessState() ?? this.fallback) : this.fallback;
  }

  private vm(): HarnessViewModel | null {
    return harnessVm();
  }

  private scopes(): string[] {
    const device = this.st().device;
    return device === null ? [] : device.scopes;
  }

  private canRead(): boolean {
    return this.scopes().includes('settings.read');
  }

  private canWrite(): boolean {
    return this.scopes().includes('settings.write');
  }

  private hasInventory(): boolean {
    return this.st().pluginInventory !== null;
  }

  /** 清单的非空取值：`hasInventory()` 为假时给空对象（见字段注释）。 */
  private inv(): PluginInventory {
    return this.st().pluginInventory ?? this.emptyInventory;
  }

  /**
   * 连接时的快照通常已经带来清单；只有拿不到（首次进入此页、上一次读取失败）时才补一次请求。
   *
   * 这条判据与源工程一致：**拉失败后不自动重试**（源工程 `LaunchedEffect` 的键没变就不会重跑），
   * 重试交给顶栏那个「刷新」。
   */
  private refreshIfNeeded(): void {
    if (this.requestedOnce || !this.canRead() || this.hasInventory()) {
      return;
    }
    this.requestedOnce = true;
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      void vm.refreshPluginInventory();
    }
  }

  private busy(): boolean {
    return this.st().busy;
  }

  private refreshEnabled(): boolean {
    return this.canRead() && !this.busy();
  }

  private doRefresh(): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      void vm.refreshPluginInventory();
    }
  }

  private doCheckUpdates(): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      void vm.refreshPluginInventoryWithUpdates();
    }
  }

  /** 清单读不到时的人话（源工程 `unavailableReason`）。 */
  private unavailableReason(): ResourceStr {
    const reason: string | null = this.inv().reason;
    if (reason === 'PROFILE_UNKNOWN') {
      return $r('app.string.plugins_unavailable_profile_unknown');
    }
    if (reason === 'MANIFEST_UNREADABLE') {
      return $r('app.string.plugins_unavailable_manifest_unreadable');
    }
    return $r('app.string.plugins_unavailable_generic', reason ?? 'UNKNOWN');
  }

  private hasProfile(): boolean {
    const profile: string | null = this.inv().profile;
    return profile !== null && profile.trim().length > 0;
  }

  private profileText(): string {
    return this.inv().profile ?? '';
  }

  private profileLine(): ResourceStr {
    return $r('app.string.plugins_profile', this.profileText());
  }

  private hasProfilePath(): boolean {
    const path: string | null = this.inv().profilePath;
    return path !== null && path.trim().length > 0;
  }

  private profilePathText(): string {
    return this.inv().profilePath ?? '';
  }

  private problemCount(): number {
    return this.inv().problemCount;
  }

  private loadedCount(): number {
    return this.inv().loadedCount;
  }

  /** 有可启停的插件时才提「要重启」——一个只读清单页说这句话是多余的。 */
  private hasToggleable(): boolean {
    const items: PluginEntry[] = this.inv().items;
    for (let i = 0; i < items.length; i++) {
      if (items[i].toggleable) {
        return true;
      }
    }
    return false;
  }

  /**
   * 启停前的确认弹窗。
   *
   * 用户按「取消」时不动任何状态（源工程 `pendingToggle = null`）；按确认才交给 vm，
   * 且 vm 自己会用全局 busy 挡住重复点击（这是改 profile package.json 的操作）。
   */
  private askToggle(name: string, enable: boolean): void {
    const actionLabel: Resource = enable
      ? $r('app.string.plugins_toggle_enable')
      : $r('app.string.plugins_toggle_disable');
    const actionText: string = this.resText(actionLabel);
    this.getUIContext().showAlertDialog({
      title: $r('app.string.plugins_toggle_confirm_title', actionText, name),
      message: enable
        ? $r('app.string.plugins_toggle_confirm_enable')
        : $r('app.string.plugins_toggle_confirm_disable'),
      autoCancel: true,
      primaryButton: {
        value: actionLabel,
        action: (): void => {
          const vm: HarnessViewModel | null = this.vm();
          if (vm !== null) {
            void vm.setPluginLoaded(name, enable);
          }
        },
      },
      secondaryButton: {
        value: $r('app.string.cancel'),
        action: (): void => {},
      },
    });
  }

  private resText(res: Resource): string {
    const ctx: common.Context | undefined = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      return '';
    }
    return ctx.resourceManager.getStringSync(res.id);
  }

  build() {
    Scroll() {
      Column() {
        Column() {
          // 头部：标题 + 副标题 + 「刷新」（忙碌或无权限时禁用）
          Row() {
            Column() {
              Text($r('app.string.plugins'))
                .fontSize(24)
                .fontWeight(FontWeight.Medium)
                .width('100%')
              Text($r('app.string.plugins_subtitle'))
                .fontSize(13)
                .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                .margin({ top: 4 })
                .width('100%')
            }
            .layoutWeight(1)
            .alignItems(HorizontalAlign.Start)

            Row() {
              Text('⟳')
                .fontSize(15)
                .fontColor($r('sys.color.ohos_id_color_text_primary'))
              Text($r('app.string.refresh'))
                .fontSize(13)
                .fontColor($r('sys.color.ohos_id_color_text_primary'))
                .margin({ left: 5 })
            }
            .padding({ left: 10, right: 10, top: 6, bottom: 6 })
            .borderRadius(6)
            .alignItems(VerticalAlign.Center)
            .opacity(this.refreshEnabled() ? 1 : 0.4)
            .enabled(this.refreshEnabled())
            .onClick((): void => {
              this.doRefresh();
            })
          }
          .width('100%')
          .alignItems(VerticalAlign.Center)

          Column().height(22)

          this.contentPane()
        }
        .width('100%')
        .constraintSize({ maxWidth: CONTENT_MAX_WIDTH })
      }
      .width('100%')
      .padding({ left: 20, right: 20, top: 28, bottom: 28 })
      .alignItems(HorizontalAlign.Center)
    }
    .width('100%')
    .height('100%')
    .align(Alignment.TopStart)
  }

  /** 四态分派（源工程 `when {}` 的顺序一字不改）。 */
  @Builder
  contentPane() {
    if (!this.canRead()) {
      WarningBanner({ message: $r('app.string.plugins_permission_required') })
    } else if (!this.hasInventory()) {
      this.loadingInventory()
    } else if (!this.inv().available) {
      this.unavailableInventory()
    } else {
      this.inventoryContent()
    }
  }

  @Builder
  loadingInventory() {
    Row() {
      LoadingProgress().width(26).height(26)
    }
    .width('100%')
    .height(92)
    .justifyContent(FlexAlign.Center)
    .alignItems(VerticalAlign.Center)
  }

  /** `available: false`：界面必须解释原因，而不是留一片空白。 */
  @Builder
  unavailableInventory() {
    Column() {
      WarningBanner({ message: this.unavailableReason() })
      if (this.hasProfile()) {
        Text(this.profileLine())
          .fontSize(12)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .margin({ top: 14, left: 4 })
          .width('100%')
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  statColumn(label: ResourceStr, value: number, alert: boolean) {
    Column() {
      Text(`${value}`)
        .fontSize(24)
        .fontWeight(FontWeight.Medium)
        .fontColor(alert
          ? $r('sys.color.ohos_id_color_warning')
          : $r('sys.color.ohos_id_color_text_primary'))
      Text(label)
        .fontSize(11)
        .fontColor(alert
          ? $r('sys.color.ohos_id_color_warning')
          : $r('sys.color.ohos_id_color_text_secondary'))
    }
    .alignItems(HorizontalAlign.Start)
    .margin({ right: 32 })
  }

  @Builder
  inventoryContent() {
    Column() {
      // 概览卡：档案名 + 路径 + 两个统计 + 「检查更新」
      Column() {
        if (this.hasProfile()) {
          Text(this.profileLine())
            .fontSize(15)
            .fontWeight(FontWeight.Medium)
            .width('100%')
        }
        if (this.hasProfilePath()) {
          Text(this.profilePathText())
            .fontSize(12)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .margin({ top: 2 })
            .width('100%')
        }

        Column().height(14)

        Row() {
          this.statColumn($r('app.string.plugins_loaded_stat'), this.loadedCount(), false)
          this.statColumn($r('app.string.plugins_problem_stat'), this.problemCount(), this.problemCount() > 0)
        }
        .width('100%')
        .alignItems(VerticalAlign.Top)

        // 「检查更新」放在卡里而不是顶栏：它是**重活**（每个包一次 registry 请求，
        // 清单会从毫秒级变成好几秒），与顶栏那个「刷新」不是一类动作。
        Text($r('app.string.plugins_check_updates'))
          .fontSize(13)
          .fontColor($r('sys.color.ohos_id_color_emphasize'))
          .margin({ top: 10 })
          .opacity(this.busy() ? 0.4 : 1)
          .enabled(!this.busy())
          .onClick((): void => {
            this.doCheckUpdates();
          })
      }
      .width('100%')
      .padding(16)
      .borderRadius(12)
      .border({ width: 1, color: $r('sys.color.ohos_id_color_component_normal') })
      .alignItems(HorizontalAlign.Start)

      if (this.problemCount() > 0) {
        Column().height(14)
        WarningBanner({
          message: $r('app.string.plugins_problem_banner', this.problemCount()),
        })
      }

      if (this.hasToggleable()) {
        Column().height(14)
        Text($r('app.string.plugins_restart_hint'))
          .fontSize(12)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .padding({ left: 4, right: 4 })
          .width('100%')
      }

      Column().height(22)

      Text($r('app.string.plugins_list_title'))
        .fontSize(13)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .padding({ left: 4 })
        .margin({ bottom: 8 })
        .width('100%')

      Column() {
        if (this.inv().items.length === 0) {
          Text($r('app.string.plugins_empty'))
            .fontSize(13)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .padding(16)
            .width('100%')
        } else {
          ForEach(this.inv().items, (entry: PluginEntry, index: number) => {
            if (index > 0) {
              Divider().color($r('sys.color.ohos_id_color_component_normal'))
            }
            PluginRow({
              entry: entry,
              canWrite: this.canWrite(),
              busy: this.busy(),
              onToggle: (name: string, enable: boolean): void => {
                this.askToggle(name, enable);
              },
            })
          }, (entry: PluginEntry, index: number): string => `${index}:${entry.name}:${entry.state}:${entry.loaded}`)
        }
      }
      .width('100%')
      .borderRadius(12)
      .border({ width: 1, color: $r('sys.color.ohos_id_color_component_normal') })
      .clip(true)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}
