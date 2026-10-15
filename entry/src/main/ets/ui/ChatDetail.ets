/**
 * 聊天详情页 —— **装配层**。移植自原工程 `ui/ChatScreen.kt` 的 `ChatDetail`：
 *
 * | 源工程 | 本文件 / 承载文件 |
 * |---|---|
 * | `ChatDetail`（417–736） | `ChatDetail`（装配层，本文件） |
 * | `ConversationHeader`（738–877） | `ui/ChatHeader.ets` 的 `ChatHeaderPanelHost.header` |
 * | 三个面板宿主（会话文件 / 会话配置 / 完整访问确认） | `ui/ChatHeader.ets` 的 `sheetContent` |
 * | `ApprovalStatusLabel` / `ApprovalLoading`（1286–1317） | `ChatDetail.approvalArea` |
 * | `ApprovalPanel`（1319–1442） | `ui/ChatDetailPanels.ets` 的 `ApprovalPanel` |
 * | `QuestionCard`（1493–1643） | `ui/ChatDetailPanels.ets` 的 `QuestionCard` |
 * | `Composer`（1645–1866） | `ui/ChatComposer.ets` 的 `ChatComposer.composer` |
 * | `MentionSuggestions`（2139–2255） | `ui/ComposerSuggestions.ets` 的 `MentionSuggestions` |
 * | `commandSuggestions`（2264–2274） | `core/ComposerSuggestions.ts` 的 `commandSuggestions` |
 * | `CommandSuggestions`（2276–2326） | `ui/ComposerSuggestions.ets` 的 `CommandSuggestions` |
 * | `ChatThinkBar`（1897–1928） | `ChatDetail.thinkBar` |
 * | `TodoPanel`（2045–2125） | `ChatDetail.todoPanel` |
 *
 * ## 拆分说明（切在哪、为什么）
 *
 * 本文件原是一个 1900+ 行的单文件。按「内聚」切，不按行数对齐硬切，得到四块：
 *
 * 1. `ui/ChatDetailPanels.ets` —— **叶子零件**（`QuestionCard` / `ApprovalPanel` /
 *    `AttachmentThumb`）。它们只吃入参、只吐回调，不拖 `ChatDetail` 的任何状态，能整体搬走。
 * 2. `ui/ChatHeader.ets`（`ChatHeaderPanelHost`）—— **头部 + 三个面板宿主**。头部是
 *    「会话文件 / 会话配置」两个面板唯一的入口（`📂` 与 `⋯`），而「完整访问确认」面板的
 *    开关状态又与头部菜单里的权限档位共用一套判据；头部与面板宿主同住一处，
 *    `openSheet` / `closeSheet` / `sheetContent` / `sheetHeight` 就不必跨组件回调。
 * 3. `ui/ChatComposer.ets`（`ChatComposer`）—— **输入药丸 + 补全面板**。附件、提交、
 *    `@`/`/` 提示自成一块，也是本页唯一会写回 `message` 的地方。
 * 4. 本文件保留：待办面板、消息流、「跳到最新」、问答区、思考条、审批区（四态分派与两次
 *    确认的**发起**），以及把 2 / 3 两个子组件装配起来的 `build()`。
 *
 * ## 状态归属（拆分的硬约束）
 *
 * **唯一数据源一律留在本文件（父组件）**：`message`、`sheetOpen` / `sheetKind` /
 * `fullAccessApprovalId` / `fullAccessAck`。子组件用 `@Link` 双向绑定「两边都会写」的那几个
 * （输入框 `onChange` 写 `message`；审批区走二次确认、头部菜单切权限档位都要写 sheet 那几份），
 * 只读入参用 `@Prop`，函数 / 回调用普通成员。子组件**不再各自复制一份 `@State`** ——
 * 双数据源会让两边打架。
 *
 * `message` 经 `@Link` 被 `ChatComposer` 写回时，本组件的 `@Watch('onMessageChanged')`
 * **不保证**会被触发；所以 `ChatComposer` 的 `onChange` 会显式回调一次 `onMessageEdited()`
 * （内部即 `syncComposerOverlay()`），理由写在 `ui/ChatComposer.ets` 的文件头。
 *
 * ## 六处平台差异（都不是取舍口味，是 ArkUI 侧做不到或做法不同）
 *
 * 1. **三个面板合成一个 `bindSheet` 宿主**，靠 `sheetKind` 分发（会话文件 / 会话配置 /
 *    完整访问确认）。与 `ChatScreen.ets` 同一套做法，理由也一样：ArkUI 的 `bindSheet`
 *    在一个组件上挂多个面板时行为与版本相关，一个宿主只有一个显隐来源，不会互相打架。
 * 2. **全访问二次确认从 `AlertDialog` 换成底部面板**。源工程那个对话框里有一个「我已了解」
 *    勾选框，而 ArkUI 的系统 `showAlertDialog` 只有标题 + 正文 + 两个按钮，装不下勾选框；
 *    用 `CustomDialog` 则要把勾选状态在两个组件之间来回搬。做成面板后，勾选框的禁用逻辑
 *    （未勾选则确认键不可用）一字不改地保留下来。
 * 3. **`⋯` 菜单用 `MenuElement[]` 数据形式，权限档位被压平进同一个菜单**。源工程是
 *    `DropdownMenu` 里嵌一段 `PermissionMenuItems`（带分隔线的小标题 + 每个档位一行），
 *    ArkUI 的数据形式菜单没有子菜单与尾随勾选图标，所以这里把「当前权限模式」并进一行
 *    只读文字，并在当前档位前面加 `✓`。**语义没变**：档位顺序、`custom` 不显示、
 *    `danger-full-access` 走二次确认，三条都照抄。
 * 4. **自动滚底的判据自己算条目数**。源工程用 `listState.layoutInfo.totalItemsCount`（框架
 *    给的权威值）；ArkUI 的 `List` 没有等价属性，只有 `onScrollIndex` 的起止下标。所以
 *    这里用 `listItemCount()` 把「加载更早消息 / 空态 / 消息」三类条目算出来，
 *    **改动列表结构时必须同步改它**（少算一项就会在「看着到底了」的位置把用户拽回底部）。
 * 5. **图片缩略图先解码**（`platform/ImageCodec.ets`）：ArkUI 的 `Image()` 只认 `PixelMap`。
 * 6. **「补全面板开着就关掉抽屉手势」那半截在本工程无对应 API**。源工程把 `@`/`/` 面板开着
 *    这个事实告诉外层（`state.composerOverlay`），让 `ModalNavigationDrawer` 停止响应横划
 *    （`gesturesEnabled = !composerOverlay …`）；ArkUI 的 `SideBarContainer` 没有等价的
 *    「禁用手势」属性。所以 `setComposerOverlay` 记下的状态在本工程只作记录 —— 面板内部的
 *    可滚动 `List` 已经把大部分误触挡掉（那正是源工程加这道保险的起因）。
 *
 * ## 五条照抄源工程、不许简化的判据
 *
 * 1. **标题链用完整 id**：`title ?? workspaceTitle ?? (cwd 非空取 cwd，否则取 id)`——
 *    **不是**列表行的 `id.take(12)`。两处规则不同，是因为列表行宽度有限、详情页标题可以省略号截断。
 * 2. **审批只顶掉输入区，问答不顶**。审批是内核阻塞着等决定（用户此刻没别的事可做）；
 *    问题是 Agent 已经继续跑之后的补答，拿走输入框会让用户连话都发不出去。
 * 3. **审批四态分派的顺序与文案**：`NONE→Composer`、`LOADING→转圈`、
 *    `PENDING→第一条（可点）`、`DECIDING→当前那条（两个按钮都禁用）`。
 * 4. **`canSteer` 三条同时成立**：审批态为 `NONE`、有 `chat.write`、
 *    且「可提交内容或待发附件非空」。插话是**固定的 steer 提交**，不受设置里的默认行为影响。
 * 5. **默认发送模式来自 `resolveSendMode(sessionRunning, busySendMode)`**，占位符文案由
 *    `composerHint` 三态决定 —— 这两条抽成纯函数并有单测，界面只负责显示。
 */

