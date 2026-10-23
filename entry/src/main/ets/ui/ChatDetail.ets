/**
 * 聊天详情页 —— **装配层**。移植自原工程 `ui/ChatScreen.kt` 的 `ChatDetail`：
 *
 * | 源工程 | 本文件 / 承载文件 |
 * |---|---|
 * | `ChatDetail`（417–736） | `ChatDetail`（装配层，本文件） |
 * | `ConversationHeader`（738–877） | `ui/ChatHeader.ets` 的 `ChatHeaderPanelHost.header` |
 * | 五个面板宿主（会话文件 / 会话配置 / 完整访问确认 / 执行统计 / 后台任务） | `ui/ChatHeader.ets` 的 `sheetContent` |
 * | `ApprovalStatusLabel` / `ApprovalLoading`（1286–1317） | `ChatDetail.approvalArea` |
 * | `ApprovalPanel`（1319–1442） | `ui/ChatDetailPanels.ets` 的 `ApprovalPanel` |
 * | `QuestionCard`（1493–1643） | `ui/ChatDetailPanels.ets` 的 `QuestionCard` |
 * | `Composer`（1645–1866） | `ui/ChatComposer.ets` 的 `ChatComposer.composer` |
 * | `MentionSuggestions`（2139–2255） | `ui/ComposerSuggestions.ets` 的 `MentionSuggestions` |
 * | `commandSuggestions`（2264–2274） | `core/ComposerSuggestions.ts` 的 `commandSuggestions` |
 * | `CommandSuggestions`（2276–2326） | `ui/ComposerSuggestions.ets` 的 `CommandSuggestions` |
 * | `ChatThinkBar`（1897–1928） | `ui/ChatStatusBar.ets` 的 `ChatStatusBar`（与 AI 标识合并，见该文件头） |
 * | `ChatStatusBar` / `AiGeneratedNotice`（真机反馈五修） | `ui/ChatStatusBar.ets` |
 * | `groupChatDisplay`（`data/ChatDisplayGroups.kt`） | `core/ChatDisplayGroups.ts`（纯函数，可单测） |
 * | `ChatDisplayEntryRow` / `ProcessGroupRow`（`ui/ChatProcessGroup.kt`） | `ui/ProcessGroupRow.ets` |
 * | `rememberFrozenItems`（`ui/ChatScrollFreeze.kt`） | `ChatDetail.onScrollStarted` / `onScrollStopped` |
 * | `visibleHistoryItems`（`data/ChatVisibleItems.kt`） | `ChatDetail.computeDisplayItems` |
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
 *    这里用 `listItemCount()` 把「加载更早消息 / 空态 / **分组后的消息与过程组**」三类条目算出来，
 *    **改动列表结构时必须同步改它**（少算一项就会在「看着到底了」的位置把用户拽回底部，
 *    而小组折叠后行数会变少，所以判据必须按分组后的行数算）。
 * 5. **图片缩略图先解码**（`platform/ImageCodec.ets`）：ArkUI 的 `Image()` 只认 `PixelMap`。
 * 6. **「补全面板开着就关掉抽屉手势」那半截在本工程无对应 API**。源工程把 `@`/`/` 面板开着
 *    这个事实告诉外层（`state.composerOverlay`），让 `ModalNavigationDrawer` 停止响应横划
 *    （`gesturesEnabled = !composerOverlay …`）；ArkUI 的 `SideBarContainer` 没有等价的
 *    「禁用手势」属性。所以 `setComposerOverlay` 记下的状态在本工程只作记录 —— 面板内部的
 *    可滚动 `List` 已经把大部分误触挡掉（那正是源工程加这道保险的起因）。
 * 7. **展开态要存在父组件**。源工程的过程组用 `rememberSaveable` 记住「这一组展开过没有」；
 *    ArkUI 的 `List` 同样会回收视口外的条目，组件自带的 `@State` 会跟着没。所以展开态落在
 *    本组件的 `expandedGroups`，用 `@Prop` 下行给子组件（**普通成员不会被重绘回写**，见坑 24/27）。
 * 8. **`setTimeout` 没有取消机制**。源工程的滚动冻结用 `LaunchedEffect(scrolling)`，
 *    换 key 会自动取消上一次的协程；ArkUI 侧要自己加滚动代际校验，否则上一次的 80ms
 *    定时器会在新一轮滑动中错误解冻。
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
  ChatDisplayItem, ChatItemKind, LiveChatState, todoItemsOf,
} from '../core/ChatPresentation';
import { visibleHistoryItems } from '../core/ChatVisibleItems';
import { truncationItemsOf } from '../core/ChatTruncation';
import {
  ChatDisplayEntry, ChatDisplayEntryKind, chatDisplayEntryKey, groupChatDisplay,
} from '../core/ChatDisplayGroups';
import {
  ChatLinkReason, ChatLinkTarget, ChatLinkTargetKind, stripLocationSuffix,
} from '../core/ChatLinkTarget';
import { joinCwd, linkifyKnownFiles } from '../core/PathLinks';
import { liveThinkingText } from '../core/ChatThinkBar';
import { composerOverlayActive } from '../core/ComposerSuggestions';
import { galleryFileName } from '../core/ImageSave';
import { SaveOutcome, saveBytes } from '../platform/Pickers';
import { decodeImageSync } from '../platform/ImageCodec';
import { openExternalUrl } from '../platform/ExternalOpen';
import { harnessState, harnessVm } from './AppRuntime';
import { ChatDisplayEntryRow } from './ProcessGroupRow';
import { SessionFileRef } from '../core/SessionFileRefs';
import { sessionFileList } from './SessionFilesSheet';
import { ChatStatusBar } from './ChatStatusBar';
import { ApprovalPanel, QuestionCard } from './ChatDetailPanels';
import { ChatHeaderPanelHost, SHEET_FILES, SHEET_FULL_ACCESS } from './ChatHeader';
import { ChatComposer } from './ChatComposer';
import { TodoPanel } from './ChatDetailTodo';
import { ImageViewer, TrajectoryCover } from './ChatDetailOverlays';
import { common } from '@kit.AbilityKit';

/** 待回答问题区的高度上限：对位源工程 `heightIn(max = 340.dp)`。 */
const QUESTION_PANEL_MAX_HEIGHT_VP: number = 340;

