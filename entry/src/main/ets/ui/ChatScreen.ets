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
import { AgentPreset, ChatSession, ChatWorkspace } from '../core/Models';
import { HarnessState, HarnessViewModel } from '../core/HarnessViewModel';
import { harnessState, harnessVm } from './AppRuntime';
import { ChatDetail } from './ChatDetail';
import { SessionRow } from './SessionRow';
import { SHEET_CREATE, SHEET_RENAME, SHEET_WORKSPACES, SessionSheetBodies } from './SessionSheets';

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

  // ————————————————— 新建会话面板的数据 —————————————————

  private sessionCountText(): string {
    return this.fmt1($r('app.string.session_count'), this.st().sessions.length);
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
    SessionSheetBodies({
      kind: this.sheetKind,
      newWorkspace: $newWorkspace,
      workspaceId: $workspaceId,
      presetId: $presetId,
      renameIsWorkspace: this.renameIsWorkspace,
      renameTargetId: this.renameTargetId,
      renameDraft: $renameDraft,
      onClose: (): void => {
        this.closeSheet();
      },
      onRenameWorkspace: (workspace: ChatWorkspace): void => {
        this.openRenameWorkspace(workspace);
      },
    })
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

}

