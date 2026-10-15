/**
 * 会话分节 —— 移植自原工程 `ui/ChatScreen.kt`（3619 行）的**会话列表**这一半：
 * `SessionPane`（会话列表容器）、`SessionRow`（单条会话）、`NewSessionSheet`（新建会话面板）、
 * `WorkspaceManagementSheet`（管理工作区面板）、`RenameDialog`（重命名）。
 *
 * 聊天**详情**页（消息流、输入药丸、思考条、工具行、dsh-ui 卡片、审批/问答面板、附件、
 * 会话文件面板）在 `ui/ChatDetail.ets` 里，这里只负责在右栏把它挂上（`detailPane`）。
 * 两件独立的事分开写：本文件管「有哪些会话」，`ChatDetail` 管「这个会话里发生了什么」。
 *
 * ## 与源工程的两处有意差异（都是为了少一层 API 风险）
 *
 * 1. **三个面板合成一个宿主**。源工程是两个 `ModalBottomSheet`（新建会话、管理工作区）
 *    加一个 `AlertDialog`（重命名输入框）。ArkUI 的 `bindSheet` 在一个组件上挂多个面板
 *    时行为与版本相关，`CustomDialog` 又要把输入框状态在两个组件间来回搬；所以这里用
 *    **一个 `bindSheet` + `sheetKind` 分发**：面板的显隐只有一个来源，`renameDraft` 也
 *    只存在于本组件，不必跨组件同步。
 * 2. **三处下拉换成 `bindMenu` 的数据形式**（`MenuElement[]`）而不是自绘弹层。源工程用的是
 *    `DropdownMenu`，ArkUI 的对位能力就是 `bindMenu`；用数据形式可以**完全避开**
 *    `CustomBuilder` 传参约定的坑，代价是工作区/预设菜单的副标题要并进同一行文字里。
 *
 * ## 照抄源工程、不许简化的四点
 *
 * 1. 列表标题的回退链是 `title ?? workspaceTitle ?? (cwd 为空时取 id 前 12 位)`，
 *    且**只对 null 回退**（空串算有值）：服务端把「工作目录就是授权根」这种情况
 *    表示成空 `cwd`，这里若把空串也当缺失，就会把 `workspaceTitle` 顶掉。
 * 2. `chat.write` 只管「新建/管理工作区」这两个入口；**列表本身**只看 `chat.read`
 *    （`AppShell.sectionEnabled` 已经保证了这一层）。没有写权限的设备能看会话、但不能建。
 * 3. 新建会话面板的「已有工作区 / 新建工作区」是**互斥分段**：新建工作区分支要靠
 *    `workspacePickerDirectory != null` 才能提交（那是「已经在服务端把目录读出来了」的证据），
 *    否则会提交一个空的根路径。
 * 4. 重命名/归档/移除工作区都**必须二次确认**（重命名用输入面板，归档与移除用系统弹窗）：
 *    它们改的是电脑上的真实数据，点一下图标就生效是不行的。
 */

import { common } from '@kit.AbilityKit';
import { AgentPreset, ChatSession, ChatWorkspace, FileEntry } from '../core/Models';
import { HarnessState, HarnessViewModel } from '../core/HarnessViewModel';
import { harnessState, harnessVm } from './AppRuntime';
import { StatusLabel } from './Components';
import { ChatDetail } from './ChatDetail';

/** 底部面板的三种形态。`sheetKind` 只在本文件内使用，故用数字常量而非导出枚举。 */
const SHEET_CREATE: number = 0;
const SHEET_WORKSPACES: number = 1;
const SHEET_RENAME: number = 2;

/**
 * 会话列表里的一行。
 *
 * 自成一个组件而不是写成 `@Builder`：它的菜单项（重命名 / 分支 / 归档）各自绑到本行的实例上，
 * 写成独立组件后 `ForEach` 的复用与键控才只作用于这一行。
 */