import {
  AgentPreset, ChatHistory, ChatQuestion, ChatSession, ModelSelection, PendingApproval,
  PendingQuestionSet, PermissionOption, PermissionSelect, QuestionAnswer, QuestionOption, TodoItem,
} from '../core/Models';
import {
  ApprovalUiKind, HarnessState, HarnessViewModel, PendingAttachment,
} from '../core/HarnessViewModel';
import {
  ChatDisplayItem, ChatItemKind, LiveChatState, displayItemsOf, permissionSelectOf, todoItemsOf,
} from '../core/ChatPresentation';
import { liveThinkingText, thinkBarText } from '../core/ChatThinkBar';
import { composerOverlayActive } from '../core/ComposerSuggestions';
import { harnessState, harnessVm } from './AppRuntime';
import { ChatMessageView } from './ChatMessage';
import { ApprovalPanel, QuestionCard } from './ChatDetailPanels';
import { ChatHeaderPanelHost, SHEET_FILES, SHEET_FULL_ACCESS } from './ChatHeader';
import { ChatComposer } from './ChatComposer';

/** 待回答问题区的高度上限：对位源工程 `heightIn(max = 340.dp)`。 */
const QUESTION_PANEL_MAX_HEIGHT_VP: number = 340;

/** 聊天详情页（装配层）：头部面板宿主 + 待办 + 消息流 + 问答 + 思考条 + 审批 / 输入区。 */
@Component
export struct ChatDetail {
  /** 窄屏时显示返回键（宽屏详情常驻，没有「返回列表」这回事）。 */
  wide: boolean = false;
  onBack: () => void = (): void => {};

