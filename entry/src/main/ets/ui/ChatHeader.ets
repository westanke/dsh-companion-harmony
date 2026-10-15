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

/** 面板宿主的三态。定义在**被导入的一侧**（见文件头「状态与装饰器」最后一条）——
 * 父组件要用 `SHEET_FULL_ACCESS` 直接写 `sheetKind`，两边互相 import 会形成循环依赖。 */
export const SHEET_FILES: number = 0;
export const SHEET_CONFIG: number = 1;
export const SHEET_FULL_ACCESS: number = 2;

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
    return history === null ? null : permissionSelectOf(history);
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
    if (permission !== null && permission.options.length > 0) {
      out.push({
        value: `${this.resText($r('app.string.access_mode'))} · ${this.permissionLabel(permission.currentValue, '')}`,
        enabled: false,
        action: (): void => {
        },
      });
      const permissionEnabled: boolean = this.canWrite() && !this.st().busy;
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
          StatusLabel({
            label: this.st().eventsConnected ? $r('app.string.online') : $r('app.string.offline'),
            active: this.st().eventsConnected,
          })
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
    return this.sheetKind === SHEET_FULL_ACCESS ? 380 : SheetSize.FIT_CONTENT;
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