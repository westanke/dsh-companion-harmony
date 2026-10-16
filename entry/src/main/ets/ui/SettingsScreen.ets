/**
 * 设置分节 —— 移植自原工程 `ui/SettingsScreen.kt`（321 行）的
 * `SettingsScreen` / `SettingsHeading` / `SwitchRow` / `scopeLabel`。
 *
 * ## 为什么模型供应商不在这里
 *
 * 源工程把「模型供应商」从设置页拆出去、单成一个分节（`ModelsScreen`），本工程沿用：
 * **「换模型」是高频动作，「改语言/看版本」是低频动作**，两者不该抢同一个入口。
 * 所以本页只剩：连接 / 当前设备 / 语言 / 运行时的发送方式 / 聊天页实现与上下文 /
 * 调试 / 关于 / 断开。
 *
 * ## 五条判据照抄源工程，不许"优化"
 *
 * 1. **语言走「应用级语言」而不是自制开关**（`i18n.System.setAppPreferredLanguage`）。
 *    它与安卓的 `AppCompatDelegate.setApplicationLocales` 对位：系统记得住、跟随资源目录选串。
 *    选项上显示的是**语言自己的名字**（`中文` / `English`），不是译文 —— 这正是源工程的做法：
 *    一个看不懂当前界面语言的人，得靠母语名字才能找到自己的那一项。
 * 2. **三个开关都读 `state` 而不是直接读偏好存储**。源工程注释里记了这个坑：
 *    「读 SharedPreferences 不是 Compose 状态，改了不会触发重组」—— 表现是**点了开关不动、
 *    得再点别的才跳**。本工程同理：`state.useWebChat` 这些字段由 vm 的 `update()` 推动，
 *    读它们才会随 `revision` 重绘。
 *    **但只做到这一步还不够**（2026-10-16 补）：父组件取到新值 ≠ 子组件会收到新值 ——
 *    ArkUI 重绘时只回写**带装饰器**的成员，所以 `SwitchRow.checked`、`SettingRow.title/subtitle`、
 *    `ChoicePill.selected`、`StatusLabel.label/active` 这些下行数据必须声明为 `@Prop`。
 *    原先漏了这一步，用户实测「点『English』/『插话发送』选中高亮不动、但功能已生效」。
 *    机制与坑 24 同源，见 PORT-MAP 坑 27。
 * 3. **`scopeLabel` 认不出的 scope 保留原文**。scope 本身是协议级标识（`chat.read` 这类），
 *    但给人看的不该是协议串；不过服务端将来新增权限时，与其编一个名字把人带偏，
 *    不如让它原样露出来，至少能和文档对得上（与 core 的错误码表同一原则）。
 * 4. **`http://` 要出警告条**。明文地址在局域网上能用，但它意味着凭据是裸奔的 ——
 *    这一句必须在用户能看到地址的地方出现（也就是这里与会话页头部）。
 * 5. **断开键用错误色**。它是个破坏性操作（断开后要重新走探活 + 配对校验），
 *    用普通按钮色会和「刷新」看起来一样顺手。
 *
 * ## 三处平台差异
 *
 * 1. **`SingleChoiceSegmentedButtonRow` → 两个并排的药丸按钮**。ArkUI 没有等价的分段控件，
 *    这里用「选中项填充强调色、未选中项透明 + 描边」表达同一件事。
 *    两个选择题（语言、发送方式）**共用同一个 `ChoicePill` 组件**，但**不能**写成
 *    `@Builder choicePill(label, selected, onTap)` —— ArkUI 的 `@Builder` **按值传参时不会刷新**，
 *    传布尔（`selected`）和字符串同样会丢更新（原先只防了「数组 + 回调」这一种传法，
 *    结果 `selected` 就死在这一条上）。改用 `@Component` + `@Prop` 才可靠，见该组件的注释。
 * 2. **`FlowRow` → `Flex({ wrap: FlexWrap.Wrap })`**（地址药丸、权限药丸都用它）。
 * 3. **`Switch` → `Toggle({ type: ToggleType.Switch })`**；`BuildConfig.VERSION_NAME` →
 *    `bundleManager.getBundleInfoForSelfSync()` 的 `versionName`（取不到时显示 `v?` 而不是崩）。
 *
 * ## 一处本工程特有的补充（源工程没有）
 *
 * **「平台层自检」**。平台层（偏好读写 / AES-GCM / 主机库）是唯一无法离线单测的一层，
 * 所以在真机上真跑一遍、把结论摊在这一页上。它也是 `pages/Index.ets` 里那个 `selfCheck`
 * 字段早就写好的落点。
 */

