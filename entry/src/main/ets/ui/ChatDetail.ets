/**
 * 聊天详情页 —— 移植自原工程 `ui/ChatScreen.kt` 的 `ChatDetail` 及其下属组件：
 *
 * | 源工程 | 本文件 |
 * |---|---|
 * | `ChatDetail`（417–736） | `ChatDetail` |
 * | `ConversationHeader`（738–877） | `ChatDetail.header` |
 * | `ApprovalStatusLabel` / `ApprovalLoading`（1286–1317） | `ChatDetail.approvalArea` |
 * | `ApprovalPanel`（1319–1442） | `ApprovalPanel` |
 * | `QuestionCard`（1493–1643） | `QuestionCard` |
 * | `Composer`（1645–1866） | `ChatDetail.composer` |
 * | `MentionSuggestions`（2139–2255） | `ui/ComposerSuggestions.ets` 的 `MentionSuggestions` |
 * | `commandSuggestions`（2264–2274） | `core/ComposerSuggestions.ts` 的 `commandSuggestions` |
 * | `CommandSuggestions`（2276–2326） | `ui/ComposerSuggestions.ets` 的 `CommandSuggestions` |
 * | `ChatThinkBar`（1897–1928） | `ChatDetail.thinkBar` |
 * | `TodoPanel`（2045–2125） | `ChatDetail.todoPanel` |
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

import { common } from '@kit.AbilityKit';
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
import { ComposerHint, composerHint } from '../core/ComposerPill';
import { SEND_MODE_STEER, canSubmit, resolveSendMode } from '../core/ComposerSendPolicy';
import { activeStart, applySelection } from '../core/MentionQuery';
import { composerOverlayActive } from '../core/ComposerSuggestions';
import { allAnswered, buildAnswers } from '../core/QuestionAnswers';
import { MAX_FILE_BYTES, MAX_IMAGE_BYTES, formatBytes } from '../core/ChatContentParts';
import { PickFailureKind, PickResult, pickFile, pickImage } from '../platform/Pickers';
import { decodeImageSync } from '../platform/ImageCodec';
import { harnessState, harnessVm, requestFilesSection } from './AppRuntime';
import { StatusLabel } from './Components';
import { ChatMessageView } from './ChatMessage';
import { CommandSuggestions, MentionSuggestions } from './ComposerSuggestions';
import { SessionFilesSheet } from './SessionFilesSheet';
import { SessionConfigSheet } from './ModelSheet';

/** 面板宿主的三态（`sheetKind` 只在本文件内使用，故用数字常量而非导出枚举）。 */
const SHEET_FILES: number = 0;
const SHEET_CONFIG: number = 1;
const SHEET_FULL_ACCESS: number = 2;

/** 待回答问题区的高度上限：对位源工程 `heightIn(max = 340.dp)`。 */
const QUESTION_PANEL_MAX_HEIGHT_VP: number = 340;

/** 审批面板里「脱敏命令预览」的高度上限：对位 `heightIn(max = 144.dp)`。 */
const COMMAND_DETAIL_MAX_HEIGHT_VP: number = 144;

/**
 * 一轮问答卡（`ask_user_question`，方案 A 只做 `continued`）。
 *
 * 勾选与自由文本都按 `callId` 记住（见 `aboutToAppear`）：同一组题在重绘之间不能丢答案；
 * 换了一组就从零开始，免得上一组的答案漏到下一组 —— 那是「提交上去的答案张冠李戴」这类事故。
 *
 * **单选再点一次已选中的就是取消**（源工程注释写明了这是为了「让用户能改主意」，而不是
 * 与网页版的 radio 对齐 —— 网页版的 radio 点不掉）。
 */
@Component
struct QuestionCard {
  questionSet: PendingQuestionSet = new PendingQuestionSet();
  answered: boolean = false;
  submitting: boolean = false;
  canWrite: boolean = false;
  onSubmit: (answers: QuestionAnswer[]) => void = (): void => {};