@Component
struct SessionRow {
  session: ChatSession = new ChatSession();
  selected: boolean = false;
  /**
   * 本行是否可操作（对应源工程的 `enabled = !state.busy`）。
   *
   * 名字**不能**叫 `enabled`：ArkUI 的 `CustomComponent` 基类上已经有一个
   * 同名的通用属性方法 `enabled(value)`，同名会报
   * 「Property 'enabled' ... is not assignable to the same property in base type」（10505001）。
   */
  rowEnabled: boolean = true;
  onSelect: (id: string) => void = (): void => {};
  onRename: (session: ChatSession) => void = (): void => {};
  onFork: (id: string) => void = (): void => {};
  onArchive: (session: ChatSession) => void = (): void => {};

  /**
   * 行标题。逐字照抄源工程：
   * `session.title ?: session.workspaceTitle ?: session.cwd.ifBlank { session.id.take(12) }`
   * —— 只有 null 才回退，空串算有值（见文件头第 1 点）。
   */
  private displayTitle(): string {
    const title: string | null = this.session.title;
    if (title !== null) {
      return title;
    }
    const workspaceTitle: string | null = this.session.workspaceTitle;
    if (workspaceTitle !== null) {
      return workspaceTitle;
    }
    const cwd: string = this.session.cwd;
    if (cwd.trim().length > 0) {
      return cwd;
    }
    return this.session.id.length > 12 ? this.session.id.substring(0, 12) : this.session.id;
  }

  /** 副标题：工作区名，且**只在它与主标题不同**时才显示（同源工程 `takeIf { it != displayTitle }`）。 */
  private workspaceSubtitle(): string {
    const workspaceTitle: string | null = this.session.workspaceTitle;
    if (workspaceTitle === null || workspaceTitle === this.displayTitle()) {
      return '';
    }
    return workspaceTitle;
  }

  /** 行右侧「⋮」的菜单项。 */
  private rowMenuItems(): MenuElement[] {
    return [
      {
        value: $r('app.string.rename_session'),
        action: (): void => {
          this.onRename(this.session);
        },
      },
      {
        value: $r('app.string.fork_session'),
        action: (): void => {
          this.onFork(this.session.id);
        },
      },
      {
        value: $r('app.string.archive_session'),
        action: (): void => {
          this.onArchive(this.session);
        },
      },
    ];
  }

  build() {
    Row() {
      Text('💬')
        .fontSize(15)
        .width(36)
        .height(36)
        .textAlign(TextAlign.Center)
        .borderRadius(18)
        .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
        .fontColor(this.selected
          ? $r('sys.color.ohos_id_color_text_primary_activated')
          : $r('sys.color.ohos_id_color_text_secondary'))

      Column() {
        Text(this.displayTitle())
          .fontSize(15)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')

        Row() {
          if (this.session.pendingInteraction === 'approval') {
            StatusLabel({ label: $r('app.string.approval_pending'), active: true })
          } else {
            StatusLabel({
              label: this.session.running ? $r('app.string.session_running') : $r('app.string.session_idle'),
              active: this.session.running,
            })
          }
          if (this.workspaceSubtitle().length > 0) {
            Text(this.workspaceSubtitle())
              .fontSize(11)
              .fontColor($r('sys.color.ohos_id_color_text_secondary'))
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .margin({ left: 8 })
              .layoutWeight(1)
          }
        }
        .margin({ top: 2 })
        .alignItems(VerticalAlign.Center)
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
      .margin({ left: 10, right: 4 })

      // 会话操作入口。`bindMenu` 的数据形式挂在点击上；`.enabled(false)` 时整颗菜单不响应，
      // 对应源工程 `IconButton(enabled = !state.busy)`。
      Text('⋮')
        .fontSize(16)
        .padding(8)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .opacity(this.rowEnabled ? 1 : 0.4)
        .enabled(this.rowEnabled)
        .bindMenu(this.rowMenuItems())
    }
    .width('100%')
    .padding({ left: 6, right: 6, top: 7, bottom: 7 })
    .borderRadius(8)
    .backgroundColor(this.selected
      ? $r('sys.color.ohos_id_color_sub_background')
      : Color.Transparent)
    .alignItems(VerticalAlign.Center)
    .onClick((): void => {
      this.onSelect(this.session.id);
    })
  }
}

/** 会话分节（对话列表 + 新建/管理工作区 + 重命名），以及聊天详情页占位。 */
@Component
export struct ChatScreen {
  /** 宽屏（>= 840vp）：左栏常驻会话列表 + 右栏详情。对位 `ChatScreen(state, viewModel, wide)`。 */
  wide: boolean = false;

