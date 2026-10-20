/**
 * 连接页 —— 移植自原工程 `ui/ConnectScreen.kt`（711 行）。
 *
 * 这是每一台设备的**必经入口**：连上以后也停在这里等用户点头「进入应用」，
 * 所以它不是「首启引导页」，跟主界面是平级的两态（见 `pages/Index.ets` 的判据）。
 *
 * ## 三处关键行为，都是源工程踩过坑才定下来的，不许简化
 *
 * 1. **两条连接方式默认都收起、且互斥**。用户原话是「默认显示两个不同的连接方式，不要展开，
 *    我需要那个，我自己点击」。展开一个就把另一个收起来 —— 一次只开一个，
 *    屏幕上不会同时铺两份表单。
 * 2. **「测试连接」不放行连接页**。它只是探活，不建立连接；用户点完还应该留在原处看结果。
 *    放行发生在「连接 / 配对 / 导入」这三个**真的会建立连接**的动作上。
 * 3. **「进入应用」与「连接这台电脑」的启用条件不能共用一个**。前者是纯本地跳转（不碰网络），
 *    后者要做网络动作。共用 `busy` 的后果：自动重连成功后只要后台还有请求在跑，
 *    「进入应用」就是灰的，而连接页没有第二个入口 —— 真机截图里那个灰掉的按钮就是这么来的。
 */

import { promptAction } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { i18n } from '@kit.LocalizationKit';
import { deviceInfo } from '@kit.BasicServicesKit';
import { Endpoint, EndpointProbe, Host } from '../core/ConnectionModels';
import { HarnessState, HarnessViewModel } from '../core/HarnessViewModel';
import { harnessState, harnessVm } from './AppRuntime';
import { BrandMark, WarningBanner, StatusLabel, endpointKindLabel } from './Components';
import { HostCardState, hostCardState, shouldReconnectOnTap } from '../core/ConnectionLiveness';
import { localErrorText } from './ErrorText';
import { readClipboardText } from '../platform/Clipboard';

@Component
export struct ConnectScreen {
  /** 用户主动发起连接时调用 → 放行连接页门闩。 */
  onEnterApp: () => void = (): void => {};

  /** 订阅 vm 的 revision：任何 `update()` 都会让本页重新 build。 */
  @StorageLink('dshRevision') @Watch('onVmChanged') revision: number = 0;

  @State endpoint: string = '';
  @State code: string = '';
  @State deviceName: string = '';
  @State configText: string = '';
  @State importExpanded: boolean = false;
  @State manualExpanded: boolean = false;

  /** vm 还没装配时的兜底状态（正常路径下用不到，避免 getter 里到处判空）。 */
  private fallback: HarnessState = new HarnessState();

  aboutToAppear(): void {
    this.endpoint = this.st().endpointDraft;
    // 设备名默认取手机名；鸿蒙没有 Android 的 Build.MODEL，用设备类型兜底。
    this.deviceName = this.defaultDeviceName();
  }

  /**
   * 连接页上的 `state.error` 必须自己报 —— 这是「网络不通时界面一片『连接』」的根因。
   *
   * 源工程 `App.kt` 把 `state.error` 的 Snackbar 挂在**顶层**，连接页与主界面两处都看得见；
   * 移植侧只把这段逻辑放进了 `AppShell`，而 `AppShell` 在未连接时**根本没挂载**
   * （`pages/Index.ets` 走的是 `ConnectScreen` 分支）。于是连接失败时：
   * `connectHostInternal` 明明写了 `s.error`，却没有任何一处把它显示出来 ——
   * 用户点「连接」→ 停两秒 → 回到同一页，标题、按钮、配对按钮全还写着「连接」，
   * 看不出刚失败过。这里补上连接页那一半。
   *
   * `lastReported` + `clearError()` 与 `AppShell.reportErrorIfAny()` 同一套：不清掉的话
   * 下一次任意重绘都会再弹一遍，用户看到的就是「同一句话反复弹」。
   */
  private lastReported: string | null = null;