  /**
   * 勾选：`questionId → 已选标签集合`。
   *
   * 用 `@State` 存 `Map`，每次改动**换一个新 Map**（原地 `set` 不会触发重绘）——
   * 这是 ArkUI 与 Compose 的 `mutableStateMapOf` 最容易踩反的一处。
   */
  @State selected: Map<string, Set<string>> = new Map<string, Set<string>>();
  /** 自由文本：`questionId → 草稿`。同样每次换新 Map。 */
  @State customText: Map<string, string> = new Map<string, string>();

  aboutToAppear(): void {
    this.selected = new Map<string, Set<string>>();
    this.customText = new Map<string, string>();
  }

  /** 可交互 = 有写权限 + 没在提交 + 还没答过。三条缺一不可（照抄源工程）。 */
  private interactive(): boolean {
    return this.canWrite && !this.submitting && !this.answered;
  }

  /** 一组题全答完（纯函数，与源工程 `isAnswered` 同一份判据）。 */
  private complete(): boolean {
    return this.questionSet.questions.length > 0
      && allAnswered(this.questionSet.questions, this.selected, this.customText);
  }

  private pickedLabels(questionId: string): Set<string> {
    const current: Set<string> | undefined = this.selected.get(questionId);
    return current === undefined ? new Set<string>() : current;
  }

  /** 切换一个选项。单选与多选的差别只在「要不要清掉别的」（照抄源工程）。 */
  private toggle(question: ChatQuestion, label: string): void {
    if (!this.interactive()) {
      return;
    }
    const current: Set<string> = this.pickedLabels(question.id);
    const checked: boolean = current.has(label);
    const next: Set<string> = new Set<string>();
    if (!question.multiSelect) {
      if (!checked) {
        next.add(label);
      }
    } else {
      current.forEach((item: string): void => {
        if (item !== label) {
          next.add(item);
        }
      });
      if (!checked) {
        next.add(label);
      }
    }
    const map: Map<string, Set<string>> = new Map<string, Set<string>>();
    this.selected.forEach((value: Set<string>, key: string): void => {
      map.set(key, key === question.id ? next : value);
    });
    map.set(question.id, next);
    this.selected = map;
  }

  private onCustomChange(questionId: string, text: string): void {
    if (!this.interactive()) {
      return;
    }
    const map: Map<string, string> = new Map<string, string>();
    this.customText.forEach((value: string, key: string): void => {
      map.set(key, value);
    });
    map.set(questionId, text);
    this.customText = map;
  }

  private headerText(): ResourceStr {
    return this.answered ? $r('app.string.question_answered') : $r('app.string.question_waiting');
  }

  private headerColor(): ResourceStr {
    return this.answered
      ? $r('sys.color.ohos_id_color_text_secondary')
      : $r('sys.color.ohos_id_color_text_primary_activated');
  }