  /** 订阅 vm 的 revision：任何 `update()` 都会让本组件重新 build。 */
  @StorageLink('dshRevision') revision: number = 0;

  // ——— 底部面板宿主（见文件头差异 1） ———
  @State sheetOpen: boolean = false;
  @State sheetKind: number = SHEET_CREATE;

  // ——— 新建会话面板 ———
  /** false = 用已有工作区；true = 新建工作区。两者互斥。 */
  @State newWorkspace: boolean = false;
  @State workspaceId: string = '';
  /** 空串表示「服务端默认」，与源工程一致（提交时转成 null）。 */
  @State presetId: string = '';

  // ——— 重命名面板（会话与工作区共用） ———
  @State renameIsWorkspace: boolean = false;
  @State renameTargetId: string = '';
  @State renameDraft: string = '';

  /** vm 还没装配时的兜底状态，避免 getter 里到处判空。 */
  private fallback: HarnessState = new HarnessState();

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

  /** 只有拿到 `chat.write` 的设备才显示「新建会话」「管理工作区」两个入口。 */
  private canWriteChat(): boolean {
    return this.scopes().includes('chat.write');
  }

  private selectedId(): string | null {
    return this.st().selectedSessionId;
  }

  private selectedSession(): ChatSession | null {
    const id: string | null = this.st().selectedSessionId;
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

  /** 标题回退链，与 `SessionRow.displayTitle` 同一条（两处必须一致）。 */
  private displayTitleOf(session: ChatSession): string {
    const title: string | null = session.title;
    if (title !== null) {
      return title;
    }
    const workspaceTitle: string | null = session.workspaceTitle;
    if (workspaceTitle !== null) {
      return workspaceTitle;
    }
    const cwd: string = session.cwd;
    if (cwd.trim().length > 0) {
      return cwd;
    }
    return session.id.length > 12 ? session.id.substring(0, 12) : session.id;
  }

  /** 参数化资源 → 字符串（只在必须拿 string 的场合用：系统弹窗、字符串拼接）。 */
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

  // ————————————————— 面板：打开 / 关闭 —————————————————

  private closeSheet(): void {
    this.sheetOpen = false;
  }

  /** 面板高度：重命名是短表单，其余两块内容多，直接给大半屏。 */
  private sheetHeight(): SheetSize | number {
    return this.sheetKind === SHEET_RENAME ? 300 : SheetSize.LARGE;
  }

  private openCreateSheet(): void {
    const workspaces: ChatWorkspace[] = this.st().chatWorkspaces;
    this.workspaceId = workspaces.length > 0 ? workspaces[0].id : '';
    this.presetId = this.defaultPresetId();
    this.newWorkspace = false;
    this.sheetKind = SHEET_CREATE;
    this.sheetOpen = true;
  }

  /** 默认预设 = 第一个「标了默认且可用」的（源工程 `firstOrNull { it.isDefault && it.available }`）。 */
  private defaultPresetId(): string {
    const presets: AgentPreset[] = this.st().agentPresets;
    for (let i = 0; i < presets.length; i++) {
      if (presets[i].isDefault && presets[i].available) {
        return presets[i].id;
      }
    }
    return '';
  }

  private openWorkspaceSheet(): void {
    this.sheetKind = SHEET_WORKSPACES;
    this.sheetOpen = true;
  }

  private openRenameSession(session: ChatSession): void {
    this.renameIsWorkspace = false;
    this.renameTargetId = session.id;
    this.renameDraft = this.displayTitleOf(session);
    this.sheetKind = SHEET_RENAME;
    this.sheetOpen = true;
  }

  private openRenameWorkspace(workspace: ChatWorkspace): void {
    this.renameIsWorkspace = true;
    this.renameTargetId = workspace.id;
    this.renameDraft = workspace.title;
    this.sheetKind = SHEET_RENAME;
    this.sheetOpen = true;
  }

  private renameTitleRes(): ResourceStr {
    return this.renameIsWorkspace ? $r('app.string.rename_workspace') : $r('app.string.rename_session');
  }

  private onRenameConfirmed(): void {
    const vm: HarnessViewModel | null = this.vm();
    const draft: string = this.renameDraft;
    if (vm !== null && draft.trim().length > 0) {
      if (this.renameIsWorkspace) {
        void vm.renameWorkspace(this.renameTargetId, draft);
      } else {
        void vm.renameSession(this.renameTargetId, draft);
      }
    }
    this.closeSheet();
  }

  // ————————————————— 列表动作 —————————————————

  private select(id: string): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      void vm.selectSession(id);
    }
  }