  /** 订阅 vm 的 revision：任何 `update()` 都会让本组件重新 build。 */
  @StorageLink('dshRevision') @Watch('onRevision') revision: number = 0;

  // ——— 输入区 ———
  /**
   * 输入框原文。存在这里而不是 ViewModel 里（源工程也是本地 state）：
   * 发送失败时 ViewModel 会把原文写回 `pendingText`，由 `onRevision` 回填（见 `onRevision`）。
   */
  @State @Watch('onMessageChanged') message: string = '';
  /** 是否已经贴在列表底部附近：只有贴底才自动跟随，否则不打扰翻历史的人。 */
  @State atBottom: boolean = true;
  /** 待办面板是否展开（源工程 `tasksExpanded`，默认展开）。 */
  @State tasksExpanded: boolean = true;

  // ——— 面板宿主 ———
  @State sheetOpen: boolean = false;
  @State sheetKind: number = SHEET_FILES;
  /**
   * 正在等二次确认的那条审批 id；**空串**表示「这次确认的是权限档位切换」而不是审批。
   * 两种请求共用同一个面板，因为它们要问的是同一件事（要不要给出完整访问），
   * 勾选要求也一字不差。
   */
  @State fullAccessApprovalId: string = '';
  @State fullAccessAck: boolean = false;

  /** 消息列表的滚动控制器（自动跟随与「跳到最新」都要它）。 */
  private scroller: Scroller = new Scroller();
  /** vm 还没装配时的兜底状态，避免 getter 里到处判空。 */
  private fallback: HarnessState = new HarnessState();