  onVmChanged(): void {
    this.reportErrorIfAny();
  }

  private reportErrorIfAny(): void {
    const vm: HarnessViewModel | null = this.vm();
    const st: HarnessState = this.st();
    // 错误已被消费掉 → 去重记录一起归零。否则「同一个错误再发生一次」会被当成重复而静默：
    // 用户点两次「重试连接」、两次都超时，第二次就一个字都不弹，看着像没点上。
    // 去重只为拦住**同一次错误**在多帧 / 多个宿主里的重复播报，不该跨事件生效。
    if (st.error === null) {
      this.lastReported = null;
    }
    if (vm === null || st.error === null) {
      return;
    }
    // 已经连上时主界面接管这件事（那时本页不在树里），不重复报。
    if (st.connected) {
      return;
    }
    const ctx: common.Context | undefined = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      return;
    }
    const text: string = localErrorText(ctx, st.error);
    if (text !== this.lastReported) {
      this.lastReported = text;
      promptAction.showToast({ message: text, duration: 2600 });
    }
    vm.clearError();
  }

  /**
   * 当前状态快照。
   *
   * **必须读一次 revision**（见下）：ArkUI 只把 build 期间读过的状态登记为依赖，
   * 只声明 `@StorageLink` 而不读，vm 更新时本页不会重绘。这里漏了这一读，后果是
   * 连接页整页**定格**在「正在探测 N 个地址…」—— vm 侧明明早已探测完成、甚至自动
   * 重连成功（真机插桩实证：`connect done` 之后 UI 仍停在探测行、按钮像点不动），
   * 就是「探测不完、连接点不了」的真凶。写法与 `AppShell.st()` / `ChatScreen.st()`
   * 一致：恒真的比较只为让这次读取发生。见 PORT-MAP §1b 坑 12。
   */
  private st(): HarnessState {
    const rev: number = this.revision;
    return rev >= 0 ? (harnessState() ?? this.fallback) : this.fallback;
  }

  private vm(): HarnessViewModel | null {
    return harnessVm();
  }

  /** 参数化资源 → 字符串（只在必须拿 string 的场合用：AlertDialog、字符串拼接）。 */
  private fmt1(res: Resource, arg: string | number): string {
    const ctx: common.Context | undefined = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      return '';
    }
    return ctx.resourceManager.getStringSync(res.id, arg);
  }

  /** 无参资源 → 字符串。 */
  private resText(res: Resource): string {
    const ctx: common.Context | undefined = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      return '';
    }
    return ctx.resourceManager.getStringSync(res.id);
  }

  /**
   * 默认设备名 —— 对位安卓的 `Build.MODEL`。
   *
   * 这个名字会上报到服务端（配对时作为 `deviceName`），将来在「设备列表」里认自己靠它，
   * 所以取机型名（`deviceInfo.marketName`）比取包名有意义得多。
   */
  private defaultDeviceName(): string {
    const model: string = deviceInfo.marketName.length > 0 ? deviceInfo.marketName : deviceInfo.productModel;
    return model.length > 0 ? model : 'HarmonyOS';
  }

  /**
   * 语言入口上的文字：显示**当前**语言，让用户知道点一下会切到哪边。
   * 只显示「中文 / English」而不显示当前语言名，是因为按钮要表达的是「另一个选择」——
   * 但那样用户在中文界面看到「English」会误以为已经是英文，所以这里显示当前值并在
   * 后面带一个切换箭头：`中文 ›` 表示「现在是中文，点一下切英文」。
   */
  private languageLabel(): string {
    // 读一次 revision 参与计算：ArkUI 在 build 期间（经本方法）读到该状态才会登记依赖，
    // 语言切换后的重绘才成立。build() 里不能写局部变量声明，所以读取放在方法体内。
    const rev: number = this.revision;
    return rev >= 0 && i18n.System.getAppPreferredLanguage().startsWith('en') ? 'English ›' : '中文 ›';
  }

  /**
   * 切换界面语言 —— 与原工程同样走「应用级语言」而不是自制开关。
   *
   * 鸿蒙用 `i18n.System.setAppPreferredLanguage`，它就是 `AppCompatDelegate.setApplicationLocales`
   * 的对位能力（系统记得住、跟随资源目录选串）。切换后：
   * - 资源串（`$r`）由系统按新语言解析，本页靠 revision 递增触发一次重绘；
   * - core 侧的 `Accept-Language` 与会话文案**立即**生效（`deps.languageTag()` 每次调用现读）。
   * 注：系统对「已打开的页面」是否立即换字体取决于版本，冷启动一定正确。
   */
  private toggleLanguage(): void {
    const current: string = i18n.System.getAppPreferredLanguage();
    const next: string = current.startsWith('en') ? 'zh-CN' : 'en';
    try {
      i18n.System.setAppPreferredLanguage(next);
    } catch (e) {
      // 参数非法时静默：语言切换失败不该打断连接流程。
    }
    this.revision++;
  }

  build() {
    Stack({ alignContent: Alignment.TopEnd }) {
      Scroll() {
        Column() {
          BrandMark()
          Text($r('app.string.connect_title'))
            .fontSize(24)
            .fontWeight(FontWeight.Medium)
            .margin({ top: 20 })
          Text($r('app.string.connect_subtitle'))
            .fontSize(14)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ top: 8 })
            .textAlign(TextAlign.Center)

          Column() {
            this.savedComputersPanel()
            this.importConfigPanel()
            this.manualPairingPanel()
          }
          .width('100%')
          .margin({ top: 26 })
        }
        .width('100%')
        .padding({ left: 24, right: 24, top: 36, bottom: 28 })
        .alignItems(HorizontalAlign.Center)
      }
      .width('100%')
      .height('100%')
      .align(Alignment.TopStart)

      // 语言切换入口：右上角。显示当前语言，点一下切换。
      Text(this.languageLabel())
        .fontSize(13)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .padding(10)
        .margin({ top: 8, right: 8 })
        .onClick((): void => {
          this.toggleLanguage();
        })
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_background'))
  }

  // ————————————————— 已保存的电脑 —————————————————

  @Builder
  savedComputersPanel() {
    Column() {
      Text($r('app.string.saved_computers'))
        .fontSize(12)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .width('100%')
        .padding({ left: 4, bottom: 8 })

      if (this.st().hosts.length === 0) {
        Column() {
          if (this.st().restoring) {
            // 冷启动时主机列表是异步读出来的，那段窗口里直接说「还没有保存的电脑」
            // 等于在首屏闪一句假话 —— 连接页现在是必经入口，第一眼就自相矛盾尤其难看。
            Row() {
              LoadingProgress().width(16).height(16)
              Text($r('app.string.loading_saved_computers'))
                .fontSize(13)
                .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                .margin({ left: 10 })
            }
            .alignItems(VerticalAlign.Center)
          } else {
            Text($r('app.string.no_hosts_yet'))
              .fontSize(13)
              .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          }
        }
        .width('100%')
        .padding(16)
        .alignItems(HorizontalAlign.Start)
        .borderRadius(10)
        .borderWidth(1)
        .borderColor($r('sys.color.ohos_id_color_text_secondary'))
        .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
      }

      ForEach(this.st().hosts, (host: Host): void => {
        this.hostCard(host);
      }, (host: Host): string => host.id)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  hostCard(host: Host) {
    Column() {
      // 头部：图标 + 名称 + 地址数（+ 已连接标签）+ 删除
      Row() {
        Column() {
          Text('PC')
            .fontSize(12)
            .fontWeight(FontWeight.Bold)
            .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
        }
        .width(34)
        .height(34)
        .borderRadius(17)
        .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
        .justifyContent(FlexAlign.Center)

        Column() {
          Text(host.displayName)
            .fontSize(15)
            .fontWeight(FontWeight.Medium)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
          Row() {
            Text(this.fmt1($r('app.string.endpoint_count'), host.endpoints.length))
              .fontSize(11)
              .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            if (this.cardState(host) === HostCardState.CONNECTED) {
              StatusLabel({ label: $r('app.string.connected'), active: true })
                .margin({ left: 8 })
            } else if (this.cardState(host) === HostCardState.DISCONNECTED) {
              // 「连过、此刻断开」：红点。与「从没连过」必须区分开，
              // 否则用户看到的是同一个灰点，只能凭记忆猜（源工程提交 91743f2）。
              StatusLabel({ label: $r('app.string.connect_offline'), active: false, offline: true })
                .margin({ left: 8 })
            }
          }
          .margin({ top: 2 })
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
        .margin({ left: 12, right: 8 })

        Text('🗑')
          .fontSize(15)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .padding(8)
          .enabled(!this.st().busy && !this.st().connecting)
          .onClick((): void => {
            this.confirmRemoveHost(host);
          })
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      // 凭据状态：过期/缺失时明确告知，而不是等用户点了连接才报一个看不懂的错。
      if (host.credential === null) {
        Text($r('app.string.no_credentials'))
          .fontSize(11)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .margin({ top: 6 })
      } else if (host.credential.isExpired(Date.now())) {
        WarningBanner({ message: $r('app.string.credentials_expired') })
          .margin({ top: 6 })
      }

      // 每个地址一行：类型 + 地址 + 探活结果。地址不止一个这件事本身要摆给用户看。
      ForEach(host.endpoints, (endpoint: Endpoint): void => {
        this.endpointRow(host, endpoint);
      }, (endpoint: Endpoint): string => endpoint.id)

      if (this.st().connecting && host.id === this.st().selectedHostId) {
        Row() {
          LoadingProgress().width(16).height(16)
          Text(this.fmt1($r('app.string.connecting_endpoints'), host.endpoints.length))
            .fontSize(11)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ left: 10 })
        }
        .margin({ top: 6 })
        .alignItems(VerticalAlign.Center)
      }

      // 只有探测过、且存在失败地址时才给诊断 —— 全部可达时没必要增加噪音。
      if (host.id === this.st().selectedHostId && this.probeFailureCount() > 0) {
        this.diagnosticPanel(host)
      }

      // 底部按钮。已经连上的那台必须写「进入应用」而不是「连接」：
      // 写「连接」的话用户找不到「进去」这件事该点哪里。
      // 上次探活全失败的那台写「重试连接」：否则失败前后按钮**一模一样**，
      // 用户无法判断刚才那次点击到底做了什么（真机反馈「网络不通时都显示『连接』」）。
      Button() {
        Row() {
          Text('🔗').fontSize(14)
          Text(this.hostButtonText(host))
            .fontSize(14)
            .margin({ left: 8 })
        }
      }
      .type(ButtonType.Capsule)
      .width('100%')
      .height(46)
      .margin({ top: 10 })
      .enabled(this.connectButtonEnabled(host))
      .onClick((): void => {
        this.onConnectHost(host);
      })
    }
    .width('100%')
    .padding(14)
    .margin({ bottom: 8 })
    .borderRadius(10)
    .borderWidth(1)
    .borderColor(this.cardState(host) === HostCardState.CONNECTED
      ? $r('sys.color.ohos_id_color_text_primary_activated')
      : $r('sys.color.ohos_id_color_text_secondary'))
    .backgroundColor($r('sys.color.ohos_id_color_background'))
    .alignItems(HorizontalAlign.Start)
  }

  /** 卡片三态（判据见 `core/ConnectionLiveness.ts`；这里只负责取状态）。 */
  private cardState(host: Host): HostCardState {
    const st: HarnessState = this.st();
    return hostCardState(host.id, st.activeHostId, st.connected);
  }

  /**
   * 主机卡片底部按钮的文案 —— 三档状态、四种说法。
   *
   * - 已连接：「进入应用」（纯本地跳转）；
   * - 是当前活跃连接、但此刻已断开：「重新连接」；
   * - 这台刚探活全失败：「重试连接」；
   * - 其余：「连接」。
   *
   * 「已断开」与「重试连接」必须分开：前者说明**这台曾经连上过**、只是链路没了；
   * 后者是本次点击刚失败。原先只有「连接 / 进入应用」两档，断网前后的按钮
   * 一字不差，用户只能怀疑自己没点上（真机反馈）。
   */
  private hostButtonText(host: Host): ResourceStr {
    const card: HostCardState = this.cardState(host);
    if (card === HostCardState.CONNECTED) {
      return $r('app.string.enter_app');
    }
    if (card === HostCardState.DISCONNECTED) {
      return $r('app.string.reconnect');
    }
    const st: HarnessState = this.st();
    if (host.id === st.selectedHostId && this.probeFailureCount() > 0) {
      return $r('app.string.connect_retry');
    }
    return $r('app.string.connect_this_computer');
  }

  /**
   * 底部按钮的启用条件 —— 与源工程同款的两分支。
   *
   * 已连接时只要地址非空即可点（纯本地跳转，不受 `busy` 影响）；
   * 未连接时要额外等 `busy`/`connecting` 落下去（要做网络动作）。
   */
  private connectButtonEnabled(host: Host): boolean {
    if (host.endpoints.length === 0) {
      return false;
    }
    if (this.cardState(host) === HostCardState.CONNECTED) {
      return true;
    }
    const st: HarnessState = this.st();
    return !st.busy && !st.connecting;
  }

  private onConnectHost(host: Host): void {
    // 用户主动的一个动作 —— 放行连接页（失败时 connected 仍为 false，界面自然还停在这里）。
    this.onEnterApp();
    const st: HarnessState = this.st();
    const vm: HarnessViewModel | null = this.vm();
    if (vm === null) {
      return;
    }
    // 判据是「这台是不是当前活跃连接 **且** 客户端还握在手里」，**不是** `connected`。
    // 后者是历史值：断网后仍可能为 true，于是这里短路掉、按钮被门闩判回连接页，
    // 用户看到的就是「断网后点按钮毫无反应」（源工程提交 91743f2）。
    if (shouldReconnectOnTap(host.id, st.activeHostId, vm.activeConnection() !== null)) {
      void vm.connectHost(host.id);
    }
  }

  @Builder
  endpointRow(host: Host, endpoint: Endpoint) {
    Row() {
      Text(endpointKindLabel(endpoint.kind))
        .fontSize(10)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .width(40)

      Column() {
        Text(endpoint.label)
          .fontSize(12)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(endpoint.baseUrl)
          .fontSize(10)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
      .margin({ left: 8, right: 8 })

      if (host.id === this.st().activeHostId && endpoint.id === this.st().activeEndpointId) {
        Text('✓')
          .fontSize(14)
          .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
      } else if (this.probeOf(endpoint.id) !== null && this.probeOf(endpoint.id)?.ok === true) {
        Text(this.fmt1($r('app.string.endpoint_reachable'), this.probeOf(endpoint.id)?.latencyMs ?? 0))
          .fontSize(10)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
      } else if (this.probeOf(endpoint.id) !== null) {
        Text($r('app.string.endpoint_unreachable'))
          .fontSize(10)
          .fontColor($r('sys.color.ohos_id_color_alert'))
      }
    }
    .width('100%')
    .margin({ top: 4 })
    .alignItems(VerticalAlign.Center)
  }

  /** 已探测到的某个地址的结果；未探测返回 null。只在当前选中主机上探测。 */
  private probeOf(endpointId: string): EndpointProbe | null {
    const probes: EndpointProbe[] = this.st().endpointProbes;
    for (let i = 0; i < probes.length; i++) {
      if (probes[i].endpointId === endpointId) {
        return probes[i];
      }
    }
    return null;
  }

  private probeFailureCount(): number {
    const probes: EndpointProbe[] = this.st().endpointProbes;
    let failed: number = 0;
    for (let i = 0; i < probes.length; i++) {
      if (!probes[i].ok) {
        failed++;
      }
    }
    return failed;
  }

  /**
   * 地址诊断：逐条列出每个地址为什么连不上。
   *
   * 这是「用户过去只能手填地址、却不知道填哪个才通」的直接解法 —— 与其只说一句
   * 「连接失败」，不如把几个地址各自的结果摆出来。
   */
  @Builder
  diagnosticPanel(host: Host) {
    Column() {
      Text($r('app.string.endpoint_diagnostics'))
        .fontSize(11)
        .fontWeight(FontWeight.Medium)
        .width('100%')

      ForEach(this.st().endpointProbes, (probe: EndpointProbe): void => {
        if (!probe.ok) {
          Text(this.probeDiagnosticLine(host, probe))
            .fontSize(11)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .width('100%')
            .margin({ top: 4 })
        }
      }, (probe: EndpointProbe): string => probe.endpointId)
    }
    .width('100%')
    .padding(12)
    .margin({ top: 8 })
    .borderRadius(8)
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
    .alignItems(HorizontalAlign.Start)
  }

  private probeDiagnosticLine(host: Host, probe: EndpointProbe): string {
    let label: string = probe.endpointId;
    for (let i = 0; i < host.endpoints.length; i++) {
      if (host.endpoints[i].id === probe.endpointId) {
        label = `${host.endpoints[i].label} · ${host.endpoints[i].baseUrl}`;
        break;
      }
    }
    // 探活失败时 `probe.error` 里是底层给的原因（超时/拒绝/解析不了），有就照实显示；
    // 没有才回落到「不可达」这句笼统的话。
    const reason: string = probe.error !== null ? probe.error : this.unreachableText();
    return `${label} — ${reason}`;
  }

  private unreachableText(): string {
    return this.resText($r('app.string.endpoint_unreachable'));
  }

  /**
   * 删除前的确认。
   *
   * 必须拦一道：删掉的是「地址 + 设备令牌」，用户下次要用得重新配对或重新导入 ——
   * 代价不可逆，所以不能靠一个图标点击就生效。
   * 用系统 `AlertDialog` 而不是自绘弹窗：它会自动套用系统主题与深浅色。
   */
  private confirmRemoveHost(host: Host): void {
    // 走 `UIContext.showAlertDialog`（`AlertDialog.show` 已废弃，且全局弹窗在分栏/多实例下会挂错窗口）。
    this.getUIContext().showAlertDialog({
      title: this.fmt1($r('app.string.remove_computer_title'), host.displayName),
      message: this.resText($r('app.string.remove_computer_warning')),
      primaryButton: {
        value: this.resText($r('app.string.confirm')),
        action: (): void => {
          const vm: HarnessViewModel | null = this.vm();
          if (vm !== null) {
            vm.removeHost(host.id);
          }
        },
      },
      secondaryButton: {
        value: this.resText($r('app.string.dismiss')),
        action: (): void => {
        },
      },
      cancel: (): void => {
      },
    });
  }

  // ————————————————— 两条连接方式 —————————————————

  @Builder
  connectionEntryRow(expanded: boolean, glyph: string, title: ResourceStr, subtitle: ResourceStr,
                     onToggle: () => void) {
    Row() {
      Text(glyph)
        .fontSize(16)
        .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
      Column() {
        Text(title).fontSize(14).fontWeight(FontWeight.Medium)
        Text(subtitle)
          .fontSize(11)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .margin({ top: 2 })
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
      .margin({ left: 12, right: 8 })
      Text(expanded ? '⌃' : '⌄')
        .fontSize(14)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
    }
    .width('100%')
    .padding({ left: 14, right: 14, top: 12, bottom: 12 })
    .borderRadius(10)
    .borderWidth(1)
    .borderColor($r('sys.color.ohos_id_color_text_secondary'))
    .backgroundColor($r('sys.color.ohos_id_color_background'))
    .alignItems(VerticalAlign.Center)
    .onClick((): void => {
      onToggle();
    })
  }

  /**
   * 配置导入面板 —— 取代扫码的主路径。
   *
   * 说明文字刻意把「为什么要有这个」讲清楚：用户看到「粘贴一段文本」时第一反应是
   * 「为什么不扫码更简单」，必须当场回答，否则他还是会觉得别扭。
   */
  @Builder
  importConfigPanel() {
    Column() {
      this.connectionEntryRow(this.importExpanded, '⬇',
        $r('app.string.import_from_computer'), $r('app.string.import_entry_hint'),
        (): void => {
          this.importExpanded = !this.importExpanded;
          if (this.importExpanded) {
            this.manualExpanded = false;
          }
        })

      if (this.importExpanded) {
        Column() {
          Text($r('app.string.import_explanation'))
            .fontSize(11)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .width('100%')

          TextArea({ text: this.configText, placeholder: $r('app.string.import_hint') })
            .width('100%')
            .height(76)
            .margin({ top: 10 })
            .onChange((value: string): void => {
              this.configText = value;
            })

          // 粘贴按钮：手机上敲这段长文本不现实，粘贴是唯一现实路径。
          Row() {
            Text($r('app.string.paste_from_clipboard'))
              .fontSize(13)
              .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
          }
          .margin({ top: 8 })
          .onClick((): void => {
            // 注意：本工程没申请 READ_PASTEBOARD（受限权限，声明了连包都装不上），
            // 所以这里**必然**读不到 —— 读不到时不能静默什么都不做，得明确告诉用户
            // 改用手动粘贴（长按输入框走系统粘贴，那条路不经过应用权限）。
            const text: string = readClipboardText();
            if (text.length > 0) {
              this.configText = text;
              return;
            }
            promptAction.showToast({ message: $r('app.string.clipboard_empty'), duration: 2600 });
          })

          WarningBanner({ message: $r('app.string.import_security_note') })
            .margin({ top: 10 })

          Button() {
            Row() {
              Text('🔗').fontSize(14)
              Text($r('app.string.import_and_connect')).fontSize(14).margin({ left: 8 })
            }
          }
          .type(ButtonType.Capsule)
          .width('100%')
          .height(48)
          .margin({ top: 10 })
          .enabled(this.importEnabled())
          .onClick((): void => {
            this.onEnterApp();
            const vm: HarnessViewModel | null = this.vm();
            if (vm !== null) {
              void vm.importConfiguration(this.configText);
            }
          })
        }
        .width('100%')
        .padding(14)
        .alignItems(HorizontalAlign.Start)
        .borderRadius(10)
        .borderWidth(1)
        .borderColor($r('sys.color.ohos_id_color_text_secondary'))
        .backgroundColor($r('sys.color.ohos_id_color_background'))
      }
    }
    .width('100%')
    .margin({ top: 18 })
  }

  private importEnabled(): boolean {
    const st: HarnessState = this.st();
    return !st.busy && !st.connecting && this.configText.trim().length > 0;
  }

  /**
   * 手动配对：保留旧能力，但降到折叠区并标注前置条件。
   *
   * 它不是没用了 —— 你正坐在电脑前时，配对码比复制粘贴一段长文本更省事。
   * 问题只在于它**不能当主路径**：用户已经出门时，配对码无处可取。
   */
  @Builder
  manualPairingPanel() {
    Column() {
      this.connectionEntryRow(this.manualExpanded, '🔑',
        $r('app.string.manual_pairing'), $r('app.string.manual_pairing_hint'),
        (): void => {
          this.manualExpanded = !this.manualExpanded;
          if (this.manualExpanded) {
            this.importExpanded = false;
          }
        })

      if (this.manualExpanded) {
        Column() {
          Text($r('app.string.server_address'))
            .fontSize(11)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .width('100%')
          TextInput({ text: this.endpoint, placeholder: 'http://192.168.1.20:3090' })
            .width('100%')
            .margin({ top: 6 })
            .type(InputType.URL)
            .onChange((value: string): void => {
              this.endpoint = value;
              const vm: HarnessViewModel | null = this.vm();
              if (vm !== null) {
                vm.setEndpointDraft(value);
              }
            })

          if (this.endpoint.trim().startsWith('http://')) {
            WarningBanner({ message: $r('app.string.http_warning') })
              .margin({ top: 10 })
          }

          Button() {
            Row() {
              Text('📶').fontSize(14)
              Text($r('app.string.test_connection')).fontSize(14).margin({ left: 8 })
            }
          }
          .type(ButtonType.Capsule)
          .width('100%')
          .height(48)
          .margin({ top: 10 })
          .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .enabled(!this.st().busy && this.endpoint.trim().length > 0)
          .onClick((): void => {
            // 只探活，不建立连接 —— 刻意**不**放行连接页。
            const vm: HarnessViewModel | null = this.vm();
            if (vm !== null) {
              void vm.testConnection(this.endpoint);
            }
          })

          if (this.st().healthOk) {
            Row() {
              Text('✓')
                .fontSize(14)
                .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
              Text($r('app.string.connection_ok'))
                .fontSize(13)
                .margin({ left: 10 })
                .fontColor($r('sys.color.ohos_id_color_text_primary'))
            }
            .width('100%')
            .padding({ left: 13, right: 13, top: 11, bottom: 11 })
            .margin({ top: 10 })
            .borderRadius(10)
            .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
            .alignItems(VerticalAlign.Center)
          }

          Text($r('app.string.pairing_code'))
            .fontSize(11)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .width('100%')
            .margin({ top: 12 })
          TextInput({ text: this.code, placeholder: '' })
            .width('100%')
            .margin({ top: 6 })
            .onChange((value: string): void => {
              // 配对码统一大写（服务端就是这么发的，小写会让用户以为填错了）。
              this.code = value.toUpperCase();
            })

          Text($r('app.string.device_name'))
            .fontSize(11)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .width('100%')
            .margin({ top: 12 })
          TextInput({ text: this.deviceName, placeholder: '' })
            .width('100%')
            .margin({ top: 6 })
            .onChange((value: string): void => {
              this.deviceName = value;
            })

          Button() {
            Row() {
              Text('🔗').fontSize(14)
              Text($r('app.string.connect')).fontSize(14).margin({ left: 8 })
            }
          }
          .type(ButtonType.Capsule)
          .width('100%')
          .height(52)
          .margin({ top: 12 })
          .enabled(this.pairEnabled())
          .onClick((): void => {
            this.onEnterApp();
            const vm: HarnessViewModel | null = this.vm();
            if (vm !== null) {
              void vm.pair(this.endpoint, this.code, this.deviceName);
            }
          })
        }
        .width('100%')
        .padding(14)
        .alignItems(HorizontalAlign.Start)
        .borderRadius(10)
        .borderWidth(1)
        .borderColor($r('sys.color.ohos_id_color_text_secondary'))
        .backgroundColor($r('sys.color.ohos_id_color_background'))
      }
    }
    .width('100%')
    .margin({ top: 18 })
  }

  private pairEnabled(): boolean {
    const st: HarnessState = this.st();
    return !st.busy && this.endpoint.trim().length > 0
      && this.code.trim().length > 0 && this.deviceName.trim().length > 0;
  }
}