import { bundleManager, common } from '@kit.AbilityKit';
import { i18n } from '@kit.LocalizationKit';
import { HarnessState, HarnessViewModel } from '../core/HarnessViewModel';
import { SEND_MODE_QUEUE, SEND_MODE_STEER } from '../core/ComposerSendPolicy';
import { Endpoint, EndpointKind } from '../core/ConnectionModels';
import { harnessState, harnessVm } from './AppRuntime';
import { endpointKindLabel, StatusLabel, WarningBanner } from './Components';
import { platformSelfCheckText } from '../platform/Platform';

/** 内容最大宽度（对位源工程 `widthIn(max = 720.dp)`）。 */
const CONTENT_MAX_WIDTH: number = 720;

/**
 * 设备授权 scope → 人话（判据 3）。
 *
 * 认不出的原样返回。
 */
function scopeLabel(scope: string): ResourceStr {
  if (scope === 'chat.read') {
    return $r('app.string.scope_chat_read');
  }
  if (scope === 'chat.write') {
    return $r('app.string.scope_chat_write');
  }
  if (scope === 'files.read') {
    return $r('app.string.scope_files_read');
  }
  if (scope === 'files.write') {
    return $r('app.string.scope_files_write');
  }
  if (scope === 'files.delete') {
    return $r('app.string.scope_files_delete');
  }
  if (scope === 'settings.read') {
    return $r('app.string.scope_settings_read');
  }
  if (scope === 'settings.write') {
    return $r('app.string.scope_settings_write');
  }
  return scope;
}

/** 小节标题（源工程 `SettingsHeading`）。 */
@Builder
function SettingsHeading(title: ResourceStr) {
  Text(title)
    .fontSize(13)
    .fontColor($r('sys.color.ohos_id_color_text_secondary'))
    .width('100%')
    .margin({ bottom: 8 })
}

/**
 * 一行「图标 + 标题 + 副标题 +（可选）尾部内容」（源工程 `SettingRow`）。
 *
 * `trailing` 是 `@BuilderParam`：调用方用**尾随 lambda** 决定尾部画什么
 * （状态标签 / 什么都没有）。刻意写成 `@Component` 而不是全局 `@Builder` ——
 * 全局 `@Builder` 不接受尾随 lambda 形式的子内容（会报
 * `'trailing()' does not meet UI component syntax`），`@BuilderParam` 才吃这一套。
 */
@Component
struct SettingRow {
  glyph: string = '';

  /** 标题 / 副标题里有**动态值**（主机显示名、当前地址、设备名与 ID、版本号），故用 `@Prop`。 */
  @Prop title: ResourceStr = '';
  @Prop subtitle: string = '';
  /** 默认什么都不画：多数行没有尾部内容（作者、版本那两行就是）。 */
  @BuilderParam trailing: () => void = this.noTrailing;

  @Builder
  noTrailing() {
  }

  build() {
    Row() {
      Text(this.glyph)
        .fontSize(19)
        .width(26)
        .textAlign(TextAlign.Center)
        .margin({ right: 10 })
      Column() {
        Text(this.title)
          .fontSize(15)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
        if (this.subtitle.length > 0) {
          Text(this.subtitle)
            .fontSize(12)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
        }
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      this.trailing()
    }
    .width('100%')
    .padding({ top: 12, bottom: 12 })
    .alignItems(VerticalAlign.Center)
  }
}

/**
 * 一行「标题 + 说明 + 开关」。
 *
 * 抽成组件是为了**间距统一**（源工程注释里记过：此前三个开关各写各的 Row，
 * 一个 `padding(bottom=4)` 一个 `padding(vertical=8)`，页面上就是「中间那个开关上下各多出一截」，
 * 看着像没对齐的残次品）。现在三处共用这一个，间距只有一处定义。
 */
@Component
struct SwitchRow {
  title: ResourceStr = '';
  description: ResourceStr = '';

  /**
   * 开关的亮灭必须由 `@Prop` 送进来。
   *
   * 判据 2 说的是「读 `state` 才能随 `revision` 重绘」——但那保证的是**父组件**取到新值；
   * 父组件重绘时 ArkUI 只回写带装饰器的成员（`updateStateVars`），普通成员会一直停在首帧值。
   * 与坑 24 同一机制，见 PORT-MAP 坑 27。
   */
  @Prop checked: boolean = false;

