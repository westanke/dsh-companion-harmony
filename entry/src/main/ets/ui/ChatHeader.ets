/**
 * 聊天详情页的**头部 + 三个面板宿主** —— 从 `ui/ChatDetail.ets` 拆出
 * （见该文件头的「拆分说明」）。
 *
 * | 装什么 | 对应源工程 |
 * |---|---|
 * | 头部（标题链 / 在线状态 / `📂` `↻` `✕` `⋯`） | `ConversationHeader`（738–877） |
 * | `⋯` 菜单（模型 · 权限档位 · 插话 的压平形态） | `DropdownMenu` 内嵌的 `PermissionMenuItems` |
 * | 三个面板合成的一个 `bindSheet` 宿主 | 会话文件 / 会话配置 / 完整访问确认 |
 *
 * ## 为什么面板宿主也跟着头部走
 *
 * 头部是「会话文件 / 会话配置」两个面板**唯一**的入口（`📂` 与 `⋯`），而「完整访问确认」
 * 面板的开关状态（`fullAccessApprovalId` / `fullAccessAck`）又与头部菜单里的权限档位共用
 * 一套判据。把头部与这套面板宿主放在一起，`openSheet` / `closeSheet` / `sheetContent` /
 * `sheetHeight` 就不再需要跨组件回调；只有「审批区请求二次确认」这一条从父组件进来
 * （走 `@Link` 直接写 `sheetKind` / `sheetOpen`）。
 *
 * ## 状态与装饰器（违反会出「点了没反应 / 数据不更新」的真缺陷）
 *
 * - 面板那四份状态（`sheetOpen` / `sheetKind` / `fullAccessApprovalId` / `fullAccessAck`）
 *   的**唯一数据源仍在 `ChatDetail`**（父组件）：本组件用 `@Link` 双向绑定 —— 本组件要写
 *   （`openSheet` / `closeSheet` / 勾选框 / 下拉关闭），父组件也要写（审批区走二次确认）。
 *   在本组件里再复制一份 `@State` 会变成双数据源，两边打架。
 * - `message` 同理：与 `ChatComposer` 共享父组件那一份（插话时读它，发送后清它）。
 * - `wide` 走 `@Prop`（单向只读）：普通成员在子组件里会**永远停在首帧值**。
 * - 函数 / 回调用**普通成员**：`@Prop` 不允许函数类型，函数也不需要响应式。
 * - `SHEET_FILES` / `SHEET_CONFIG` / `SHEET_FULL_ACCESS` 定义在**本文件**（被父组件导入的
 *   那一侧）：父组件要用 `SHEET_FULL_ACCESS` 直接写 `sheetKind`，两个文件互相 import 会形成
 *   循环依赖，故常量跟着面板体走（与 `ui/SessionSheets.ets` 同一条理由）。
 */
import { common } from '@kit.AbilityKit';
import {
  AgentPreset, ChatHistory, ChatSession, ModelSelection, PendingApproval, PermissionOption,
  PermissionSelect,
} from '../core/Models';
import { ApprovalUiKind, HarnessState, HarnessViewModel } from '../core/HarnessViewModel';
import { permissionSelectOf } from '../core/ChatPresentation';
import { canSubmit } from '../core/ComposerSendPolicy';
import { harnessState, harnessVm, requestFilesSection } from './AppRuntime';
import { StatusLabel } from './Components';
import { SessionFilesSheet } from './SessionFilesSheet';
import { SessionConfigSheet } from './ModelSheet';
import { SessionStatsSheet } from './SessionStatsSheet';

/** 面板宿主的四态（会话文件 / 会话配置 / 完整访问确认 / 执行统计）。
 * 定义在**被导入的一侧**（见文件头「状态与装饰器」最后一条）——
 * 父组件要用 `SHEET_FULL_ACCESS` 直接写 `sheetKind`，两边互相 import 会形成循环依赖。 */
export const SHEET_FILES: number = 0;
export const SHEET_CONFIG: number = 1;
export const SHEET_FULL_ACCESS: number = 2;
export const SHEET_STATS: number = 3;

/** 聊天详情页头部 + 三个面板宿主（会话文件 / 会话配置 / 完整访问确认）。 */
@Component
export struct ChatHeaderPanelHost {
  /** 窄屏时显示返回键（宽屏详情常驻，没有「返回列表」这回事）。 */
  @Prop wide: boolean = false;
  /** 请求返回会话列表（原 `ChatDetail.onBack`）。 */
  onBack: () => void = (): void => {};