  /** 每题一块：header / 题干 / 补充说明 / 选项或自由文本。 */
  @Builder
  questionBlock(question: ChatQuestion) {
    Column() {
      if (question.header !== null && question.header.length > 0) {
        Text(question.header)
          .fontSize(13)
          .fontWeight(FontWeight.Medium)
          .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
          .width('100%')
      }
      Text(question.question)
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .width('100%')
        .margin({ top: 2 })
      if (question.detail !== null && question.detail.length > 0) {
        Text(question.detail)
          .fontSize(12)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .width('100%')
          .margin({ top: 2 })
      }
      if (question.options.length === 0) {
        // 没有选项 = 这题要自由文本，正好对应协议里的 custom。
        TextArea({ text: this.customText.get(question.id) ?? '', placeholder: $r('app.string.answer_your_own') })
          .width('100%')
          .constraintSize({ minHeight: 44, maxHeight: 120 })
          .enabled(this.interactive())
          .margin({ top: 4 })
          .onChange((value: string): void => {
            this.onCustomChange(question.id, value);
          })
      } else {
        ForEach(question.options, (option: QuestionOption) => {
          Row() {
            // 多选用 ☑/☐，单选用 ◉/○：字形代替 Material 的 Checkbox / RadioButton。
            Text(question.multiSelect
              ? (this.pickedLabels(question.id).has(option.label) ? '☑' : '☐')
              : (this.pickedLabels(question.id).has(option.label) ? '◉' : '○'))
              .fontSize(15)
              .width(22)
              .fontColor(this.pickedLabels(question.id).has(option.label)
                ? $r('sys.color.ohos_id_color_text_primary_activated')
                : $r('sys.color.ohos_id_color_text_secondary'))
            Column() {
              Text(option.label)
                .fontSize(14)
                .width('100%')
              if (option.description !== null && option.description.length > 0) {
                Text(option.description)
                  .fontSize(12)
                  .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                  .width('100%')
              }
            }
            .layoutWeight(1)
            .alignItems(HorizontalAlign.Start)
            .margin({ left: 4 })
          }
          .width('100%')
          .padding({ top: 4, bottom: 4 })
          .alignItems(VerticalAlign.Center)
          .opacity(this.interactive() ? 1 : 0.6)
          .onClick((): void => {
            this.toggle(question, option.label);
          })
        }, (option: QuestionOption) => `${question.id}:${option.label}`)
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
    .margin({ top: 4 })
  }

  build() {
    Column() {
      Row() {
        Text(this.answered ? '✓' : '❓')
          .fontSize(16)
          .fontColor(this.headerColor())
        Column() {
          Text(this.headerText())
            .fontSize(15)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.headerColor())
            .width('100%')
          if (this.questionSet.questions.length > 1) {
            Text($r('app.string.question_count', this.questionSet.questions.length))
              .fontSize(12)
              .fontColor($r('sys.color.ohos_id_color_text_secondary'))
              .width('100%')
          }
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
        .margin({ left: 8 })

        if (this.submitting) {
          LoadingProgress().width(20).height(20)
        }
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      ForEach(this.questionSet.questions, (question: ChatQuestion) => {
        this.questionBlock(question)
      }, (question: ChatQuestion) => question.id)

      if (!this.answered) {
        Row() {
          if (this.submitting) {
            Text($r('app.string.answer_submitting'))
              .fontSize(12)
              .fontColor($r('sys.color.ohos_id_color_text_secondary'))
              .margin({ right: 8 })
          }
          Button($r('app.string.submit_answer'))
            .type(ButtonType.Capsule)
            .height(38)
            .enabled(this.interactive() && this.complete())
            .onClick((): void => {
              this.onSubmit(buildAnswers(this.questionSet.questions, this.selected, this.customText));
            })
        }
        .width('100%')
        .margin({ top: 6 })
        .justifyContent(FlexAlign.End)
        .alignItems(VerticalAlign.Center)
      }
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 10, bottom: 10 })
    .borderRadius(10)
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
    // 边框语义照抄：未答用主色（要你注意），已答降到分隔线色（不必再看）。
    .border({
      width: 1,
      color: this.answered
        ? $r('sys.color.ohos_id_color_list_separator')
        : $r('sys.color.ohos_id_color_text_primary_activated'),
    })
  }
}

/**
 * 审批面板（`PendingApproval`）。
 *
 * `risk == "full-access"` 时是**另一套语义**：描边与图标换成警告色，并多一行
 * 「请求完整系统访问权限」。点「允许一次」时源工程会先弹二次确认对话框 ——
 * 那个对话框在本工程里由 `ChatDetail` 的 `SHEET_FULL_ACCESS` 面板承担，
 * 所以这里只负责把请求交出去（`onAllowOnce`），不自己弹。
 */
@Component
struct ApprovalPanel {
  approval: PendingApproval = new PendingApproval();
  count: number = 1;
  deciding: boolean = false;
  canWrite: boolean = false;
  onReject: () => void = (): void => {};
  onAllowOnce: () => void = (): void => {};

  /** 高风险审批：全访问。 */
  private fullAccess(): boolean {
    return this.approval.risk === 'full-access';
  }

  private interactive(): boolean {
    return this.canWrite && !this.deciding;
  }

  private accent(): ResourceStr {
    return this.fullAccess()
      ? $r('sys.color.ohos_id_color_warning')
      : $r('sys.color.ohos_id_color_text_secondary');
  }

  private subtitle(): ResourceStr {
    return this.count > 1
      ? $r('app.string.approval_count', this.approval.toolName, this.count)
      : this.approval.toolName;
  }

  build() {
    Column() {
      Row() {
        Text(this.fullAccess() ? '⚠' : '🔧')
          .fontSize(17)
          .fontColor(this.accent())
        Column() {
          Text($r('app.string.approval_required'))
            .fontSize(15)
            .fontWeight(FontWeight.Medium)
            .width('100%')
          Text(this.subtitle())
            .fontSize(12)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .width('100%')
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)
        .margin({ left: 8 })

        if (this.deciding) {
          LoadingProgress().width(20).height(20)
        }
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      if (this.approval.reason !== null && this.approval.reason.length > 0) {
        Text(this.approval.reason)
          .fontSize(12)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .width('100%')
          .margin({ top: 6 })
      }

      if (this.approval.detail !== null && this.approval.detail.length > 0) {
        Text($r('app.string.approval_command_preview'))
          .fontSize(12)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .width('100%')
          .margin({ top: 8 })
        Scroll() {
          Text(this.approval.detail as string)
            .fontSize(12)
            .fontFamily('monospace')
            .padding(8)
            .copyOption(CopyOptions.LocalDevice)
        }
        .scrollable(ScrollDirection.Vertical)
        .width('100%')
        .constraintSize({ maxHeight: COMMAND_DETAIL_MAX_HEIGHT_VP })
        .margin({ top: 4 })
        .borderRadius(6)
        .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
      }

      if (this.fullAccess()) {
        Row() {
          Text('⚠')
            .fontSize(14)
            .fontColor($r('sys.color.ohos_id_color_warning'))
          Text($r('app.string.full_access'))
            .fontSize(12)
            .fontColor($r('sys.color.ohos_id_color_warning'))
            .margin({ left: 6 })
        }
        .width('100%')
        .margin({ top: 8 })
        .alignItems(VerticalAlign.Center)
      }

      Row() {
        Button($r('app.string.reject'))
          .type(ButtonType.Capsule)
          .height(38)
          .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .enabled(this.interactive())
          .onClick((): void => {
            this.onReject();
          })
        Button($r('app.string.allow_once'))
          .type(ButtonType.Capsule)
          .height(38)
          .margin({ left: 8 })
          .enabled(this.interactive())
          .onClick((): void => {
            this.onAllowOnce();
          })
      }
      .width('100%')
      .margin({ top: 8 })
      .justifyContent(FlexAlign.End)

      // 冻结态（`DECIDING`）：用户已经点过「允许一次 / 拒绝」，按钮不能再点第二次
      // （重复提交会让内核收到两条互相矛盾的裁决）。这里照抄源工程：两个回调都传空，
      // 只把 `deciding` 置真，让面板自己把按钮置灰并显示转圈。
      if (this.deciding) {
        Text($r('app.string.approval_loading'))
          .fontSize(12)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .width('100%')
          .margin({ top: 6 })
      }
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 10, bottom: 10 })
    .borderRadius(10)
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
    .border({
      width: 1,
      color: this.fullAccess()
        ? $r('sys.color.ohos_id_color_warning')
        : $r('sys.color.ohos_id_color_list_separator'),
    })
  }
}

/** 聊天详情页：头部 + 待办 + 消息流 + 问答 + 思考条 + 审批/输入区 + 两个面板。 */
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

  /** 参数化资源 → 字符串。 */
  private fmt1(res: Resource, arg: string | number): string {
    const ctx: common.Context | undefined = this.hostContext();
    if (ctx === undefined) {
      return '';
    }
    return ctx.resourceManager.getStringSync(res.id, arg);
  }

  private toast(text: string): void {
    this.getUIContext().getPromptAction().showToast({ message: text });
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

  private refreshHistory(): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      void vm.refreshHistory();
    }
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

  /** 光标是否落在一个 `@` 提及词里 —— 决定画 `@` 面板还是 `/` 面板（互斥）。 */
  private mentioning(): boolean {
    return activeStart(this.message) !== null;
  }

  /** 会话工作目录**相对授权根**的形态；没有会话时给空串（`absolute` 认这个合法值）。 */
  private sessionCwd(): string {
    const session: ChatSession | null = this.currentSession();
    return session === null ? '' : session.cwd;
  }

  /** 会话工作目录**绝对**的形态；老服务端可能不给，此时为 null（`absolute` 会降级）。 */
  private sessionCwdAbsolute(): string | null {
    const session: ChatSession | null = this.currentSession();
    return session === null ? null : session.cwdAbsolute;
  }

  // ————————————————— 头部 —————————————————

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

  private sessionRunning(): boolean {
    const vm: HarnessViewModel | null = this.vm();
    return vm === null ? false : vm.selectedSessionRunning();
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
      this.scrollToBottom();
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
      this.composer()
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
      this.openSheet(SHEET_FULL_ACCESS);
      return;
    }
    this.decide(approval, true);
  }

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
        this.decide(items[i], true);
        return;
      }
    }
  }

  // ————————————————— 输入区（药丸） —————————————————

  private attachments(): PendingAttachment[] {
    return this.st().pendingAttachments;
  }

  private attachmentUploading(): boolean {
    return this.st().attachmentUploading;
  }

  private defaultIsSteer(): boolean {
    return resolveSendMode(this.sessionRunning(), this.st().busySendMode) === SEND_MODE_STEER;
  }

  /** 可提交 = 有写权限，且（文案可提交 或 有待发附件）。刻意**不**看全局 `busy`。 */
  private submittable(): boolean {
    return canSubmit(this.message, this.canWrite())
      || (this.canWrite() && this.attachments().length > 0);
  }

  private hint(): ResourceStr {
    const which: ComposerHint = composerHint(this.sessionRunning(), this.defaultIsSteer());
    if (which === ComposerHint.RUNNING_STEER) {
      return $r('app.string.message_hint_running_steer');
    }
    if (which === ComposerHint.RUNNING_QUEUE) {
      return $r('app.string.message_hint_running_queue');
    }
    return $r('app.string.message_hint');
  }

  private attachMenuItems(): MenuElement[] {
    return [
      {
        value: $r('app.string.attachment_pick_image'),
        action: (): void => {
          this.pickImageAttachment();
        },
      },
      {
        value: $r('app.string.attachment_pick_file'),
        action: (): void => {
          this.pickFileAttachment();
        },
      },
    ];
  }

  /**
   * 选图片。三条与源工程一致：**取消不弹提示**（用户自己关掉的选择器不是错误）、
   * 超限弹一句明白话、能读回字节才算成功。
   */
  private async pickImageAttachment(): Promise<void> {
    const ctx: common.Context | undefined = this.hostContext();
    const vm: HarnessViewModel | null = this.vm();
    if (ctx === undefined || vm === null) {
      return;
    }
    const result: PickResult = await pickImage(ctx, MAX_IMAGE_BYTES);
    if (result.failure === PickFailureKind.CANCELLED) {
      return;
    }
    if (result.failure === PickFailureKind.TOO_LARGE) {
      this.toast(this.fmt1($r('app.string.attachment_image_too_large'), formatBytes(result.limitBytes)));
      return;
    }
    if (result.failure !== null || result.file === null) {
      this.toast(this.resText($r('app.string.attachment_read_failed')));
      return;
    }
    await vm.attachImage(result.file.name, result.file.mediaType, result.file.bytes);
  }

  private async pickFileAttachment(): Promise<void> {
    const ctx: common.Context | undefined = this.hostContext();
    const vm: HarnessViewModel | null = this.vm();
    if (ctx === undefined || vm === null) {
      return;
    }
    const result: PickResult = await pickFile(ctx, MAX_FILE_BYTES);
    if (result.failure === PickFailureKind.CANCELLED) {
      return;
    }
    if (result.failure === PickFailureKind.TOO_LARGE) {
      this.toast(this.fmt1($r('app.string.attachment_file_too_large'), formatBytes(result.limitBytes)));
      return;
    }
    if (result.failure !== null || result.file === null) {
      this.toast(this.resText($r('app.string.attachment_read_failed')));
      return;
    }
    await vm.attachFile(result.file.name, result.file.bytes);
  }

  private removeAttachment(id: string): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      vm.removePendingAttachment(id);
    }
  }

  /** 提交：发送成功后立刻清空输入框（清空后 `submittable()` 自然为假，不必另设防重复提交）。 */
  private submit(steer: boolean): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm === null || !this.submittable()) {
      return;
    }
    const text: string = this.message;
    this.message = '';
    this.scrollToBottom();
    void vm.sendMessage(text, steer);
  }

  /**
   * 输入框上方的补全面板（`@` 文件 / `/` 命令），**两者互斥**。
   *
   * 源工程把这两个面板放在药丸**上方**的同一个 `Column` 里，并按「`@` 提及活跃优先、
   * 否则画命令面板」的顺序：同一时刻不可能两个都成立（`/` 只在整行以斜杠开头时出，
   * `@` 只在光标落在提及词里时出）。万一将来判据放宽，这里先立规矩 —— 斜杠优先，
   * 避免两个列表叠在一起。
   *
   * 面板的过滤 / 排序 / 限量 / 路径拼接全在 core（见 `core/ComposerSuggestions.ts`、
   * `core/MentionQuery.ts`），本组件只负责把选中结果写回输入框。
   */
  @Builder
  suggestionsArea() {
    if (this.mentioning()) {
      MentionSuggestions({
        value: this.message,
        entries: this.st().mentionEntries,
        failed: this.st().mentionFailed,
        cwd: this.sessionCwd(),
        cwdAbsolute: this.sessionCwdAbsolute(),
        onSelect: (inserted: string): void => {
          // 只替换「@…末尾」那一段：用户很可能已经写了半句「帮我看看 @xxx」，
          // 整行替换会把前半句吃掉（见 `MentionQuery.applySelection`）。
          this.message = applySelection(this.message, inserted);
        },
      })
    } else {
      CommandSuggestions({
        value: this.message,
        commands: this.st().commands,
        onSelect: (inserted: string): void => {
          // 命令面板只在整行以 `/` 开头时出现，所以这里是**整行替换**而不是追加。
          this.message = inserted;
        },
      })
    }
  }

  /**
   * 输入药丸：附件条（可横向滚）+ 加号 / 输入框 / 圆形发送键。
   *
   * 三处照抄：① 底部对齐（输入框长高时 `+` 与发送键落在底部，不飘在半空）；
   * ② 不可发送时发送键是**透明底 + 灰字**，不是整体压透明度（压了会连底色一起淡掉，
   * 看着像残废控件）；③ 运行中才把软键盘回车变成「发送」，空闲时保持换行 ——
   * 换行键也会派发 Enter 事件，所以不能拿 Enter 当发送（源工程注释里专门写过这一条）。
   */
  @Builder
  composer() {
    Column() {
      this.suggestionsArea()
      Column() {
        if (this.attachments().length > 0 || this.attachmentUploading()) {
          Scroll() {
            Row() {
              ForEach(this.attachments(), (attachment: PendingAttachment) => {
                Row() {
                  if (attachment.imageBytes !== null) {
                    AttachmentThumb({ bytes: attachment.imageBytes as Uint8Array })
                  } else {
                    Text('📄')
                      .fontSize(14)
                      .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                  }
                  Column() {
                    Text(attachment.name)
                      .fontSize(12)
                      .maxLines(1)
                      .textOverflow({ overflow: TextOverflow.Ellipsis })
                      .width('100%')
                    Text(formatBytes(attachment.sizeBytes))
                      .fontSize(10)
                      .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                      .width('100%')
                  }
                  .layoutWeight(1)
                  .alignItems(HorizontalAlign.Start)
                  .margin({ left: 6 })

                  Text('✕')
                    .fontSize(12)
                    .padding({ left: 6, right: 2 })
                    .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                    .onClick((): void => {
                      this.removeAttachment(attachment.id);
                    })
                }
                .padding({ left: 5, right: 3, top: 3, bottom: 3 })
                .borderRadius(6)
                .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
                .alignItems(VerticalAlign.Center)
                .constraintSize({ maxWidth: 200 })
              }, (attachment: PendingAttachment) => attachment.id)

              if (this.attachmentUploading()) {
                Row() {
                  LoadingProgress().width(15).height(15)
                  Text($r('app.string.attachment_uploading'))
                    .fontSize(11)
                    .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                    .margin({ left: 6 })
                }
                .padding({ left: 4, right: 4 })
                .alignItems(VerticalAlign.Center)
              }
            }
          }
          .scrollable(ScrollDirection.Horizontal)
          .width('100%')
          .padding({ top: 3, bottom: 1 })
          .scrollBar(BarState.Off)
        }

        Row() {
          if (this.canWrite()) {
            Text('＋')
              .fontSize(20)
              .width(34)
              .height(34)
              .textAlign(TextAlign.Center)
              .fontColor($r('sys.color.ohos_id_color_text_secondary'))
              .bindMenu(this.attachMenuItems())
          }

          TextArea({ text: this.message, placeholder: this.hint() })
            .layoutWeight(1)
            .constraintSize({ minHeight: 44, maxHeight: 120 })
            .fontSize(14)
            .backgroundColor(Color.Transparent)
            .borderRadius(0)
            .margin({ left: 4, right: 4 })
            .enterKeyType(this.sessionRunning() ? EnterKeyType.Send : EnterKeyType.NEW_LINE)
            .onChange((value: string): void => {
              this.message = value;
            })
            .onSubmit((): void => {
              if (this.submittable() && this.sessionRunning()) {
                this.submit(this.defaultIsSteer());
              }
            })

          Text('➤')
            .fontSize(16)
            .width(34)
            .height(34)
            .textAlign(TextAlign.Center)
            .borderRadius(17)
            .backgroundColor(this.submittable()
              ? $r('sys.color.ohos_id_color_emphasize')
              : Color.Transparent)
            .fontColor(this.submittable()
              ? $r('sys.color.ohos_id_color_foreground_contrary')
              : $r('sys.color.ohos_id_color_text_secondary'))
            .onClick((): void => {
              this.submit(this.defaultIsSteer());
            })
        }
        .width('100%')
        .alignItems(VerticalAlign.Bottom)
        // 真机实测：这一行会被上游压到 22vp（里面的 ＋/➤ 声明 34vp 却只剩 12.5vp、
        // 输入框连自己声明的 minHeight 44vp 都保不住），表现就是「输入框只剩一条缝」。
        // 用 minHeight 把下限钉死 —— 空间不够时宁可让它挤别处，也不许把输入区压瘪。
        .constraintSize({ minHeight: 48 })
      }
      .width('100%')
      .padding({ left: 4, right: 4, top: 3, bottom: 3 })
      .borderRadius(22)
      .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
      .border({ width: 1, color: $r('sys.color.ohos_id_color_list_separator') })
    }
    .width('100%')
    .padding({ left: 8, right: 8, top: 3, bottom: 3 })
  }

  // ————————————————— 面板宿主 —————————————————

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

  // ————————————————— 顶层 —————————————————

  build() {
    Column() {
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
        this.header()

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
    // 一个面板宿主（见文件头差异 1）。`isShow` 走单向：用户下拉关掉时靠 `onDisappear`
    // 复位标志，否则标志会留在 true，下一次再设 true 就不再触发。
    .bindSheet(this.sheetOpen, this.sheetContent(), {
      height: this.sheetHeight(),
      dragBar: true,
      onDisappear: (): void => {
        this.sheetOpen = false;
      },
    })
  }
}

/**
 * 附件条上的图片缩略图。
 *
 * 单成一个组件是因为解码必须落在 `aboutToAppear`：`@Builder` 里不能声明局部变量，
 * 写在表达式里就会每帧重解一次图。
 */
@Component
struct AttachmentThumb {
  bytes: Uint8Array = new Uint8Array();

  @State thumb: PixelMap | null = null;

  aboutToAppear(): void {
    this.thumb = decodeImageSync(this.bytes);
  }

  build() {
    if (this.thumb !== null) {
      Image(this.thumb)
        .width(28)
        .height(28)
        .borderRadius(4)
        .objectFit(ImageFit.Cover)
    } else {
      Text('🖼')
        .fontSize(14)
        .width(28)
        .textAlign(TextAlign.Center)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
    }
  }
}