  private backToList(): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      void vm.selectSession(null);
    }
  }

  private fork(id: string): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      void vm.forkSession(id);
    }
  }

  /**
   * 归档确认。用系统弹窗而不是自绘：它会自动套用系统主题与深浅色，
   * 且归档会让会话从列表里消失 —— 代价不可逆，不能点一下就生效。
   */
  private confirmArchive(session: ChatSession): void {
    this.getUIContext().showAlertDialog({
      title: this.fmt1($r('app.string.archive_session_title'), this.displayTitleOf(session)),
      message: this.resText($r('app.string.archive_session_warning')),
      primaryButton: {
        value: this.resText($r('app.string.archive_session')),
        action: (): void => {
          const vm: HarnessViewModel | null = this.vm();
          if (vm !== null) {
            void vm.archiveSession(session.id);
          }
        },
      },
      secondaryButton: {
        value: this.resText($r('app.string.close')),
        action: (): void => {
        },
      },
      cancel: (): void => {
      },
    });
  }

  private confirmDeleteWorkspace(workspace: ChatWorkspace): void {
    this.getUIContext().showAlertDialog({
      title: this.resText($r('app.string.remove_workspace_title')),
      message: this.fmt1($r('app.string.remove_workspace_warning'), workspace.title),
      primaryButton: {
        value: this.resText($r('app.string.remove_workspace')),
        action: (): void => {
          const vm: HarnessViewModel | null = this.vm();
          if (vm !== null) {
            void vm.deleteWorkspace(workspace.id);
          }
        },
      },
      secondaryButton: {
        value: this.resText($r('app.string.close')),
        action: (): void => {
        },
      },
      cancel: (): void => {
      },
    });
  }

  // ————————————————— 新建会话面板的数据 —————————————————

  private sessionCountText(): string {
    return this.fmt1($r('app.string.session_count'), this.st().sessions.length);
  }

  private workspaceMenuItems(): MenuElement[] {
    const out: MenuElement[] = [];
    const list: ChatWorkspace[] = this.st().chatWorkspaces;
    for (let i = 0; i < list.length; i++) {
      const workspace: ChatWorkspace = list[i];
      out.push({
        value: `${workspace.title}  /${workspace.path}`,
        action: (): void => {
          this.workspaceId = workspace.id;
        },
      });
    }
    return out;
  }

  private rootMenuItems(): MenuElement[] {
    const out: MenuElement[] = [];
    const roots = this.st().roots;
    for (let i = 0; i < roots.length; i++) {
      const root = roots[i];
      out.push({
        value: root.label,
        action: (): void => {
          this.selectRoot(root.id);
        },
      });
    }
    return out;
  }

  private presetMenuItems(): MenuElement[] {
    const out: MenuElement[] = [];
    out.push({
      value: this.resText($r('app.string.server_default')),
      action: (): void => {
        this.presetId = '';
      },
    });
    const presets: AgentPreset[] = this.st().agentPresets;
    for (let i = 0; i < presets.length; i++) {
      const preset: AgentPreset = presets[i];
      const description: string = preset.description ?? '';
      out.push({
        value: description.length > 0 ? `${preset.name} — ${description}` : preset.name,
        enabled: preset.available,
        action: (): void => {
          this.presetId = preset.id;
        },
      });
    }
    return out;
  }

  private selectedWorkspaceLabel(): ResourceStr {
    const list: ChatWorkspace[] = this.st().chatWorkspaces;
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === this.workspaceId) {
        return list[i].title;
      }
    }
    return $r('app.string.no_chat_workspaces');
  }

  private selectedRootLabel(): ResourceStr {
    const rootId: string | null = this.st().workspacePickerRootId;
    if (rootId !== null) {
      const roots = this.st().roots;
      for (let i = 0; i < roots.length; i++) {
        if (roots[i].id === rootId) {
          return roots[i].label;
        }
      }
    }
    return $r('app.string.no_roots');
  }

  private selectedPresetLabel(): ResourceStr {
    const presets: AgentPreset[] = this.st().agentPresets;
    for (let i = 0; i < presets.length; i++) {
      if (presets[i].id === this.presetId) {
        return presets[i].name;
      }
    }
    return $r('app.string.server_default');
  }

  private selectRoot(rootId: string): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      void vm.selectWorkspacePickerRoot(rootId);
    }
  }

  /** 目录浏览里只列目录（源工程 `filter { it.kind == "directory" }`）。 */
  private directoryEntries(): FileEntry[] {
    const page = this.st().workspacePickerDirectory;
    if (page === null) {
      return [];
    }
    const out: FileEntry[] = [];
    for (let i = 0; i < page.entries.length; i++) {
      if (page.entries[i].isDirectory()) {
        out.push(page.entries[i]);
      }
    }
    return out;
  }

  /** 上一层路径。对位 `substringBeforeLast('/', "")`：没有分隔符时返回空串。 */
  private parentPathOf(path: string): string {
    const index: number = path.lastIndexOf('/');
    return index < 0 ? '' : path.substring(0, index);
  }

  private goUp(): void {
    const path: string = this.st().workspacePickerPath;
    if (path.length === 0 || this.st().busy) {
      return;
    }
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      void vm.loadWorkspacePickerDirectory(this.parentPathOf(path));
    }
  }

  private enterDirectory(entry: FileEntry): void {
    if (this.st().busy) {
      return;
    }
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      void vm.loadWorkspacePickerDirectory(entry.path);
    }
  }

  private createButtonLabel(): ResourceStr {
    return this.newWorkspace ? $r('app.string.create_workspace_and_session') : $r('app.string.create_session');
  }

  private canCreate(): boolean {
    if (this.st().busy) {
      return false;
    }
    if (this.newWorkspace) {
      return this.st().workspacePickerRootId !== null && this.st().workspacePickerDirectory !== null;
    }
    return this.workspaceId.length > 0;
  }

  private onCreateConfirmed(): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm === null) {
      return;
    }
    const preset: string | null = this.presetId.length > 0 ? this.presetId : null;
    if (this.newWorkspace) {
      const rootId: string | null = this.st().workspacePickerRootId;
      if (rootId !== null) {
        void vm.createWorkspaceAndSession(rootId, this.st().workspacePickerPath, preset);
      }
    } else {
      void vm.createSession(this.workspaceId, preset);
    }
    this.closeSheet();
  }

  // ————————————————— 视图 —————————————————

  build() {
    Column() {
      if (this.wide) {
        Row() {
          Column() {
            this.sessionPane()
          }
          .width(304)
          .height('100%')

          Divider()
            .vertical(true)
            .strokeWidth(1)
            .color($r('sys.color.ohos_id_color_list_separator'))
            .height('100%')

          Column() {
            this.detailPane()
          }
          .layoutWeight(1)
          .height('100%')
        }
        .width('100%')
        .height('100%')
      } else if (this.selectedId() === null) {
        this.sessionPane()
      } else {
        this.detailPane()
      }
    }
    .width('100%')
    // 真机查出的一处**根因**：这里原来是 `.height('100%')`。
    // 本组件是外壳分节宿主，被排在 56vp 顶栏**之后**，而 `height('100%')` 取的是
    // 父级整高（2231px）——于是整体下移 174px、末 87px 溢出父容器，可见部分正好压进
    // 底部系统手势区：表现就是「输入框只剩一条缝、发送键看不见、还有白色手势条浮在上层」。
    // 换成 `layoutWeight(1)` 才是「占满剩余空间」的正确写法（会话详情根布局同样写的是
    // `height('100%')`，它靠这一级拿到确定高度后才是对的）。
    .layoutWeight(1)
    // 一个面板宿主（见文件头差异 1）。`isShow` 走单向：用户下拉关掉时靠 `onDisappear` 复位标志，
    // 否则标志会留在 true，下一次再设 true 就不再触发。
    .bindSheet(this.sheetOpen, this.sheetContent(), {
      height: this.sheetHeight(),
      dragBar: true,
      onDisappear: (): void => {
        this.sheetOpen = false;
      },
    })
  }

  @Builder
  sheetContent() {
    Column() {
      if (this.sheetKind === SHEET_CREATE) {
        this.createSheetBody()
      } else if (this.sheetKind === SHEET_WORKSPACES) {
        this.workspaceSheetBody()
      } else {
        this.renameSheetBody()
      }
    }
    .width('100%')
    .height('100%')
    .padding({ left: 18, right: 18, top: 8, bottom: 16 })
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
  }

  @Builder
  sessionPane() {
    Column() {
      Row() {
        Column() {
          Text($r('app.string.chat'))
            .fontSize(22)
            .fontWeight(FontWeight.Medium)
          Text(this.sessionCountText())
            .fontSize(12)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ top: 3 })
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)

        if (this.canWriteChat()) {
          Text('📁')
            .fontSize(18)
            .padding(10)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .opacity(this.st().busy ? 0.4 : 1)
            .onClick((): void => {
              if (!this.st().busy) {
                this.openWorkspaceSheet();
              }
            })
          Text('＋')
            .fontSize(20)
            .width(44)
            .height(44)
            .textAlign(TextAlign.Center)
            .borderRadius(22)
            .backgroundColor($r('sys.color.ohos_id_color_emphasize'))
            .fontColor($r('sys.color.ohos_id_color_foreground_contrary'))
            .opacity(this.st().busy ? 0.4 : 1)
            .onClick((): void => {
              if (!this.st().busy) {
                this.openCreateSheet();
              }
            })
        }
      }
      .width('100%')
      .padding({ top: 16, bottom: 10 })
      .alignItems(VerticalAlign.Bottom)

      if (this.st().sessions.length === 0) {
        this.emptyState('💬', $r('app.string.no_sessions'))
      } else {
        List() {
          ForEach(this.st().sessions, (session: ChatSession) => {
            ListItem() {
              Column() {
                SessionRow({
                  session: session,
                  selected: this.selectedId() === session.id,
                  rowEnabled: !this.st().busy,
                  onSelect: (id: string): void => {
                    this.select(id);
                  },
                  onRename: (target: ChatSession): void => {
                    this.openRenameSession(target);
                  },
                  onFork: (id: string): void => {
                    this.fork(id);
                  },
                  onArchive: (target: ChatSession): void => {
                    this.confirmArchive(target);
                  },
                })
                Divider()
                  .strokeWidth(1)
                  .color($r('sys.color.ohos_id_color_list_separator'))
              }
              .width('100%')
            }
          }, (session: ChatSession) => session.id)
        }
        .layoutWeight(1)
        .width('100%')
        .scrollBar(BarState.Off)
      }
    }
    .width('100%')
    .height('100%')
    .padding({ left: 14, right: 14 })
  }

  /**
   * 右栏：聊天详情页。
   *
   * 整页交给 `ChatDetail`（它自带 `ConversationHeader`）。这里刻意**不留**任何头部行 ——
   * 源工程 `ChatScreen` 也是把详情页整块交给 `ChatDetail`，头部（含返回键、标题、
   * 四个入口）是详情页自己的事；在这里再叠一层标题就会出现「两个标题 + 两个返回键」。
   */
  @Builder
  detailPane() {
    ChatDetail({
      wide: this.wide,
      onBack: (): void => {
        this.backToList();
      },
    })
  }

  @Builder
  emptyState(glyph: string, message: ResourceStr) {
    Column() {
      Text(glyph).fontSize(30)
      Text(message)
        .fontSize(13)
        .margin({ top: 8 })
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .textAlign(TextAlign.Center)
    }
    .width('100%')
    .layoutWeight(1)
    .justifyContent(FlexAlign.Center)
  }

  @Builder
  pickerHeading(title: ResourceStr) {
    Text(title)
      .fontSize(12)
      .fontColor($r('sys.color.ohos_id_color_text_secondary'))
      .width('100%')
      .margin({ top: 14, bottom: 5 })
  }

  /** 分段按钮（互斥二选一）。选中的用强调色描边，未选中的用次级背景。 */
  @Builder
  segment(label: ResourceStr, active: boolean, onPick: () => void) {
    Text(label)
      .fontSize(13)
      .layoutWeight(1)
      .height(36)
      .textAlign(TextAlign.Center)
      .borderRadius(8)
      .backgroundColor(active
        ? $r('sys.color.ohos_id_color_emphasize')
        : $r('sys.color.ohos_id_color_component_normal'))
      .fontColor(active
        ? $r('sys.color.ohos_id_color_foreground_contrary')
        : $r('sys.color.ohos_id_color_text_primary'))
      .onClick(onPick)
  }

  @Builder
  createSheetBody() {
    Column() {
      Text($r('app.string.new_session'))
        .fontSize(20)
        .fontWeight(FontWeight.Medium)

      Row() {
        this.segment($r('app.string.existing_workspace'), !this.newWorkspace, (): void => {
          this.newWorkspace = false;
        })
        this.segment($r('app.string.new_workspace'), this.newWorkspace, (): void => {
          this.newWorkspace = true;
          const vm: HarnessViewModel | null = this.vm();
          if (vm !== null && this.st().workspacePickerDirectory === null) {
            void vm.prepareWorkspacePicker();
          }
        })
      }
      .width('100%')
      .margin({ top: 12 })

      Scroll() {
        Column() {
          if (!this.newWorkspace) {
            this.pickerHeading($r('app.string.dhs_workspace'))
            Button() {
              Row() {
                Text('📁').fontSize(14)
                Text(this.selectedWorkspaceLabel())
                  .fontSize(14)
                  .layoutWeight(1)
                  .textAlign(TextAlign.Start)
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                  .margin({ left: 8 })
                Text('⌄').fontSize(13)
              }
              .width('100%')
            }
            .type(ButtonType.Normal)
            .width('100%')
            .borderRadius(8)
            .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
            .enabled(this.st().chatWorkspaces.length > 0)
            .bindMenu(this.workspaceMenuItems())
          } else {
            this.pickerHeading($r('app.string.authorized_root'))
            Button() {
              Row() {
                Text('📁').fontSize(14)
                Text(this.selectedRootLabel())
                  .fontSize(14)
                  .layoutWeight(1)
                  .textAlign(TextAlign.Start)
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                  .margin({ left: 8 })
                Text('⌄').fontSize(13)
              }
              .width('100%')
            }
            .type(ButtonType.Normal)
            .width('100%')
            .borderRadius(8)
            .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
            .enabled(this.st().roots.length > 0)
            .bindMenu(this.rootMenuItems())

            this.pickerHeading($r('app.string.workspace_directory'))
            Row() {
              Text('↑')
                .fontSize(15)
                .padding(10)
                .fontColor(this.st().workspacePickerPath.length === 0
                  ? $r('sys.color.ohos_id_color_text_secondary')
                  : $r('sys.color.ohos_id_color_text_primary_activated'))
                .opacity(this.st().busy ? 0.4 : 1)
                .onClick((): void => {
                  this.goUp();
                })
              Text(`/${this.st().workspacePickerPath}`)
                .fontSize(11)
                .layoutWeight(1)
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis })
                .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            }
            .width('100%')
            .borderRadius(8)
            .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
            .alignItems(VerticalAlign.Center)

            if (this.directoryEntries().length === 0) {
              Text($r('app.string.no_subdirectories'))
                .fontSize(11)
                .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                .width('100%')
                .padding({ top: 12, bottom: 12 })
            } else {
              List() {
                ForEach(this.directoryEntries(), (entry: FileEntry) => {
                  ListItem() {
                    Row() {
                      Text('📁')
                        .fontSize(15)
                        .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
                      Text(entry.name)
                        .fontSize(14)
                        .layoutWeight(1)
                        .maxLines(1)
                        .textOverflow({ overflow: TextOverflow.Ellipsis })
                        .margin({ left: 10 })
                      Text('›')
                        .fontSize(14)
                        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                    }
                    .width('100%')
                    .padding({ left: 6, right: 6, top: 7, bottom: 7 })
                    .alignItems(VerticalAlign.Center)
                    .onClick((): void => {
                      this.enterDirectory(entry);
                    })
                  }
                }, (entry: FileEntry) => entry.path)
              }
              .width('100%')
              .height(96)
              .scrollBar(BarState.Off)
            }
          }

          if (this.st().agentPresets.length > 0) {
            this.pickerHeading($r('app.string.agent_mode'))
            Button() {
              Row() {
                Text('🛠').fontSize(14)
                Text(this.selectedPresetLabel())
                  .fontSize(14)
                  .layoutWeight(1)
                  .textAlign(TextAlign.Start)
                  .maxLines(1)
                  .textOverflow({ overflow: TextOverflow.Ellipsis })
                  .margin({ left: 8 })
                Text('⌄').fontSize(13)
              }
              .width('100%')
            }
            .type(ButtonType.Normal)
            .width('100%')
            .borderRadius(8)
            .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
            .bindMenu(this.presetMenuItems())
          }
        }
        .width('100%')
      }
      .layoutWeight(1)
      .width('100%')
      .align(Alignment.Top)

      Button(this.createButtonLabel())
        .type(ButtonType.Capsule)
        .width('100%')
        .height(48)
        .margin({ top: 12 })
        .enabled(this.canCreate())
        .onClick((): void => {
          this.onCreateConfirmed();
        })
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  workspaceSheetBody() {
    Column() {
      Text($r('app.string.manage_workspaces'))
        .fontSize(20)
        .fontWeight(FontWeight.Medium)
      Text($r('app.string.manage_workspaces_subtitle'))
        .fontSize(12)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .margin({ top: 4, bottom: 10 })

      if (this.st().chatWorkspaces.length === 0) {
        this.emptyState('📁', $r('app.string.no_chat_workspaces'))
      } else {
        List() {
          ForEach(this.st().chatWorkspaces, (workspace: ChatWorkspace) => {
            ListItem() {
              Column() {
                Row() {
                  Text('📁')
                    .fontSize(16)
                    .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
                  Column() {
                    Text(workspace.title)
                      .fontSize(14)
                      .maxLines(1)
                      .textOverflow({ overflow: TextOverflow.Ellipsis })
                      .width('100%')
                    Text(`/${workspace.path}`)
                      .fontSize(11)
                      .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                      .maxLines(1)
                      .textOverflow({ overflow: TextOverflow.Ellipsis })
                      .width('100%')
                  }
                  .layoutWeight(1)
                  .alignItems(HorizontalAlign.Start)
                  .margin({ left: 12, right: 8 })

                  Text('✎')
                    .fontSize(16)
                    .padding(8)
                    .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                    .opacity(this.st().busy ? 0.4 : 1)
                    .onClick((): void => {
                      if (!this.st().busy) {
                        this.openRenameWorkspace(workspace);
                      }
                    })
                  Text('🗑')
                    .fontSize(16)
                    .padding(8)
                    .fontColor($r('sys.color.ohos_id_color_alert'))
                    .opacity(this.st().busy ? 0.4 : 1)
                    .onClick((): void => {
                      if (!this.st().busy) {
                        this.confirmDeleteWorkspace(workspace);
                      }
                    })
                }
                .width('100%')
                .padding({ top: 8, bottom: 8 })
                .alignItems(VerticalAlign.Center)
                Divider()
                  .strokeWidth(1)
                  .color($r('sys.color.ohos_id_color_list_separator'))
              }
              .width('100%')
            }
          }, (workspace: ChatWorkspace) => workspace.id)
        }
        .layoutWeight(1)
        .width('100%')
        .scrollBar(BarState.Off)
      }
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  renameSheetBody() {
    Column() {
      Text(this.renameTitleRes())
        .fontSize(18)
        .fontWeight(FontWeight.Medium)
      Text($r('app.string.name'))
        .fontSize(11)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .margin({ top: 16 })
      TextInput({ text: this.renameDraft })
        .width('100%')
        .margin({ top: 6 })
        .onChange((value: string): void => {
          this.renameDraft = value;
        })

      Row() {
        Button($r('app.string.cancel'))
          .type(ButtonType.Capsule)
          .layoutWeight(1)
          .height(44)
          .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .onClick((): void => {
            this.closeSheet();
          })
        Button($r('app.string.confirm'))
          .type(ButtonType.Capsule)
          .layoutWeight(1)
          .height(44)
          .margin({ left: 10 })
          .enabled(this.renameDraft.trim().length > 0)
          .onClick((): void => {
            this.onRenameConfirmed();
          })
      }
      .width('100%')
      .margin({ top: 18 })
    }
    .width('100%')
    .padding({ top: 8 })
  }
}