/**
 * 停手之后再过多久才解冻渲染快照（毫秒）—— 对位源工程 `ChatScrollFreeze.kt` 的 80ms 窗口。
 *
 * 这 80ms 留给**惯性滑动与高度收敛**：立刻解冻会让刚停稳的位置跳一下。
 */
const SCROLL_SETTLE_MS: number = 80;

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
  /**
   * 上一次已经落过底的会话 id —— 用来把「换了个会话」和「同一个会话里来了新消息」分开。
   * 初值 `null`：首屏进会话也算一次「切换」，会落底一次。
   *
   * 普通成员即可：只在 `onRevision` 这个 `@Watch` 回调里读写，不参与渲染依赖，
   * 所以不需要（也不该）加装饰器（见 PORT-MAP 坑 24 的判据）。
   */
  private lastScrolledSessionId: string | null = null;

  // ——— 滚动期冻结流式快照 ———
  /**
   * 渲染快照是否已经「稳定」（可以灌入最新数据）。滚动中为 `false`，停手 80ms 后回到 `true`。
   *
   * 症状与做法见 `SCROLL_SETTLE_MS` 上方与 `onScrollStarted`：智能体正在流式输出时，
   * 用户往上翻历史，每一个 token 都会重建整份列表数据源 —— 手指下的滚动一顿一顿，
   * 而用户此刻压根不在看末尾。做法是滚动中保留**停手那一刻**的快照。
   */
  @State scrollSettled: boolean = true;

  /** 冻结中的那份快照；只在「开始滚动」的那一刻写入一次。 */
  private frozenItems: ChatDisplayItem[] = [];

  // ——— 历史投影缓存 ———
  /**
   * 缓存的历史投影（过滤后的历史项）与它的键。
   *
   * 缓存什么：`visibleHistoryItems` 是**逐事件映射的纯函数**，而它在渲染路径上每帧都会被
   * 调到 —— 流式期间每秒几十帧，每帧把几百条历史事件重新映射一遍再跑两趟过滤，纯粹白烧 CPU。
   * 历史只在「刷新」时才换对象，所以**引用相等就是「没变」的可靠判据**
   * （照抄源工程 `remember(history, showContext)` 的判据）。
   *
   * 刻意不缓存流式项（`liveItems()`）：它每帧都在变，缓存永远 miss，多一层比较与拷贝是**假优化**。
   *
   * 键里的 `projHasHistory` 必须与 `projHistory` 一起比：`history` 为 null 也是合法状态
   * （还没加载），只看引用相等无法区分「null → 懒加载完还是 null」这种情形下的空投影。
   */
  private projHistory: ChatHistory | null = null;
  private projHasHistory: boolean = false;
  private projShowContext: boolean = false;
  private projItems: ChatDisplayItem[] = [];
  /**
   * 与 `projItems` **同时算出**的已知文件路径（本会话交付物 + 历史里提到的文件）。
   *
   * 为什么跟着缓存一起存：`sessionFileList` 要**遍历全部历史事件**，而
   * `computeDisplayItems` 每帧都被调（流式期间每秒几十次）—— 每帧重扫一遍几百条事件
   * 正是这个文件头反复强调要避免的那类白烧 CPU。它只在投影缓存未命中时才重算。
   */
  private projKnownPaths: string[] = [];

  /**
   * 滚动代际。停手后延时解冻的定时器要认这个值，**只有当前代际**的定时器才能解冻。
   *
   * 为什么必须有：用户快速连续滑动会让上一次的 80ms 定时器在**新一次滚动进行中**到期，
   * 那一下会错误地解冻 —— 表现就是「刚滑两下，列表又跳了」。
   * 源工程用 `LaunchedEffect(scrolling)` 天然带这个语义（换 key 会取消上一次的协程），
   * ArkUI 的 `setTimeout` 没有取消机制，所以这里手动加一道代际校验。
   */
  private scrollGeneration: number = 0;

  // ——— 视口锚定（加载更早消息后不让视口跳走） ———
  /**
   * 加载更早消息前，首条可见分组对应的消息 seq。
   *
   * 加载完成后 history 更新，displayEntries() 前插了更早的条目，
   * 原来 start index 指向的那条消息现在的 index 变了 —— 但 seq 是稳定的，
   * 所以按 seq 锚定而不是按 index。onRevision 里用它找到新位置后 scrollToIndex。
   *
   * null 表示当前没有待恢复的锚定（不是每次 history 变更都需要锚定 ——
   * 只有 loadOlder 主动设置它）。
   */
  private pendingAnchorSeq: number | null = null;
  /** 当前首条可见分组的 index（onScrollIndex 的 start 参数）。 */
  private visibleStartIndex: number = 0;

  /**
   * 已展开的过程组 id 列表（组 id = 组内首项 id）。
   *
   * 为什么展开态存在**父组件**而不是组自己：ArkUI 的 `List` 会回收视口外的条目，
   * 组件自带的 `@State` 会跟着没了 —— 用户展开一组、往下滚两屏再滚回来，它会自己合上。
   * 源工程用 `rememberSaveable` 解决同一件事（见 `ui/ProcessGroupRow.ets` 文件头）。
   *
   * 用数组而不是 `Set`：`@State` 的赋值检测靠「换了个新对象」，数组每次重建一份新的最直白。
   */
  @State expandedGroups: string[] = [];

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

  // ——— 图片全屏查看（对位源工程 `ui/chat/ChatImageViewer.kt`） ———
  /**
   * 查看器里那张图的字节；`null` = 查看器关着。
   *
   * 状态住在**这一层**而不是 `AttachmentImage` 自己：`List` 会回收视口外的消息行，
   * 图片行滚动出屏幕再把查看器带走，就会变成「刚点开、滑一下就没了」
   * （与过程组展开态同一个坑，PORT-MAP 坑 29）。
   */
  @State viewerBytes: Uint8Array | null = null;
  /** 已解码的位图；只在 `openImageViewer` 里写一次（解码失败就不打开）。 */
  @State viewerPixelMap: PixelMap | null = null;
  /** 保存时的默认文件名（`ChatAttachment.name` 原样带进来）。 */
  @State viewerName: string = '';

  /**
   * 执行轨迹页是否打开（全屏覆盖）。
   *
   * 状态住在**这一层**、入口在头部菜单（头部只上报 `onOpenTrajectory`）：
   * 全屏覆盖层挂在详情页的根节点上，`bindContentCover` 的 `isShow` 只有一个来源，
   * 与图片查看器同一个理由（PORT-MAP 坑 31 / 34）。
   */
  @State trajectoryOpen: boolean = false;

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

  /**
   * 无参资源 → 字符串。只在**必须拿 string** 的场合用：系统弹窗
   * （`showAlertDialog` 的 `value` /`message` 传 `Resource` 在部分版本上不渲染）。
   * 与 `ui/ChatScreen.ets` 的同名助手保持一致。
   */
  private resText(res: Resource): string {
    const ctx = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      return '';
    }
    return ctx.resourceManager.getStringSync(res.id);
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
    const found: ChatSession | null = ChatDetail.findSession(this.st().sessions, id);
    if (found !== null) {
      return found;
    }
    // 归档视图里打开的会话**不在** `sessions` 里 —— 不查这一份的话，头部标题会退化成
    // id 前 12 位（看起来像一条陌生会话），而用户明明是从归档列表点进来的。
    return ChatDetail.findSession(this.st().archivedSessions, id);
  }

  private static findSession(list: ChatSession[], id: string): ChatSession | null {
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id) {
        return list[i];
      }
    }
    return null;
  }

  // ————————————————— 消息流 —————————————————

  /**
   * 当前该渲染的扁平展示项：**滚动中返回冻结快照**，否则重算。
   *
   * 两条过滤口径已搬进 `core/ChatVisibleItems.ts`（原来是内联在这里的，搬出去是为了能测，
   * 也为了让「历史投影缓存」有一个明确的缓存单元）：
   * ① 历史里的 REASONING 不显示（翻历史的人不读思考）；
   * ② 历史里的 CONTEXT 默认隐藏（`showContext` 开关在设置页）；
   * ③ **流式段同样过滤 REASONING** —— 那一段改由底部思考条承载。
   *
   * 这里的「冻结」只挡**渲染数据源**：`atBottom` / 「跳到最新」仍然读实时值，
   * 否则用户滚到底时按钮的显隐会跟着旧快照走。
   *
   * 方法名从 `displayItems` 改成 `renderItems`：它是**渲染入口**而不是展示项的产出者 ——
   * 真正的产出只有 core 层一处（`ChatEventParsers.displayItemsOf` 与过滤核
   * `ChatVisibleItems.visibleItemsOf`）。名字不该让人以为界面层有第二个出口。
   */
  private renderItems(): ChatDisplayItem[] {
    if (!this.scrollSettled) {
      return this.frozenItems;
    }
    return this.computeDisplayItems();
  }

  /**
   * 历史投影：命中缓存就直接复用，没命中才重算。
   *
   * 缓存键 = 「history 对象 + 它是不是 null + showContext 开关」，三个都相同才复用。
   * 这是源工程 `remember(history, showContext)` 的等价物 —— ArkUI 没有 `remember`，
   * 就用普通成员变量手工记账（普通成员不参与重绘回写，但这里只做**纯计算缓存**、
   * 不驱动界面，所以不需要 `@State`）。
   */
  private historyProjection(history: ChatHistory | null, showContext: boolean): ChatDisplayItem[] {
    const sameHistory: boolean = history === this.projHistory && (history !== null) === this.projHasHistory;
    if (sameHistory && showContext === this.projShowContext) {
      return this.projItems;
    }
    this.projHistory = history;
    this.projHasHistory = history !== null;
    this.projShowContext = showContext;
    const paths: string[] = this.knownFilePaths(history);
    this.projKnownPaths = paths;
    this.projItems = this.linkified(visibleHistoryItems(history, showContext), paths);
    return this.projItems;
  }

  /**
   * 本会话「提到过的文件」的绝对路径清单。
   *
   * 与「本会话的文件」面板**同一个出处**（`ui/SessionFilesSheet.ets` 的 `sessionFileList`）：
   * 源工程也是直接从 `sessionFileList(history)` 取（`ui/chat/ChatDetail.kt` 渲染正文之前）。
   * 若这里另起一套取法，面板里能点开的文件在正文里可能点不动 —— 用户会认定是链接坏了。
   */
  private knownFilePaths(history: ChatHistory | null): string[] {
    const refs: SessionFileRef[] = sessionFileList(history);
    const out: string[] = [];
    for (let i = 0; i < refs.length; i++) {
      out.push(refs[i].path);
    }
    return out;
  }

  /**
   * 正文文件链接化：把「已落盘：report.md」这种纯文本文件名变成可点链接。
   *
   * 只对 USER / ASSISTANT 两类做（源工程同款判据）：工具行的正文是命令与输出，
   * 那一段有自己的等宽排版与折叠规则，塞进链接语法只会让它在详情块里显示成一串标记。
   *
   * 复制一份、只换正文（`withBody`）而不是就地改：历史投影**带缓存**，
   * 就地改会把缓存对象一起改掉。
   */
  private linkified(items: ChatDisplayItem[], paths: string[]): ChatDisplayItem[] {
    if (paths.length === 0) {
      return items;
    }
    const out: ChatDisplayItem[] = [];
    for (let i = 0; i < items.length; i++) {
      const item: ChatDisplayItem = items[i];
      if (item.kind !== ChatItemKind.USER && item.kind !== ChatItemKind.ASSISTANT) {
        out.push(item);
        continue;
      }
      const linked: string = linkifyKnownFiles(item.body, paths);
      out.push(linked === item.body ? item : item.withBody(linked));
    }
    return out;
  }

  private computeDisplayItems(): ChatDisplayItem[] {
    const history: ChatHistory | null = this.st().history;
    const showContext: boolean = this.st().showContext;
    const out: ChatDisplayItem[] = this.historyProjection(history, showContext).slice();
    // 流式项每帧重建，所以也得每帧链接化；它只有寥寥几项（正在流的那条正文 + 活动行），
    // 与「几百条历史事件重扫一遍」是两码事（后者已随投影一起缓存，见 `projKnownPaths`）。
    const live: ChatDisplayItem[] = this.linkified(this.liveItems(), this.projKnownPaths);
    for (let i = 0; i < live.length; i++) {
      out.push(live[i]);
    }
    // 「回答被截断」提示排在**尾部**：它属于刚结束的那一轮，历史里查不到（内核
    // `sessions.history` 不返回 turn/end），只能由实时帧写进状态。
    // 会话对不上时 `truncationItemsOf` 返回空表 —— 切会话自动失效，不必各个入口手动清。
    const notices: ChatDisplayItem[] = truncationItemsOf(this.st().truncatedNoticeSession,
      this.st().truncatedNotice, this.st().selectedSessionId);
    for (let i = 0; i < notices.length; i++) {
      out.push(notices[i]);
    }
    return out;
  }

  /**
   * 把扁平项折成「消息 + 过程组」两类（规则与理由见 `core/ChatDisplayGroups.ts`）。
   *
   * 时间从 item 自己身上取（`ChatDisplayItem.time`，历史项有值、流式项为 `0`
   * → 该组不显示耗时段）。这正是移植批次 1 补 `time` 时预留的那个接缝。
   */
  private displayEntries(): ChatDisplayEntry[] {
    return groupChatDisplay(this.renderItems());
  }

  private isGroupExpanded(id: string): boolean {
    return this.expandedGroups.includes(id);
  }

  /** 切换一组的展开态：重建一份数组再赋值，`@State` 才会认定为「变了」。 */
  private toggleGroup(id: string): void {
    const next: string[] = [];
    let found: boolean = false;
    for (let i = 0; i < this.expandedGroups.length; i++) {
      const key: string = this.expandedGroups[i];
      if (key === id) {
        found = true;
      } else {
        next.push(key);
      }
    }
    if (!found) {
      next.push(id);
    }
    this.expandedGroups = next;
  }

  /**
   * 开始滚动：**先把此刻的列表存进快照，再上锁**。
   *
   * 顺序不能反：上锁之后 `displayItems()` 就开始返回快照了，那时再取就取到的是上一份快照
   * （第一次滚动时更是空表）。
   */
  private onScrollStarted(): void {
    this.scrollGeneration++;
    if (this.scrollSettled) {
      this.frozenItems = this.computeDisplayItems();
    }
    this.scrollSettled = false;
  }

  /** 停手：等 80ms 解冻（窗口的取舍见 `SCROLL_SETTLE_MS`）。 */
  private onScrollStopped(): void {
    const generation: number = this.scrollGeneration;
    setTimeout((): void => {
      if (generation === this.scrollGeneration) {
        this.scrollSettled = true;
      }
    }, SCROLL_SETTLE_MS);
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

  /**
   * 状态条的**思考原文**：只承载**流式这一段** —— 翻历史时 `liveChat` 为 null，返回空串。
   *
   * 返回原文而不是截好的摘要：状态条要在「折叠（尾部摘要）/ 展开（全文）」两个形态之间切换，
   * 两形态都得有（截断在 `ui/ChatStatusBar.ets` 内部做，见该文件头）。而且思考为空时
   * 状态条会改显示「内容由 AI 生成」标识 —— 那条判据也在那边。
   */
  private rawThinkText(): string {
    const live: LiveChatState | null = this.liveChat();
    return live === null ? '' : liveThinkingText(live.blocks);
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
   *
   * 数的是**分组之后**的行数：分组把「连续的过程项」折成一行，按扁平项数算会让判据
   * 一直偏大，于是「看着到底了」的位置被算成「还差好几行」，自动跟随就再也开不了火。
   * 上一段的「加载更早消息」与空态两块照旧各算一行。
   */
  private listItemCount(): number {
    // 只算一次分组：这个函数在 `onScrollIndex` 里被高频调用，多算一遍就是多一趟 O(n)
    // （分组会新建数组与摘要对象，长会话下这笔开销不该重复付）。
    // 空态的判据可以直接用条目数 —— 分组不改变「有没有条目」这件事。
    const entries: number = this.displayEntries().length;
    let count: number = entries;
    if (this.hasMore()) {
      count += 1;
    }
    if (this.st().history !== null && entries === 0) {
      count += 1;
    }
    return count;
  }

  private loadOlder(): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      // 视口锚定：加载前记住当前首条可见分组里第一条消息的 seq，
      // 加载后（history 前插了更早的条目）用它找到新位置再滚回去 ——
      // ArkUI List 头部插入后默认跳到新条目位置，不加这一下用户会看到视口突然跳走。
      // 不是每次 history 变更都需要锚定，只有 loadOlder 主动设置。
      const entries: ChatDisplayEntry[] = this.displayEntries();
      const idx: number = this.visibleStartIndex;
      // +1 是顶部「加载更早消息」ListItem，所以真实分组 index = visibleStartIndex - 1
      const entryIndex: number = idx > 0 ? idx - 1 : 0;
      if (entryIndex >= 0 && entryIndex < entries.length) {
        const anchor: ChatDisplayEntry = entries[entryIndex];
        // 过程组取组内首项的 seq，消息取 item.seq
        this.pendingAnchorSeq = anchor.kind === ChatDisplayEntryKind.PROCESS_GROUP
          ? (anchor.items.length > 0 ? anchor.items[0].seq : null)
          : (anchor.item !== null ? anchor.item.seq : null);
      } else {
        this.pendingAnchorSeq = null;
      }
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

  /**
   * 失败行上的「重试上一轮」：把最后一条用户消息再发一次。
   *
   * 两条判据都不在这一层：vm 侧的「找不到就静默不动」在
   * `HarnessViewModelComposer.retryLastUserMessage()`，「`stopped` 不给按钮」在
   * `ui/MessageParts.ets` 的 `TurnFailureRow`。这里只做转发。
   */
  private retryLastTurn(): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      vm.retryLastUserMessage();
    }
  }

  /**
   * 消息级分叉的**二次确认**。与归档同理，用系统弹窗（自动套用深浅色）；
   * 分叉会在电脑上**新建一个会话**，虽然不动原会话，但它是「改真实数据」的动作，
   * 点一下图标就生效是不行的。
   *
   * 确认对话框的状态刻意**不放进子组件**：`List` 会回收视口外的消息行，
   * 对话框若由 `ChatMessageView` 自己持有，用户点完手指一动就可能把待确认状态带走
   * （与过程组展开态同一个坑，PORT-MAP 坑 29/30）。这里只有 `atSeq` 一个瞬时参数，
   * 走一层转发即可，不必引入 `@State` 集合。
   */
  private confirmFork(atSeq: number): void {
    this.getUIContext().showAlertDialog({
      title: this.resText($r('app.string.fork_confirm_title')),
      message: this.resText($r('app.string.fork_confirm_body')),
      primaryButton: {
        value: this.resText($r('app.string.fork_confirm_action')),
        action: (): void => {
          this.forkAt(atSeq);
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

  private forkAt(atSeq: number): void {
    const vm: HarnessViewModel | null = this.vm();
    const id: string | null = this.selectedId();
    if (vm !== null && id !== null) {
      void vm.forkSession(id, atSeq);
    }
  }

  // ————————————————— 图片全屏查看 —————————————————

  /**
   * 打开全屏查看。**解码失败就不打开**：缩略图能画出来说明这张图曾经解得开，
   * 这里是二次保险；真解不开时打开只会得到一整屏黑，比「点了没反应」更难解释。
   */
  private openImageViewer(bytes: Uint8Array, name: string): void {
    const decoded: PixelMap | null = decodeImageSync(bytes);
    if (decoded === null) {
      return;
    }
    this.viewerBytes = bytes;
    this.viewerPixelMap = decoded;
    this.viewerName = name;
  }

  private closeImageViewer(): void {
    this.viewerBytes = null;
    this.viewerPixelMap = null;
    this.viewerName = '';
  }

  /**
   * 会话正文里点了链接：按目标类型分流。
   *
   * 对位源工程 `ui/chat/ChatLinkHandlers.kt` 的 `rememberSessionLinkHandler` ——
   * 判断规则住在 `core/ChatLinkTarget.ts`（可单测），这里只做「怎么办」：
   *
   * | 类型 | 怎么办 | 为什么 |
   * |---|---|---|
   * | 服务端绝对路径 | 加载并**打开「本会话的文件」面板** | 只加载不开面板 = 点了没反应（见下） |
   * | http(s) | 交给系统浏览器 | |
   * | 相对路径 | **先拼上会话 cwd** 再当绝对路径走 | 模型常写 `docs/x.md` 这种相对路径 |
   * | 锚点 / 其它协议 / 空 | 明确告诉用户不支持 | 不能让点击**静默失败** |
   */
  private openChatLink(url: string): void {
    const target: ChatLinkTarget = ChatLinkTarget.classify(url);
    if (target.kind === ChatLinkTargetKind.SERVER_PATH) {
      this.openSessionFileFromLink(target.path);
      return;
    }
    if (target.kind === ChatLinkTargetKind.WEB) {
      const context: common.Context | undefined = this.getUIContext().getHostContext();
      if (context === undefined || !openExternalUrl(context, target.path)) {
        this.toast($r('app.string.link_open_failed'));
      }
      return;
    }
    if (target.reason === ChatLinkReason.RELATIVE_PATH) {
      const cwd: string | null = this.cwdAbsolute();
      if (cwd !== null && cwd.length > 0) {
        // 相对路径同样要剥位置后缀：`docs/x.md:1` 拼进 cwd 后就成了
        // `cwd/docs/x.md:1`，服务端只会回「不是普通文件」（真机实测 2026-10-20）。
        this.openSessionFileFromLink(joinCwd(cwd, stripLocationSuffix(target.path.trim())));
        return;
      }
      // 拿不到 cwd（本工程实测 `/` 之前的字段多为空）时给同一句提示：
      // 用户至少知道「需要一个基准路径」，而不是以为链接坏了。
      this.toast($r('app.string.link_relative_path'));
      return;
    }
    this.toast(this.linkReasonText(target.reason));
  }

  /**
   * 打开服务端路径：**既加载又开面板**。
   *
   * 只调 `openSessionFile` 是不行的 —— 它只把文件加载进状态，展示它的
   * 「本会话的文件」面板由 `sheetOpen` / `sheetKind` 控制。只加载不开面板，
   * 用户看到的就是「点了完全没反应」（源工程 2026-10-19 真机实测：日志与 resolve
   * 都成功了，屏幕上什么都没发生）。
   */
  private openSessionFileFromLink(path: string): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm === null) {
      return;
    }
    void vm.openSessionFile(path);
    this.sheetKind = SHEET_FILES;
    this.sheetOpen = true;
  }

  /** 会话的工作目录（绝对）。拿不到就是 null —— 相对路径那一支会据此降级。 */
  private cwdAbsolute(): string | null {
    const session: ChatSession | null = this.currentSession();
    return session === null ? null : session.cwdAbsolute;
  }

  /** 不支持的原因 → 给用户看的那句话。 */
  private linkReasonText(reason: ChatLinkReason | null): Resource {
    if (reason === ChatLinkReason.ANCHOR) {
      // 锚点是「同一页内的跳转」，本 App 没有「同一页」这个概念，说了用户也不懂，
      // 只说明「需要网址」即可。
      return $r('app.string.link_anchor_unsupported');
    }
    if (reason === ChatLinkReason.UNKNOWN_SCHEME) {
      return $r('app.string.link_scheme_unsupported');
    }
    // RELATIVE_PATH / EMPTY 共用一句：要点都是「告诉用户去哪儿找这个文件」。
    return $r('app.string.link_relative_path');
  }

  private toast(message: Resource): void {
    this.getUIContext().getPromptAction().showToast({ message: message });
  }

  /**
   * 把查看器里这张图写到用户选的位置。
   *
   * ## 为什么是「保存」而不是「存相册」
   *
   * 源工程走的是安卓 `MediaStore`（`saveToGallery`）。鸿蒙这边等价的相册写入要
   * `ohos.permission.WRITE_IMAGEVIDEO`，**与 READ_PASTEBOARD 同一类受限权限**，
   * 普通应用声明会导致安装失败（本工程已经栽过一次，见项目记忆）。
   * 所以改用系统「保存」面板（`platform/Pickers.saveBytes`，**零权限**）：
   * 用户自己在面板里选位置（含相册目录）、还能顺手改名。
   *
   * ## 三条与源工程一致的处置
   *
   * - **取消不是错误**：`CANCELLED` 一律不弹提示 —— 用户按了取消却收到一句「保存失败」，
   *   会以为哪里坏了；
   * - **失败必须可见**（源工程原话）：真失败时给一句提示，否则用户会以为已经存上了；
   * - 文件名由 `galleryFileName` 按**魔数**补扩展名（会话里的图经常没有扩展名或扩展名是错的）。
   */
  private async saveViewedImage(): Promise<void> {
    const bytes: Uint8Array | null = this.viewerBytes;
    if (bytes === null) {
      return;
    }
    const context = this.getUIContext().getHostContext();
    if (context === undefined) {
      this.getUIContext().getPromptAction().showToast({ message: $r('app.string.image_save_failed') });
      return;
    }
    const outcome: SaveOutcome = await saveBytes(context, galleryFileName(this.viewerName, bytes), bytes);
    if (outcome === SaveOutcome.SAVED) {
      this.getUIContext().getPromptAction().showToast({ message: $r('app.string.image_saved') });
    } else if (outcome === SaveOutcome.FAILED) {
      this.getUIContext().getPromptAction().showToast({ message: $r('app.string.image_save_failed') });
    }
  }

  private scrollToBottom(): void {
    this.atBottom = true;
    this.scroller.scrollEdge(Edge.Bottom);
  }

  /**
   * 每次 vm 变更都过一遍：① 回填发送失败的原文；② 落底（换会话 / 贴底跟随）。
   *
   * **换会话时无论用户在上一个会话里滚到哪儿，都要落在最新一条上** —— 这是「对话性智能体」
   * 的默认预期（源工程真机反馈第六、八修反复强调）。之前的写法只看 `atBottom`：上一个会话
   * 滚过历史（`atBottom` 被 `onScrollIndex` 置为 false）之后切到新会话，那个 false 会**带过去**，
   * 于是一进去就停在顶部。
   *
   * 还有一条**顺序上的坑**（源工程三版都栽在这里）：切换时历史往往还没回来，
   * `renderItems()` 是空的。所以「这个会话已经落过底」这件事**必须等列表真的有内容之后**
   * 才记下来 —— 否则第一次执行就把它记成已完成，之后再没有第二次机会。
   *
   * 滚动用 `setTimeout(…, 0)` 而不是当场滚：revision 变化的这一刻新条目还没完成布局，
   * 当场滚会停在倒数第二条上。延到下一轮事件循环才滚得准。
   */
  private onRevision(): void {
    const pending: string = this.st().pendingText;
    if (pending.trim().length > 0 && pending !== this.message) {
      this.message = pending;
    }
    const items: ChatDisplayItem[] = this.renderItems();
    if (items.length > 0) {
      if (this.selectedId() !== this.lastScrolledSessionId) {
        this.lastScrolledSessionId = this.selectedId();
        this.atBottom = true;
      }
      if (this.atBottom) {
        setTimeout((): void => {
          this.scroller.scrollEdge(Edge.Bottom);
        }, 0);
      }
    }
    // ——— 视口锚定：加载更早消息后不让视口跳走 ———
    // 加载更早前 set pendingAnchorSeq，history 更新后在这里用它找到新位置滚回去。
    // 用 setTimeout(0) 跟 scrollEdge 同一节奏：等下一帧布局完。
    // 换会话时 pendingAnchorSeq 会在 loadOlder 被换会话清 history 后自然失效
    // （items.length > 0 会是新会话的内容，find 找不到那条 seq），不会误锚。
    const anchor: number | null = this.pendingAnchorSeq;
    if (anchor !== null) {
      setTimeout((): void => {
        const entries: ChatDisplayEntry[] = this.displayEntries();
        // +1 对应顶部「加载更早消息」ListItem（hasMore 时存在）
        const offset: number = this.hasMore() ? 1 : 0;
        for (let i = 0; i < entries.length; i++) {
          const e: ChatDisplayEntry = entries[i];
          let matched: boolean = false;
          if (e.kind === ChatDisplayEntryKind.MESSAGE && e.item !== null) {
            matched = e.item.seq === anchor;
          } else if (e.kind === ChatDisplayEntryKind.PROCESS_GROUP) {
            for (let j = 0; j < e.items.length; j++) {
              if (e.items[j].seq === anchor) {
                matched = true;
                break;
              }
            }
          }
          if (matched) {
            this.scroller.scrollToIndex(i + offset, false);
            break;
          }
        }
        this.pendingAnchorSeq = null;
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
      if (this.st().history !== null && this.renderItems().length === 0) {
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
      ForEach(this.displayEntries(), (entry: ChatDisplayEntry) => {
        ListItem() {
          // `List` 没有 `space`（源工程 `Arrangement.spacedBy(5.dp)` 的对位），
          // 所以间距改由条目自身的下外边距给。
          Column() {
            ChatDisplayEntryRow({
              entry: entry,
              images: this.st().attachmentImages,
              failures: this.st().attachmentFailures,
              genUiDebug: this.st().genUiDebug,
              onLoadImage: (id: string): void => {
                this.loadAttachmentImage(id);
              },
              onAnswer: (text: string): void => {
                this.answerFromCard(text);
              },
              onRetry: (): void => {
                this.retryLastTurn();
              },
              onFork: (atSeq: number): void => {
                this.confirmFork(atSeq);
              },
              onOpenImage: (bytes: Uint8Array, name: string): void => {
                this.openImageViewer(bytes, name);
              },
              onLink: (url: string): void => {
                this.openChatLink(url);
              },
              // 展开态与切换回调由父组件持有（理由见 `expandedGroups` 的注释）。
              // `expanded` 必须是 `@Prop`：普通成员不会被 ArkUI 重绘回写，
              // 用户点了箭头却看不到变化 —— 就是 PORT-MAP 坑 24/27 那一类。
              expanded: this.isGroupExpanded(entry.id),
              onToggle: (): void => {
                this.toggleGroup(entry.id);
              },
            })
          }
          .width('100%')
          .margin({ bottom: 5 })
        }
      }, (entry: ChatDisplayEntry) => chatDisplayEntryKey(entry))
    }
    .width('100%')
    .height('100%')
    .padding({ left: 12, right: 12, top: 9, bottom: 9 })
    .scrollBar(BarState.Off)
    // 滚动期冻结渲染快照（症状 / 做法 / 80ms 窗口见 `SCROLL_SETTLE_MS` 与 `onScrollStarted`）。
    .onScrollStart((): void => {
      this.onScrollStarted();
    })
    .onScrollStop((): void => {
      this.onScrollStopped();
    })
    .onScrollIndex((start: number, end: number): void => {
      this.visibleStartIndex = start;
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
   * 状态条：**思考条与「内容由 AI 生成」标识合成同一条**（真机反馈五修，2026-10-17）。
   *
   * 位置固定在消息区**下方**、输入区**上方**（网页版 `#thinkbar` 的位置）。
   * 有思考时显示思考（可展开全文），没有思考时才显示标识 ——
   * 为什么合并、为什么让思考优先、标识的合规依据，全部写在 `ui/ChatStatusBar.ets` 文件头。
   *
   * 这一条**恒常渲染**（不再「思考为空就整条不显示」）：标识是常驻合规提示，
   * 只有它自己在两种形态里挑一个显示，没有「整条消失」这一档。
   */
  @Builder
  statusBar() {
    ChatStatusBar({ rawThinking: this.rawThinkText() })
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
        onOpenTrajectory: (): void => {
          this.trajectoryOpen = true;
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
          TodoPanel({ todos: this.todos() })
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
        this.statusBar()
        this.approvalArea()
      }
    }
    .width('100%')
    .height('100%')
    // 图片全屏查看器：`bindContentCover` 是盖住整页的系统级模态，
    // 返回键与底部手势区由系统接管（见 `imageViewer` 注释）。
    // `isShow` 走单向：用户用系统返回键关掉时靠 `onDisappear` 复位标志，
    // 否则标志会留在 true，下一次再设 true 就不再触发（与 `ChatScreen` 的面板宿主同一个坑）。
    .bindContentCover(this.viewerBytes !== null, this.imageViewer(), {
      modalTransition: ModalTransition.DEFAULT,
      onDisappear: (): void => {
        this.closeImageViewer();
      },
    })
    // 执行轨迹页：同样是全屏系统级模态（见 `ui/TrajectoryScreen.ets` 的平台差异一节）。
    // 状态用布尔而不是「history 是否为 null」：历史为 null 时轨迹页要显示空态，
    // 拿 history 当显隐判据会让它在没加载完时根本打不开。
    .bindContentCover(this.trajectoryOpen, this.trajectorySheet(), {
      modalTransition: ModalTransition.DEFAULT,
      onDisappear: (): void => {
        this.trajectoryOpen = false;
      },
    })
  }

  /** 轨迹页的内容（**不传 history**：本页自订阅 vm，理由见 `TrajectoryScreen.ets` 文件头）。 */
  @Builder
  trajectorySheet() {
    TrajectoryCover({
      onClose: (): void => {
        this.trajectoryOpen = false;
      },
    })
  }

  /** 图片查看器的薄包装：`bindContentCover` 需要 `@Builder`，内容住在 `ChatDetailOverlays.ets`。 */
  @Builder
  imageViewer() {
    ImageViewer({
      pixelMap: this.viewerPixelMap,
      onClose: (): void => {
        this.closeImageViewer();
      },
      onSave: (): void => {
        void this.saveViewedImage();
      },
    })
  }
}