  /** 输入框原文：唯一数据源在 `ChatDetail`，这里与它（以及 `ChatComposer`）共享同一份。 */
  @Link message: string;

  // ——— 面板宿主：唯一数据源在 `ChatDetail`，这里双向绑定（见文件头「状态与装饰器」）———
  @Link sheetOpen: boolean;
  @Link sheetKind: number;
  /**
   * 正在等二次确认的那条审批 id；**空串**表示「这次确认的是权限档位切换」而不是审批。
   * 两种请求共用同一个面板，因为它们要问的是同一件事（要不要给出完整访问），
   * 勾选要求也一字不差。
   */
  @Link fullAccessApprovalId: string;
  @Link fullAccessAck: boolean;

  // ——— 交回父组件的动作（函数类型用普通成员）———
  /** 审批放行 / 拒绝（原 `ChatDetail.decide`）：二次确认面板按下确认键时要用。 */
  onDecide: (approval: PendingApproval, allowOnce: boolean) => void = (): void => {};
  /** 滚到会话尾部（原 `ChatDetail.scrollToBottom`）：插话提交成功后要用。 */
  onScrollToBottom: () => void = (): void => {};
  /**
   * 打开执行轨迹页（全屏）。
   *
   * 做成回调而不是让头部自己开：轨迹页是**全屏覆盖**，它的显隐状态必须住在
   * `ChatDetail`（覆盖层挂在详情页的根节点上）。头部只是入口，不持有它的状态 ——
   * 与图片查看器同一个理由（见 PORT-MAP 坑 34）。
   */
  onOpenTrajectory: () => void = (): void => {};

  /** 自订阅 vm 的 revision，理由同 `ChatDetail.st()`。 */
  @StorageLink('dshRevision') revision: number = 0;
  /** vm 还没装配时的兜底状态，避免 getter 里到处判空。 */
  private fallback: HarnessState = new HarnessState();

  // ————————————————— 基础访问 —————————————————