  /** 函数成员**不能**加 `@Prop`（会连闭包一起深拷贝坏掉），保持普通成员。 */
  onCheckedChange: (value: boolean) => void = (): void => {};

  build() {
    Row() {
      Column() {
        Text(this.title)
          .fontSize(15)
          .width('100%')
        Text(this.description)
          .fontSize(12)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .width('100%')
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      Toggle({ type: ToggleType.Switch, isOn: this.checked })
        .onChange((isOn: boolean): void => {
          this.onCheckedChange(isOn);
        })
    }
    .width('100%')
    .padding({ top: 6, bottom: 6 })
    .alignItems(VerticalAlign.Center)
  }
}

/**
 * 一个药丸选项（对应源工程 `SingleChoiceSegmentedButtonRow` 里选中段与未选中段）：
 * 选中项用强调色填充 + 白字，未选中项透明底 + 描边。
 *
 * ## 为什么是 `@Component` 而不是 `@Builder`（真实缺陷的修法）
 *
 * 原先这里是 `@Builder choicePill(label, selected, onTap)`。而 ArkUI 的 `@Builder`
 * **按值传参时不会因参数变化刷新其内部 UI** —— `selected` 永远停在首帧值。
 * 表现就是用户报的这一处：「点『English』/『插话发送』，选中高亮不动，但功能已经生效」
 * （`busySendMode` 与系统语言确实都改了，只是画不出来）。
 * 改成组件 + `@Prop selected` 才走得通：父组件 `SettingsScreen` 重绘时会经
 * `updateStateVars` 把新值回写到 `@Prop` 成员。机制与坑 24 同源，见 PORT-MAP 坑 27。
 *
 * 注：文件头「平台差异 1」原先只写了「不共用一个带数组参数的 `@Builder`」，
 * 没说清**同样不能传布尔/字符串这类按值参数** —— 这处漏读的规则正是本缺陷的根因。
 *
 * `onTap` 保持普通成员：函数成员若被 `@Prop` 会连闭包一起深拷贝坏掉（坑 24）。
 */
@Component
struct ChoicePill {
  label: ResourceStr = '';
  @Prop selected: boolean = false;
  onTap: () => void = (): void => {};

  build() {
    Text(this.label)
      .fontSize(13)
      .fontColor(this.selected
        ? $r('sys.color.ohos_id_color_foreground_contrary')
        : $r('sys.color.ohos_id_color_text_primary'))
      .textAlign(TextAlign.Center)
      .layoutWeight(1)
      .padding({ top: 9, bottom: 9 })
      .backgroundColor(this.selected
        ? $r('sys.color.ohos_id_color_emphasize')
        : Color.Transparent)
      .borderRadius(20)
      .border({
        width: 1,
        color: this.selected ? $r('sys.color.ohos_id_color_emphasize') : $r('sys.color.ohos_id_color_component_normal'),
      })
      .margin({ right: 8 })
      .onClick((): void => {
        this.onTap();
      })
  }
}

/** 设置分节的宿主。 */
@Component
export struct SettingsScreen {
  @StorageLink('dshRevision') revision: number = 0;

  /** 平台层自检结论（本工程特有的补充，见文件头）。 */
  @State selfCheck: string = '';

  /** vm 还没装配时的兜底状态。 */
  private fallback: HarnessState = new HarnessState();

  aboutToAppear(): void {
    this.runSelfCheck();
  }