  /**
   * 页面离开时把 vm 里的「补全面板开着」清掉。
   *
   * 面板随页面离开自然消失，但状态留在 vm 里会让外层抽屉的手势一直失效 ——
   * 那比误触更难发现（用户只会觉得「抽屉划不开了」）。源工程用 `DisposableEffect`
   * 的 `onDispose` 做同一件事。
   */
  aboutToDisappear(): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      vm.setComposerOverlay(false);
    }
  }

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

  // ————————————————— 消息流 —————————————————

  /**
   * 历史 + 流式两段合并后的显示条目。
   *
   * 三层过滤照抄源工程：① 历史里的 REASONING 不显示（翻历史的人不读思考）；
   * ② 历史里的 CONTEXT 默认隐藏（`showContext` 开关在设置页）；
   * ③ **流式段同样过滤 REASONING** —— 那一段改由底部思考条承载。
   */
  private displayItems(): ChatDisplayItem[] {
    const history: ChatHistory | null = this.st().history;
    const showContext: boolean = this.st().showContext;
    const out: ChatDisplayItem[] = [];
    if (history !== null) {
      const historyItems: ChatDisplayItem[] = displayItemsOf(history);
      for (let i = 0; i < historyItems.length; i++) {
        const item: ChatDisplayItem = historyItems[i];
        if (item.kind === ChatItemKind.REASONING) {
          continue;
        }
        if (!showContext && item.kind === ChatItemKind.CONTEXT) {
          continue;
        }
        out.push(item);
      }
    }
    const live: ChatDisplayItem[] = this.liveItems();
    for (let i = 0; i < live.length; i++) {
      out.push(live[i]);
    }
    return out;
  }

  /** 当前会话的流式段（不属于本会话的实时状态一律不认）。 */
  private liveChat(): LiveChatState | null {
    const live: LiveChatState | null = this.st().liveChat;
    const id: string | null = this.selectedId();
    if (live === null || id === null || live.sessionId !== id) {
      return null;
    }
    return live;
  }

  private liveItems(): ChatDisplayItem[] {
    const live: LiveChatState | null = this.liveChat();
    if (live === null) {
      return [];
    }
    const items: ChatDisplayItem[] = live.displayItems();
    const out: ChatDisplayItem[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind !== ChatItemKind.REASONING) {
        out.push(items[i]);
      }
    }
    return out;
  }

  /** 思考条只承载**流式这一段**：翻历史时 `liveChat` 为 null，这一条自然整条不显示。 */
  private thinkText(): string {
    const live: LiveChatState | null = this.liveChat();
    return live === null ? '' : thinkBarText(liveThinkingText(live.blocks));
  }

  private todos(): TodoItem[] {
    const history: ChatHistory | null = this.st().history;
    return history === null ? [] : todoItemsOf(history);
  }

  private hasMore(): boolean {
    const history: ChatHistory | null = this.st().history;
    return history !== null && history.hasMore;
  }

  /**
   * 列表里**实际条目数**。
   *
   * ArkUI 没有 `layoutInfo.totalItemsCount`，所以这个数只能自己算 —— 它同时是
   * 「是否贴底」与「跳到最新」的判据。**改动列表结构时必须同步改它**（见文件头差异 4）。
   */
  private listItemCount(): number {
    let count: number = this.displayItems().length;
    if (this.hasMore()) {
      count += 1;
    }
    if (this.st().history !== null && this.displayItems().length === 0) {
      count += 1;
    }
    return count;
  }

  private loadOlder(): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      void vm.loadOlderHistory();
    }
  }

  private loadAttachmentImage(id: string): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      void vm.loadAttachmentImage(id);
    }
  }

  /** 卡片里的选择按钮等价于用户打了一行字再发送：走同一条 send 通道（源工程注释）。 */
  private answerFromCard(text: string): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      void vm.sendMessage(text, false);
    }
  }

  private scrollToBottom(): void {
    this.atBottom = true;
    this.scroller.scrollEdge(Edge.Bottom);
  }

  /**
   * 每次 vm 变更都过一遍：① 回填发送失败的原文；② 贴底时自动跟随。
   *
   * 自动跟随用 `setTimeout(…, 0)` 而不是当场滚：revision 变化的这一刻新条目还没完成布局，
   * 当场滚会停在倒数第二条上。延到下一轮事件循环才滚得准。
   */
  private onRevision(): void {
    const pending: string = this.st().pendingText;
    if (pending.trim().length > 0 && pending !== this.message) {
      this.message = pending;
    }
    if (this.atBottom && this.displayItems().length > 0) {
      setTimeout((): void => {
        this.scroller.scrollEdge(Edge.Bottom);
      }, 0);
    }
    // 命令清单可能在这次刷新里变了（`@` 补全面板的可见性也依赖它），顺手同步一次。
    this.syncComposerOverlay();
  }

  // ————————————————— 输入补全面板 —————————————————

  /**
   * 输入框内容变化时：把「补全面板是否开着」同步给 vm。
   *
   * 对位源工程 `LaunchedEffect(composerOverlayActive) { viewModel.setComposerOverlay(...) }` ——
   * ArkUI 没有 LaunchedEffect，用 `@State` 的 `@Watch` 承担「值变了就通知」这件事。
   */
  private onMessageChanged(): void {
    this.syncComposerOverlay();
  }

  /**
   * 同步判据见 `core/ComposerSuggestions.ts`：`@` 提及活跃、或 `/` 有候选，都算面板开着。
   * vm 侧做幂等（值不变不写 state），所以这里每次重绘调一次不会推多余的快照。
   */
  private syncComposerOverlay(): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm === null) {
      return;
    }
    vm.setComposerOverlay(composerOverlayActive(this.message, this.st().commands));
  }

  // ————————————————— 待办 —————————————————

  /**
   * 「当前任务」面板。位置是**头部之下、消息列表之上**（源工程如此，不是浮动层）。
   *
   * 展开区里每种状态一组：`completed` → ✓ + 已完成、`in_progress` → ✎ + 进行中、
   * 其余 → ○ + 待处理；`completed` 的文字降到次级色（做完的事不该跟待办抢注意力）。
   */
  @Builder
  todoPanel() {
    Column() {
      Row() {
        Text('✓')
          .fontSize(15)
          .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
        Text($r('app.string.current_tasks'))
          .fontSize(14)
          .fontWeight(FontWeight.Medium)
          .layoutWeight(1)
          .margin({ left: 9 })
        Text($r('app.string.task_progress', this.completedCount(), this.todos().length))
          .fontSize(12)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        Text(this.tasksExpanded ? '⌃' : '⌄')
          .fontSize(14)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .margin({ left: 8 })
      }
      .width('100%')
      .constraintSize({ minHeight: 48 })
      .padding({ left: 14, right: 14, top: 7, bottom: 7 })
      .alignItems(VerticalAlign.Center)
      .onClick((): void => {
        this.tasksExpanded = !this.tasksExpanded;
      })

      if (this.tasksExpanded) {
        Divider()
          .strokeWidth(1)
          .color($r('sys.color.ohos_id_color_list_separator'))
        ForEach(this.todos(), (todo: TodoItem) => {
          Row() {
            Text(this.todoGlyph(todo))
              .fontSize(14)
              .fontColor(this.todoColor(todo))
              .margin({ top: 2 })
            Text(todo.content)
              .fontSize(14)
              .layoutWeight(1)
              .margin({ left: 9 })
              .fontColor(todo.status === 'completed'
                ? $r('sys.color.ohos_id_color_text_secondary')
                : $r('sys.color.ohos_id_color_text_primary'))
          }
          .width('100%')
          .constraintSize({ minHeight: 42 })
          .padding({ left: 14, right: 14, top: 7, bottom: 7 })
          .alignItems(VerticalAlign.Top)
        }, (todo: TodoItem, index: number) => `${index}:${todo.status}:${todo.content}`)
      }
    }
    .width('100%')
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
    .alignItems(HorizontalAlign.Start)
  }

  private completedCount(): number {
    const list: TodoItem[] = this.todos();
    let count: number = 0;
    for (let i = 0; i < list.length; i++) {
      if (list[i].status === 'completed') {
        count += 1;
      }
    }
    return count;
  }

  private todoGlyph(todo: TodoItem): string {
    if (todo.status === 'completed') {
      return '✓';
    }
    if (todo.status === 'in_progress') {
      return '✎';
    }
    return '○';
  }

  private todoColor(todo: TodoItem): ResourceStr {
    if (todo.status === 'completed') {
      return $r('sys.color.ohos_id_color_text_primary_activated');
    }
    if (todo.status === 'in_progress') {
      return $r('sys.color.ohos_id_color_emphasize');
    }
    return $r('sys.color.ohos_id_color_text_secondary');
  }

  // ————————————————— 消息列表 —————————————————

  @Builder
  messageList() {
    // 注意：`@Builder` 里不能有任何局部变量声明，所以下面的「是否有空态」等判断
    // 全部走私有方法，不在这里临时算。
    List({ scroller: this.scroller }) {
      if (this.hasMore()) {
        ListItem() {
          Text($r('app.string.older_messages'))
            .fontSize(13)
            .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
            .width('100%')
            .textAlign(TextAlign.Center)
            .padding({ top: 10, bottom: 10 })
            .onClick((): void => {
              this.loadOlder();
            })
        }
      }
      if (this.st().history !== null && this.displayItems().length === 0) {
        ListItem() {
          Column() {
            Text('💬').fontSize(28)
            Text($r('app.string.no_readable_messages'))
              .fontSize(13)
              .fontColor($r('sys.color.ohos_id_color_text_secondary'))
              .margin({ top: 8 })
          }
          .width('100%')
          .padding({ top: 32, bottom: 32 })
          .justifyContent(FlexAlign.Center)
        }
      }
      ForEach(this.displayItems(), (item: ChatDisplayItem) => {
        ListItem() {
          // `List` 没有 `space`（源工程 `Arrangement.spacedBy(5.dp)` 的对位），
          // 所以间距改由条目自身的下外边距给。
          Column() {
            ChatMessageView({
              item: item,
              images: this.st().attachmentImages,
              failures: this.st().attachmentFailures,
              genUiDebug: this.st().genUiDebug,
              onLoadImage: (id: string): void => {
                this.loadAttachmentImage(id);
              },
              onAnswer: (text: string): void => {
                this.answerFromCard(text);
              },
            })
          }
          .width('100%')
          .margin({ bottom: 5 })
        }
      }, (item: ChatDisplayItem) => item.id)
    }
    .width('100%')
    .height('100%')
    .padding({ left: 12, right: 12, top: 9, bottom: 9 })
    .scrollBar(BarState.Off)
    .onScrollIndex((_start: number, end: number): void => {
      const bottom: boolean = end >= this.listItemCount() - 3;
      if (bottom !== this.atBottom) {
        this.atBottom = bottom;
      }
    })
  }

  /** 浮动「跳到最新」：不在底部时才出现，点击滚到**会话尾部**。 */
  @Builder
  jumpButton() {
    Text('↓')
      .fontSize(18)
      .width(44)
      .height(44)
      .textAlign(TextAlign.Center)
      .borderRadius(22)
      .backgroundColor($r('sys.color.ohos_id_color_emphasize'))
      .fontColor($r('sys.color.ohos_id_color_foreground_contrary'))
      .margin({ right: 16, bottom: 16 })
      .onClick((): void => {
        this.scrollToBottom();
      })
  }

  // ————————————————— 问答 / 思考条 / 审批 —————————————————

  private answerQuestions(callId: string, answers: QuestionAnswer[]): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      void vm.answerQuestions(callId, answers);
    }
  }

  /**
   * 待回答问题区：高度上限 340vp、内部可滚。
   *
   * **不顶掉输入区**（见文件头判据 2）：它排在消息列表之后、思考条与输入区之前。
   */
  @Builder
  questionsPanel() {
    Scroll() {
      Column() {
        ForEach(this.st().questions, (set: PendingQuestionSet) => {
          QuestionCard({
            questionSet: set,
            answered: this.st().answeredCallIds.has(set.callId),
            submitting: this.st().answeringCallId === set.callId,
            canWrite: this.canWrite(),
            onSubmit: (answers: QuestionAnswer[]): void => {
              this.answerQuestions(set.callId, answers);
            },
          })
        }, (set: PendingQuestionSet) => set.callId)
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
    .scrollable(ScrollDirection.Vertical)
    .width('100%')
    .constraintSize({ maxHeight: QUESTION_PANEL_MAX_HEIGHT_VP })
    .padding({ left: 8, right: 8, top: 4, bottom: 4 })
    .scrollBar(BarState.Off)
  }

  /**
   * 思考条：消息区**下方**、输入区**上方**的固定位置（网页版 `#thinkbar` 的位置）。
   *
   * 没有思考时**整条不渲染** —— 不用零高度占位，那会留下一条带边框的空缝，
   * 在输入区上方永久挡着一行。
   */
  @Builder
  thinkBar() {
    if (this.thinkText().length > 0) {
      Column() {
        Divider()
          .strokeWidth(1)
          .color($r('sys.color.ohos_id_color_list_separator'))
        Row() {
          LoadingProgress()
            .width(13)
            .height(13)
            .color($r('sys.color.ohos_id_color_text_secondary'))
          Text(this.thinkText())
            .fontSize(12)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .layoutWeight(1)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .margin({ left: 7 })
        }
        .width('100%')
        .padding({ left: 14, right: 14, top: 6, bottom: 6 })
        .alignItems(VerticalAlign.Center)
      }
      .width('100%')
      .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
      .alignItems(HorizontalAlign.Start)
    }
  }

  /** 审批四态分派（见文件头判据 3）。 */
  @Builder
  approvalArea() {
    if (this.st().approvalState.kind === ApprovalUiKind.NONE) {
      ChatComposer({
        message: $message,
        onScrollToBottom: (): void => {
          this.scrollToBottom();
        },
        onMessageEdited: (): void => {
          this.syncComposerOverlay();
        },
      })
    } else if (this.st().approvalState.kind === ApprovalUiKind.LOADING) {
      Row() {
        LoadingProgress().width(20).height(20)
        Text($r('app.string.approval_loading'))
          .fontSize(14)
          .margin({ left: 12 })
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 14, bottom: 14 })
      .alignItems(VerticalAlign.Center)
    } else if (this.st().approvalState.kind === ApprovalUiKind.PENDING) {
      ApprovalPanel({
        approval: this.firstPending(),
        count: this.st().approvalState.items.length,
        deciding: false,
        canWrite: this.canWrite(),
        onReject: (): void => {
          this.decide(this.firstPending(), false);
        },
        onAllowOnce: (): void => {
          this.requestAllow(this.firstPending());
        },
      })
    } else {
      // DECIDING：还在等结果，两个按钮都禁用（`canWrite=false` 即可达到效果，
      // 但这里仍然显式传 `deciding=true`，让面板自己也能显示转圈与说明）。
      ApprovalPanel({
        approval: this.decidingItem(),
        count: this.st().approvalState.items.length,
        deciding: true,
        canWrite: false,
        onReject: (): void => {
        },
        onAllowOnce: (): void => {
        },
      })
    }
  }

  private firstPending(): PendingApproval {
    const items: PendingApproval[] = this.st().approvalState.items;
    return items.length > 0 ? items[0] : new PendingApproval();
  }

  private decidingItem(): PendingApproval {
    const item: PendingApproval | null = this.st().approvalState.item;
    return item === null ? new PendingApproval() : item;
  }

  private decide(approval: PendingApproval, allowOnce: boolean): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      void vm.decideApproval(approval, allowOnce);
    }
  }

  /**
   * 「允许一次」被点：高风险审批先走二次确认面板，其余直接放行。
   *
   * 判据与 `ApprovalPanel.fullAccess()` 一致，都是 `risk == "full-access"`。
   */
  private requestAllow(approval: PendingApproval): void {
    if (approval.risk === 'full-access') {
      this.fullAccessApprovalId = approval.id;
      this.fullAccessAck = false;
      // 面板宿主已拆到 `ChatHeaderPanelHost`（见文件头「拆分说明」）：这里就地写与原
      // `openSheet(SHEET_FULL_ACCESS)` 等价的两行 —— `sheetKind` / `sheetOpen`
      // 是与那个子组件双向绑定的 `@Link`，父组件可以直接写。
      this.sheetKind = SHEET_FULL_ACCESS;
      this.sheetOpen = true;
      return;
    }
    this.decide(approval, true);
  }

  // ————————————————— 顶层 —————————————————

  build() {
    Column() {
      ChatHeaderPanelHost({
        wide: this.wide,
        onBack: this.onBack,
        message: $message,
        sheetOpen: $sheetOpen,
        sheetKind: $sheetKind,
        fullAccessApprovalId: $fullAccessApprovalId,
        fullAccessAck: $fullAccessAck,
        onDecide: (approval: PendingApproval, allowOnce: boolean): void => {
          this.decide(approval, allowOnce);
        },
        onScrollToBottom: (): void => {
          this.scrollToBottom();
        },
      })

      if (this.currentSession() === null) {
        Column() {
          Text('💬').fontSize(30)
          Text($r('app.string.select_session'))
            .fontSize(13)
            .margin({ top: 8 })
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        }
        .width('100%')
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
      } else {
        if (this.todos().length > 0) {
          this.todoPanel()
        }

        Stack({ alignContent: Alignment.BottomEnd }) {
          this.messageList()
          if (!this.atBottom) {
            this.jumpButton()
          }
        }
        .layoutWeight(1)
        .width('100%')

        if (this.st().questions.length > 0) {
          this.questionsPanel()
        }
        this.thinkBar()
        this.approvalArea()
      }
    }
    .width('100%')
    .height('100%')
  }
}