  private st(): HarnessState {
    // 读一次 revision：ArkUI 只把 **build 期间读过**的状态登记为依赖
    // （编译器把 build 体包在 `StartGetAccessRecordingFor` … `StopGetAccessRecording` 之间），
    // 只声明 `@StorageLink` 而不读它，vm 更新时这个组件不会重绘 —— 表现就是消息列表、
    // 思考条、审批区都不动。见 PORT-MAP §1b 坑 12。恒真的比较只为让这次读取发生。
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

  private canWrite(): boolean {
    return this.scopes().includes('chat.write');
  }

  private selectedId(): string | null {
    return this.st().selectedSessionId;
  }

  private currentSession(): ChatSession | null {
    const id: string | null = this.selectedId();
    if (id === null) {
      return null;
    }
    const list: ChatSession[] = this.st().sessions;
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id) {
        return list[i];
      }
    }
    return null;
  }

  private hostContext(): common.Context | undefined {
    return this.getUIContext().getHostContext();
  }

  /** 无参资源 → 字符串（只在必须拿 string 的场合用：系统弹窗、字符串拼接）。 */
  private resText(res: Resource): string {
    const ctx: common.Context | undefined = this.hostContext();
    if (ctx === undefined) {
      return '';
    }
    return ctx.resourceManager.getStringSync(res.id);
  }

  // ————————————————— 头部 —————————————————

  private refreshHistory(): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      void vm.refreshHistory();
    }
  }

  /**
   * 详情页标题链：`title ?? workspaceTitle ?? (cwd 非空取 cwd，否则取 id)`。
   * **完整 id，不是列表行的前 12 位**（见文件头判据 1）。
   */
  private headerTitle(): string {
    const session: ChatSession | null = this.currentSession();
    if (session === null) {
      return '';
    }
    const title: string | null = session.title;
    if (title !== null) {
      return title;
    }
    const workspaceTitle: string | null = session.workspaceTitle;
    if (workspaceTitle !== null) {
      return workspaceTitle;
    }
    if (session.cwd.trim().length > 0) {
      return session.cwd;
    }
    return session.id;
  }

  private permission(): PermissionSelect | null {
    const history: ChatHistory | null = this.st().history;
    // 候选**不来自投影**：投影那条 wire 视图只给 `currentValue`，列不出候选
    // （源工程 v2.2.44 真机验收实测：读投影 options 恒为空 → 整条权限入口都不渲染）。
    // 候选来自连接时单独取的目录（`state.permissionCatalog`），这里只是把它递给解析函数。
    return history === null ? null : permissionSelectOf(history, this.st().permissionCatalog);
  }

  private approvalIsNone(): boolean {
    return this.st().approvalState.kind === ApprovalUiKind.NONE;
  }

  /** 插话可用的三条判据（见文件头判据 4）。 */
  private canSteer(): boolean {
    return this.approvalIsNone() && this.canWrite()
      && (canSubmit(this.message, this.canWrite()) || this.st().pendingAttachments.length > 0);
  }

  /** 权限档位的中文名：值 → 资源，未命中就用服务端给的展示名，再不行用原值。 */
  private permissionLabel(value: string, fallback: string): string {
    if (value === 'read-only') {
      return this.resText($r('app.string.permission_read_only'));
    }
    if (value === 'workspace-write') {
      return this.resText($r('app.string.permission_workspace_write'));
    }
    if (value === 'danger-full-access') {
      return this.resText($r('app.string.permission_full_access'));
    }
    if (value === 'custom') {
      return this.resText($r('app.string.permission_custom'));
    }
    return fallback.length > 0 ? fallback : value;
  }

  private modelSummary(): string {
    const session: ChatSession | null = this.currentSession();
    const presets: AgentPreset[] = this.st().agentPresets;
    let agentName: string = session === null ? '' : (session.agentPreset ?? '');
    for (let i = 0; i < presets.length; i++) {
      if (session !== null && presets[i].id === session.agentPreset) {
        agentName = presets[i].name;
        break;
      }
    }
    const models = this.st().sessionModels;
    const provider: string = models === null ? '' : models.current.provider;
    const model: string = models === null ? '' : models.current.model;
    const parts: string[] = [];
    if (agentName.length > 0) {
      parts.push(agentName);
    }
    if (provider.length > 0) {
      parts.push(provider);
    }
    if (model.length > 0) {
      parts.push(model);
    }
    return parts.join(' · ');
  }

  private modelMenuEnabled(): boolean {
    const models = this.st().sessionModels;
    return models !== null && models.routable;
  }

  /**
   * `⋯` 菜单项。
   *
   * 三项顺序照抄源工程：**模型** → **权限档位** → **插话**。权限那一段在源工程里是
   * `DropdownMenu` 内嵌的一段（当前值一行 + 每个档位一行），这里压平成同一级菜单
   * （见文件头差异 3），但档位顺序、`custom` 不显示、`danger-full-access` 走二次确认不变。
   */
  private moreMenuItems(): MenuElement[] {
    const out: MenuElement[] = [];
    const summary: string = this.modelSummary();
    out.push({
      value: summary.length > 0
        ? `${this.resText($r('app.string.model'))} · ${summary}`
        : $r('app.string.model'),
      enabled: this.modelMenuEnabled(),
      action: (): void => {
        this.openSheet(SHEET_CONFIG);
      },
    });

    const permission: PermissionSelect | null = this.permission();
    // 候选项为空时**仍然**渲染「访问权限 · 当前档位」那一行（源工程 `PermissionMenuItems`
    // 的同款注释）：那是用户在菜单里唯一能看到「我现在是什么权限档位」的地方。
    // 只有这一行、下面没有可选项时菜单是只读的，但「看不见」比「看得见却切不了」
    // 更让人怀疑 App 坏了 —— v2.2.44 真机验收里，这一行连同整个权限入口一起消失了。
    if (permission !== null) {
      out.push({
        value: `${this.resText($r('app.string.access_mode'))} · `
          + `${this.permissionLabel(permission.currentValue, this.permissionCurrentName())}`,
        enabled: false,
        action: (): void => {
        },
      });
      const permissionEnabled: boolean = this.permissionPillEnabled();
      for (let i = 0; i < permission.options.length; i++) {
        const option: PermissionOption = permission.options[i];
        if (option.value === 'custom') {
          continue;
        }
        const mark: string = option.value === permission.currentValue ? '✓ ' : '';
        out.push({
          value: `${mark}${this.permissionLabel(option.value, option.name)}`,
          enabled: permissionEnabled,
          action: (): void => {
            this.onPermissionPicked(option.value);
          },
        });
      }
    }

    out.push({
      value: `${this.resText($r('app.string.steer'))} · ${this.resText($r('app.string.busy_send_mode_steer_desc'))}`,
      enabled: this.canSteer(),
      action: (): void => {
        this.steer();
      },
    });

    // 下面两项是**只读的查看入口**（统计 / 轨迹），不改任何状态，所以一直可用。
    // 放在菜单末尾：它们是排查用的次要动作，不该挤占模型与权限的位置。
    out.push({
      value: this.resText($r('app.string.session_stats_title')),
      enabled: true,
      action: (): void => {
        this.openSheet(SHEET_STATS);
      },
    });
    out.push({
      value: this.resText($r('app.string.trajectory_title')),
      enabled: true,
      action: (): void => {
        this.onOpenTrajectory();
      },
    });
    return out;
  }

  /** 权限档位被点中：完整访问要走二次确认，其余直接提交。 */
  private onPermissionPicked(value: string): void {
    if (value === 'danger-full-access') {
      this.fullAccessApprovalId = '';
      this.fullAccessAck = false;
      this.openSheet(SHEET_FULL_ACCESS);
      return;
    }
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      void vm.selectPermissionPreset(value);
    }
  }

  // ————————————————— 权限档位 Pill（顶栏那枚小胶囊）—————————————————

  /**
   * 当前档位在**候选项里的展示名**（服务端给的，可能是「Workspace Write」这种
   * 比内置文案更具体的说法）；候选为空或没匹配上就是空串。
   *
   * 抽出来给两个入口共用（Pill 与 ⋯ 菜单的标题行）—— 两处显示不一致的话，
   * 用户会以为是两个不同的设置。
   */
  private permissionCurrentName(): string {
    const permission: PermissionSelect | null = this.permission();
    if (permission === null) {
      return '';
    }
    for (let i = 0; i < permission.options.length; i++) {
      if (permission.options[i].value === permission.currentValue) {
        return permission.options[i].name;
      }
    }
    return '';
  }

  /**
   * 权限档位胶囊上那行字。候选为空时只能用内置文案 + 原值兜底 ——
   * 那时界面仍要显示当前档位（见下面 Pill 那一段注释）。
   */
  private permissionPillLabel(): string {
    const permission: PermissionSelect | null = this.permission();
    if (permission === null) {
      return '';
    }
    return this.permissionLabel(permission.currentValue, this.permissionCurrentName());
  }

  /** 候选非空才谈得上切换；空的时候胶囊不可点（但仍显示当前档位）。 */
  private permissionSwitchable(): boolean {
    const permission: PermissionSelect | null = this.permission();
    return permission !== null && permission.options.length > 0;
  }

  /**
   * Pill 能否点：与 ⋯ 菜单里权限项**同一条判据**（要能写、且没有别的事在跑）。
   *
   * 连 `danger-full-access` 都一并交给 `onPermissionPicked` 走二次确认 —— 档位越高越要过闸，
   * 这条判据在两个入口必须一致，否则用户会发现「Pill 里点得动、菜单里点不动」。
   */
  private permissionPillEnabled(): boolean {
    return this.canWrite() && !this.st().busy;
  }

  /**
   * Pill 点开的档位菜单：与 ⋯ 菜单里权限项那一段**逐条对应**
   * （`custom` 跳过、当前档位带 `✓`、`danger-full-access` 走二次确认）。
   *
   * 与 ⋯ 菜单的唯一差别是**没有那行只读的标题**：胶囊本身已经写着当前档位了。
   */
  private permissionMenuItems(): MenuElement[] {
    const out: MenuElement[] = [];
    const permission: PermissionSelect | null = this.permission();
    if (permission === null) {
      return out;
    }
    const enabled: boolean = this.permissionPillEnabled();
    for (let i = 0; i < permission.options.length; i++) {
      const option: PermissionOption = permission.options[i];
      if (option.value === 'custom') {
        continue;
      }
      const mark: string = option.value === permission.currentValue ? '✓ ' : '';
      out.push({
        value: `${mark}${this.permissionLabel(option.value, option.name)}`,
        enabled: enabled,
        action: (): void => {
          this.onPermissionPicked(option.value);
        },
      });
    }
    return out;
  }

  /**
   * 顶栏「已连接 / 已断开」后面那枚**权限档位胶囊**。
   *
   * ## 为什么在这里、为什么是这个形态
   *
   * 源工程原先把它放在**输入区上方**且 `.fillMaxWidth()` 独占一整条，用户 2026-10-19
   * 反馈「影响页面可视区域」；后来挪到会话顶栏、贴在状态文字后面，宽度自适应。
   * 挪动的理由不只是省一行 —— 语义也更顺：它跟「已连接」一样，都是**当前会话的处境**。
   *
   * ## 与 ⋯ 菜单同源，是「第三个入口」不是第二套语义
   *
   * 候选来自同一份 `permission()`，切换动作也走同一个 `onPermissionPicked`
   * （`danger-full-access` 照样过二次确认面板）。所以这里**不重写**任何判断逻辑，
   * 只换容器 —— 两处行为不可能出现分歧。
   *
   * ## 候选为空时仍要渲染（源工程踩过的坑）
   *
   * 源工程原先有一句「候选项为空就整个入口不渲染」，把「拿不到候选项」升级成
   * 「入口消失」；v2.2.44 真机验收时看到的正是整条 Pill + ⋯ 权限项一起不见、
   * 而 PARITY 上还标着 done。现在候选项来自独立目录接口，老 bridge（没这条路由）
   * 时列表为空 —— 那时只渲染一个**不可点**的档位标签：
   * 用户至少看得见自己在什么档位上，切不了是「服务端还没给这个能力」，
   * 不是「界面出故障了」。
   *
   * 胶囊本体（可切换 / 不可切换两态）。
   *
   * 为什么写成两个分支而不是「一个胶囊 + `.enabled(false)`」：`.bindMenu` 的弹出
   * 到底是否受 `enabled` 抑制，在 ArkTS 侧没有明确保证。分支摆在明面上、行为可预期 ——
   * 不可切换时压根没有菜单可弹，而不是「弹一个空菜单」。
   */
  @Builder
  permissionPill() {
    if (this.permissionSwitchable()) {
      Row() {
        Text('🔒')
          .fontSize(10)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        Text(this.permissionPillLabel())
          .fontSize(11)
          .fontWeight(FontWeight.Medium)
          .maxLines(1)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .margin({ left: 3 })
      }
      .padding({ left: 7, right: 7, top: 2, bottom: 2 })
      .borderRadius(999)
      .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
      .opacity(this.permissionPillEnabled() ? 1 : 0.5)
      .bindMenu(this.permissionMenuItems())
    } else {
      Row() {
        Text('🔒')
          .fontSize(10)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        Text(this.permissionPillLabel())
          .fontSize(11)
          .fontWeight(FontWeight.Medium)
          .maxLines(1)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .margin({ left: 3 })
      }
      .padding({ left: 7, right: 7, top: 2, bottom: 2 })
      .borderRadius(999)
      .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
      .opacity(0.5)
    }
  }

  /** 插话：固定 steer 提交（不受设置里的「繁忙时默认行为」影响）。 */
  private steer(): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null && this.canSteer()) {
      void vm.sendMessage(this.message, true);
      this.message = '';
      this.onScrollToBottom();
    }
  }

  private cancelRun(): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      void vm.cancelRun();
    }
  }

  @Builder
  header() {
    Column() {
      Row() {
        if (!this.wide) {
          Text('←')
            .fontSize(18)
            .padding(10)
            .onClick((): void => {
              this.onBack();
            })
        }
        Column() {
          Text(this.headerTitle())
            .fontSize(16)
            .fontWeight(FontWeight.Medium)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
          // 状态行：连接状态（绿/红点）+ 权限档位 Pill **同一行**。
          // Pill 原先在源工程里贴在输入区上方且独占一整条（用户 2026-10-19 反馈
          // 「影响页面可视区域」），挪到这里既省掉那一行，语义也更顺：两者都是
          // 「当前会话的处境」。间距 8vp 对位源工程的 `spacedBy(8.dp)`。
          Row() {
            StatusLabel({
              label: this.st().eventsConnected ? $r('app.string.online') : $r('app.string.offline'),
              active: this.st().eventsConnected,
            })
            if (this.permission() !== null) {
              Row() {
                this.permissionPill()
              }
              .margin({ left: 8 })
            }
          }
          .alignItems(VerticalAlign.Center)
          if (this.currentSession() !== null
            && (this.currentSession() as ChatSession).pendingInteraction === 'approval') {
            Row() {
              Text('⚠')
                .fontSize(12)
                .fontColor($r('sys.color.ohos_id_color_warning'))
              Text($r('app.string.awaiting_approval'))
                .fontSize(12)
                .fontColor($r('sys.color.ohos_id_color_warning'))
                .margin({ left: 5 })
            }
            .margin({ top: 2 })
            .alignItems(VerticalAlign.Center)
          }
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
        .margin({ left: this.wide ? 16 : 2 })

        Text('📂')
          .fontSize(17)
          .padding(9)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .onClick((): void => {
            this.openSheet(SHEET_FILES);
          })
        Text('↻')
          .fontSize(17)
          .padding(9)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .opacity(this.st().busy ? 0.4 : 1)
          .onClick((): void => {
            if (!this.st().busy) {
              this.refreshHistory();
            }
          })
        if (this.currentSession() !== null && (this.currentSession() as ChatSession).running) {
          Text('✕')
            .fontSize(17)
            .padding(9)
            .fontColor($r('sys.color.ohos_id_color_alert'))
            .opacity(this.canWrite() ? 1 : 0.4)
            .onClick((): void => {
              if (this.canWrite()) {
                this.cancelRun();
              }
            })
        }
        Text('⋯')
          .fontSize(17)
          .padding(9)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .bindMenu(this.moreMenuItems())
      }
      .width('100%')
      .padding({ left: 8, right: 8, top: 3, bottom: 3 })
      .alignItems(VerticalAlign.Center)

      Divider()
        .strokeWidth(1)
        .color($r('sys.color.ohos_id_color_list_separator'))
    }
    .width('100%')
  }

  // ————————————————— 面板宿主 —————————————————

  /** 二次确认面板按下确认键：审批放行，或切换到完整访问档位。 */
  private confirmFullAccess(): void {
    const approvalId: string = this.fullAccessApprovalId;
    this.closeSheet();
    if (approvalId.length === 0) {
      const vm: HarnessViewModel | null = this.vm();
      if (vm !== null) {
        void vm.selectPermissionPreset('danger-full-access');
      }
      return;
    }
    const items: PendingApproval[] = this.st().approvalState.items;
    for (let i = 0; i < items.length; i++) {
      if (items[i].id === approvalId) {
        this.onDecide(items[i], true);
        return;
      }
    }
  }

  private openSheet(kind: number): void {
    this.sheetKind = kind;
    this.sheetOpen = true;
  }

  private closeSheet(): void {
    this.sheetOpen = false;
  }

  /** 面板高度：完整体验优先，内容最少的那块（全访问确认）给够即可。 */
  private sheetHeight(): SheetSize | number {
    // 会话配置面板（`SHEET_CONFIG`）用 `FIT_CONTENT`：内容是「Agent 预设 + 各 provider 的
    // 模型清单」，长度随 provider 数量浮动。原先用 `SheetSize.LARGE`（近全屏）时，只有
    // 一个 provider 的会话会在面板下半部留出近半屏空白（真机截图实证，见 PORT-MAP 坑 20）
    // —— 源工程的 Compose `ModalBottomSheet` 默认就是**按内容自适应高度**，`FIT_CONTENT`
    // 才是对位写法；内容长了它同样会撑满并滚动。
    // 全访问二次确认面板是固定短内容（一个勾选框 + 两行文案），继续用固定高度 380。
    // 统计面板（`SHEET_STATS`）内容比它还短（四行数字 + 两段说明），也给 380 ——
    // `FIT_CONTENT` 下这块会在底部留出一段空白，看起来像"没加载完"。
    if (this.sheetKind === SHEET_FULL_ACCESS || this.sheetKind === SHEET_STATS) {
      return 380;
    }
    return SheetSize.FIT_CONTENT;
  }

  private openSessionFile(path: string): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      void vm.openSessionFile(path);
    }
  }

  private closeSessionFile(): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      vm.closeSessionFile();
    }
  }

  @Builder
  sheetContent() {
    Column() {
      if (this.sheetKind === SHEET_FILES) {
        SessionFilesSheet({
          history: this.st().history,
          open: this.st().sessionFileOpen,
          sessionId: this.selectedId(),
          onOpen: (path: string): void => {
            this.openSessionFile(path);
          },
          onBack: (): void => {
            this.closeSessionFile();
          },
          // 「打开目录」= 切到「文件」分节并就地浏览该目录。
          //
          // 会话页拿不到分节状态（`AppShell.section` 是外壳自己的局部 state，没有路由参数可用），
          // 所以走 `AppRuntime.requestFilesSection()`：它在 `AppStorage` 里发一个递增序号，
          // 外壳用 `@StorageLink + @Watch` 收到后切分节。
          //
          // 顺序很关键：**先把目录读好再发请求**。反过来的话外壳切过去时
          // `directory` 还是上一个目录的旧列表，用户会看到"点了目录却停在原地"。
          onOpenDirectory: (rootId: string, path: string): void => {
            const vm: HarnessViewModel | null = this.vm();
            if (vm === null) {
              return;
            }
            // 面板是同一次交互的一部分，跳走之前先关掉它，否则切完分节还会挂在上面。
            // 关面板要动的是 `sheetOpen`（`sheetKind` 只是分派标，它管不了显隐）。
            this.sheetOpen = false;
            requestFilesSection();
            void vm.revealDirectory(rootId, path);
          },
        })
      } else if (this.sheetKind === SHEET_CONFIG) {
        SessionConfigSheet({
          onSelectAgent: (id: string): void => {
            const vm: HarnessViewModel | null = this.vm();
            if (vm !== null) {
              void vm.selectAgentPreset(id);
            }
          },
          onSelectModel: (selection: ModelSelection): void => {
            const vm: HarnessViewModel | null = this.vm();
            if (vm !== null) {
              void vm.selectModel(selection);
            }
          },
        })
      } else if (this.sheetKind === SHEET_STATS) {
        SessionStatsSheet({ history: this.st().history })
      } else {
        Column() {
          Text($r('app.string.permission_full_access_title'))
            .fontSize(18)
            .fontWeight(FontWeight.Medium)
            .width('100%')
          Text($r('app.string.permission_full_access_warning'))
            .fontSize(13)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .width('100%')
            .margin({ top: 10 })
          Row() {
            Checkbox({ name: 'fullAccessAck' })
              .select(this.fullAccessAck)
              .onChange((checked: boolean): void => {
                this.fullAccessAck = checked;
              })
            Text($r('app.string.permission_full_access_ack'))
              .fontSize(13)
              .layoutWeight(1)
              .margin({ left: 4 })
          }
          .width('100%')
          .margin({ top: 12 })
          .alignItems(VerticalAlign.Center)

          Row() {
            Button($r('app.string.close'))
              .type(ButtonType.Capsule)
              .layoutWeight(1)
              .height(44)
              .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
              .fontColor($r('sys.color.ohos_id_color_text_primary'))
              .onClick((): void => {
                this.closeSheet();
              })
            Button($r('app.string.enable_full_access'))
              .type(ButtonType.Capsule)
              .layoutWeight(1)
              .height(44)
              .margin({ left: 10 })
              .enabled(this.fullAccessAck)
              .onClick((): void => {
                this.confirmFullAccess();
              })
          }
          .width('100%')
          .margin({ top: 18 })
        }
        .width('100%')
        .height('100%')
        .alignItems(HorizontalAlign.Start)
      }
    }
    .width('100%')
    .height('100%')
    .padding({ left: 18, right: 18, top: 8, bottom: 16 })
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
  }

  /**
   * 头部渲染条件与拆分前一致（原 `ChatDetail.build` 只在选中会话时才画头部）；但**面板宿主
   * 挂在这层不随会话变化的容器上** —— 拆分前 `bindSheet` 挂在 `ChatDetail` 的根容器（恒存在），
   * 若改挂到「只在选中会话时才渲染」的节点上，取消选中会话的瞬间面板会被连带卸载。
   */
  build() {
    Column() {
      if (this.currentSession() !== null) {
        this.header()
      }
    }
    .width('100%')
    // 一个面板宿主（见 ChatDetail 文件头差异 1）。`isShow` 走单向：用户下拉关掉时靠
    // `onDisappear` 复位标志，否则标志会留在 true，下一次再设 true 就不再触发。
    .bindSheet(this.sheetOpen, this.sheetContent(), {
      height: this.sheetHeight(),
      dragBar: true,
      onDisappear: (): void => {
        this.sheetOpen = false;
      },
    })
  }
}