  /**
   * 读状态。
   *
   * ## 为什么必须在这里读一次 `revision`（本页曾因此整页冻住）
   *
   * ArkUI 的**增量更新按元素（elmtId）登记依赖**：编译器把每个 UI 元素的创建包在
   * `StartGetAccessRecordingFor(elmtId)` … `StopGetAccessRecording()` 之间，**只有在这个元素的
   * 那次渲染里读到的状态**才算它的依赖；改状态时也只有登记过依赖的元素会重跑。
   * 所以「在 build 里读过一次」并不等于整页都登记了 —— 读到它的那几个元素才有。
   *
   * 本页原先只在 `isEnglish()` 里读了 `revision`（为语言药丸而加），而**其余全部动态节点都经
   * 本方法取状态**，于是它们一次也没登记过依赖：点「插话发送 / 排队发送」时状态确实变了
   * （`setBusySendMode` 写了偏好、也 `update()` 通知了），界面却纹丝不动 —— 用户报的
   * 「功能已启动、图标不变化」正是这个。把它补进本方法，一条链让**所有**取状态的节点都登记上。
   *
   * 与 PORT-MAP 坑 12（`@StorageLink` 只声明不读等于没声明）同源；
   * 「父组件重绘了子组件也未必收到」，另见坑 27 与 `SwitchRow` / `ChoicePill` 的 `@Prop` 说明。
   */
  private st(): HarnessState {
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

  /** 当前连上的那台电脑（对位源工程 `hosts.firstOrNull { it.id == activeHostId }`）。 */
  private activeHostIndex(): number {
    const hosts = this.st().hosts;
    const activeId: string | null = this.st().activeHostId;
    for (let i = 0; i < hosts.length; i++) {
      if (hosts[i].id === activeId) {
        return i;
      }
    }
    return -1;
  }

  private hasActiveHost(): boolean {
    return this.activeHostIndex() >= 0;
  }

  private hostName(): string {
    const idx: number = this.activeHostIndex();
    if (idx < 0) {
      return '';
    }
    return this.st().hosts[idx].displayName;
  }

  /** 有活动主机时用它当标题，否则退回「连接」（源工程 `activeHost?.displayName ?: connection`）。 */
  private connectionTitle(): ResourceStr {
    return this.hasActiveHost() ? this.hostName() : $r('app.string.connection');
  }

  private connectionSubtitle(): string {
    const st: HarnessState = this.st();
    return st.endpoint;
  }

  private eventsConnected(): boolean {
    return this.st().eventsConnected;
  }

  private deviceName(): string {
    const device = this.st().device;
    return device === null ? '' : device.name;
  }

  private deviceId(): string {
    const device = this.st().device;
    return device === null ? '' : device.id;
  }

  private httpInsecure(): boolean {
    return this.st().endpoint.startsWith('http://');
  }

  // ———— 语言（判据 1） ————

  private isEnglish(): boolean {
    // 读一次 revision 参与计算：ArkUI 在 build 期（经本方法）读到该状态才会登记依赖，
    // 语言切换后的重绘才成立。
    const rev: number = this.revision;
    return rev >= 0 && i18n.System.getAppPreferredLanguage().startsWith('en');
  }

  private toggleLanguage(): void {
    const current: string = i18n.System.getAppPreferredLanguage();
    const next: string = current.startsWith('en') ? 'zh-CN' : 'en';
    try {
      i18n.System.setAppPreferredLanguage(next);
    } catch (e) {
      // 参数非法时静默：语言切换失败不该打断设置页。
    }
    this.revision++;
  }

  // ———— 发送方式 ————

  private isQueueMode(): boolean {
    return this.st().busySendMode === SEND_MODE_QUEUE;
  }

  private setSendMode(mode: string): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      vm.setBusySendMode(mode);
    }
  }

  private sendModeDesc(): ResourceStr {
    return this.isQueueMode()
      ? $r('app.string.busy_send_mode_queue_desc')
      : $r('app.string.busy_send_mode_steer_desc');
  }

  // ———— 三个开关（判据 2：一律读 state） ————

  private setUseWebChat(value: boolean): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      vm.setUseWebChat(value);
    }
  }

  private setShowContext(value: boolean): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      vm.setShowContext(value);
    }
  }

  private setGenUiDebug(value: boolean): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      vm.setGenUiDebug(value);
    }
  }

  // ———— 关于 ————

  private versionText(): string {
    try {
      const info: bundleManager.BundleInfo =
        bundleManager.getBundleInfoForSelfSync(bundleManager.BundleFlag.GET_BUNDLE_INFO_DEFAULT);
      return `v${info.versionName}`;
    } catch (e) {
      // 取不到版本不该让设置页崩：给一个明显不完整的占位，而不是假装是某个版本。
      return 'v?';
    }
  }

  private disconnect(): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      vm.disconnect();
    }
  }

  /** 平台层自检（本工程特有的补充，见文件头）。 */
  private runSelfCheck(): void {
    const ctx: common.Context | undefined = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      this.selfCheck = '';
      return;
    }
    this.selfCheck = platformSelfCheckText(ctx);
  }

  build() {
    Scroll() {
      Column() {
        Column() {
          Text($r('app.string.settings'))
            .fontSize(24)
            .fontWeight(FontWeight.Medium)
            .width('100%')
          Text($r('app.string.settings_subtitle'))
            .fontSize(13)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ top: 4, bottom: 26 })
            .width('100%')

          SettingsHeading($r('app.string.connection'))
          SettingRow({
            glyph: '☁',
            title: this.connectionTitle(),
            subtitle: this.connectionSubtitle(),
          }) {
            StatusLabel({
              label: this.eventsConnected() ? $r('app.string.online') : $r('app.string.offline'),
              active: this.eventsConnected(),
            })
          }

          // 把当前这台电脑的全部地址列出来，并标出此刻实际走的是哪一个。
          // 用户换了网络（局域网 → 虚拟网）之后最想知道的就是这件事。
          if (this.hasActiveHost()) {
            this.endpointChips()
          }

          if (this.httpInsecure()) {
            WarningBanner({ message: $r('app.string.http_warning') })
          }
          Column().height(22)

          SettingsHeading($r('app.string.device'))
          SettingRow({ glyph: '📱', title: this.deviceName(), subtitle: this.deviceId() })
          this.scopeChips()
          Column().height(24)

          SettingsHeading($r('app.string.language'))
          this.languageSelector()
          Column().height(28)

          // 智能体运行时的发送行为。放在这里是因为它不是「聊天页的临时开关」，
          // 而是一条会影响每次输入的长期习惯，用户需要能一眼看到自己设成了什么。
          SettingsHeading($r('app.string.busy_send_mode'))
          this.sendModeSelector()
          Text(this.sendModeDesc())
            .fontSize(12)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ top: 8 })
            .width('100%')
          Text($r('app.string.busy_send_mode_subtitle'))
            .fontSize(12)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ top: 4, bottom: 28 })
            .width('100%')

          // 聊天页实现与上下文注入。开关默认关 —— 上下文块是噪音，
          // 该在排查问题时才打开，而不是让每条消息之间都插一排折叠块。
          SettingsHeading($r('app.string.web_chat_heading'))
          SwitchRow({
            title: $r('app.string.web_chat_title'),
            description: $r('app.string.web_chat_desc'),
            checked: this.st().useWebChat,
            onCheckedChange: (value: boolean): void => {
              this.setUseWebChat(value);
            },
          })
          SwitchRow({
            title: $r('app.string.show_context_title'),
            description: $r('app.string.show_context_desc'),
            checked: this.st().showContext,
            onCheckedChange: (value: boolean): void => {
              this.setShowContext(value);
            },
          })
          Text($r('app.string.web_chat_footnote'))
            .fontSize(12)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ top: 4 })
            .width('100%')
          // 本工程特有的说明：这里没有内置网页版，那个开关真的不影响界面。
          // 与其让用户点半天看不出变化，不如直接说清楚为什么。
          Text($r('app.string.web_chat_footnote_port'))
            .fontSize(12)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ top: 4, bottom: 20 })
            .width('100%')

          // dsh-ui 诊断开关。放在「关于」正上方，因为它服务的正是「关于版本」那一类问题：
          // 用户报「卡片没出来」时，让他自己打开就能拿到证据，不必等我们出新包。
          SettingsHeading($r('app.string.gen_ui_debug_heading'))
          SwitchRow({
            title: $r('app.string.gen_ui_debug_title'),
            description: $r('app.string.gen_ui_debug_desc'),
            checked: this.st().genUiDebug,
            onCheckedChange: (value: boolean): void => {
              this.setGenUiDebug(value);
            },
          })
          Text($r('app.string.gen_ui_debug_footnote'))
            .fontSize(12)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ top: 4, bottom: 28 })
            .width('100%')

          SettingsHeading($r('app.string.about'))
          SettingRow({ glyph: '⌨', title: $r('app.string.author'), subtitle: this.resText($r('app.string.author_value')) })
          SettingRow({ glyph: '✓', title: $r('app.string.version'), subtitle: this.versionText() })

          // 平台层自检（本工程特有的补充）。放在「关于」下面：它服务的正是
          // 「这个设备上到底哪一层不对」那一类问题，与版本号是同一类信息。
          SettingsHeading($r('app.string.platform_self_check'))
          Text(this.selfCheck.length === 0
            ? this.resText($r('app.string.platform_self_check_none'))
            : this.selfCheck)
            .fontSize(12)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .width('100%')
            .copyOption(CopyOptions.LocalDevice)
          Text($r('app.string.platform_self_check_desc'))
            .fontSize(12)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ top: 4 })
            .width('100%')
          Text($r('app.string.platform_self_check_run'))
            .fontSize(13)
            .fontColor($r('sys.color.ohos_id_color_emphasize'))
            .margin({ top: 8, bottom: 18 })
            .onClick((): void => {
              this.runSelfCheck();
            })

          // 断开键（判据 5：破坏性操作用错误色）。
          Button($r('app.string.disconnect'))
            .width('100%')
            .height(50)
            .borderRadius(25)
            .backgroundColor(Color.Transparent)
            .fontColor($r('sys.color.ohos_id_color_warning'))
            .border({ width: 1, color: $r('sys.color.ohos_id_color_warning') })
            .onClick((): void => {
              this.disconnect();
            })

          Column().height(24)
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

  private resText(res: Resource): string {
    const ctx: common.Context | undefined = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      return '';
    }
    return ctx.resourceManager.getStringSync(res.id);
  }

  /** 地址药丸里要把「局域网 / 虚拟网 / 广域网」拼进一行文字，所以取资源串的字符串形态。 */
  private kindText(kind: EndpointKind): string {
    return this.resText(endpointKindLabel(kind));
  }

  /** 地址药丸（`Flex` 换行，见文件头差异 2）。 */
  @Builder
  endpointChips() {
    Flex({ wrap: FlexWrap.Wrap }) {
      ForEach(this.st().hosts[this.activeHostIndex()].endpoints, (endpoint: Endpoint, index: number) => {
        Text(`${this.kindText(endpoint.kind)} · ${endpoint.baseUrl}${endpoint.id === this.st().activeEndpointId ? ` · ${this.resText($r('app.string.active'))}` : ''}`)
          .fontSize(11)
          .padding({ left: 10, right: 10, top: 6, bottom: 6 })
          .borderRadius(14)
          .backgroundColor(endpoint.id === this.st().activeEndpointId
            // 当前实际在走的那个地址要**一眼可辨**：`sub_background` 是与 `component_normal`
            // 明显不同的一档填充色（前者偏面板底、后者偏灰块）。
            ? $r('sys.color.ohos_id_color_sub_background')
            : $r('sys.color.ohos_id_color_component_normal'))
          .margin({ right: 7, bottom: 7 })
      }, (endpoint: Endpoint, index: number): string => `${index}:${endpoint.id}:${endpoint.baseUrl}`)
    }
    .width('100%')
    .margin({ top: 8 })
  }

  /** 权限药丸。 */
  @Builder
  scopeChips() {
    Flex({ wrap: FlexWrap.Wrap }) {
      ForEach(this.scopes(), (scope: string, index: number) => {
        Text(scopeLabel(scope))
          .fontSize(11)
          .padding({ left: 10, right: 10, top: 6, bottom: 6 })
          .borderRadius(14)
          .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
          .margin({ right: 7, bottom: 7 })
      }, (scope: string, index: number): string => `${index}:${scope}`)
    }
    .width('100%')
    .margin({ top: 8, bottom: 24 })
  }

  /** 语言二选一（选项上写语言自己的名字，见判据 1）。 */
  @Builder
  languageSelector() {
    Row() {
      ChoicePill({
        label: $r('app.string.chinese'),
        selected: !this.isEnglish(),
        onTap: (): void => {
          if (this.isEnglish()) {
            this.toggleLanguage();
          }
        },
      })
      ChoicePill({
        label: $r('app.string.english'),
        selected: this.isEnglish(),
        onTap: (): void => {
          if (!this.isEnglish()) {
            this.toggleLanguage();
          }
        },
      })
    }
    .width('100%')
    .padding({ bottom: 28 })
  }

  /** 发送方式二选一。 */
  @Builder
  sendModeSelector() {
    Row() {
      ChoicePill({
        label: $r('app.string.busy_send_mode_queue'),
        selected: this.isQueueMode(),
        onTap: (): void => {
          this.setSendMode(SEND_MODE_QUEUE);
        },
      })
      ChoicePill({
        label: $r('app.string.busy_send_mode_steer'),
        selected: !this.isQueueMode(),
        onTap: (): void => {
          this.setSendMode(SEND_MODE_STEER);
        },
      })
    }
    .width('100%')
  }
}
