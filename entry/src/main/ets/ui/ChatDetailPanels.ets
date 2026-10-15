/**
 * 聊天详情页的**面板类零件** —— 从 `ui/ChatDetail.ets` 拆出（见该文件头的「拆分说明」）。
 *
 * | 组件 | 管什么 | 对应源工程 |
 * |---|---|---|
 * | `QuestionCard` | 一轮问答卡（`ask_user_question`，方案 A 只做 `continued`） | `QuestionCard`（1493–1643） |
 * | `ApprovalPanel` | 审批面板（`PendingApproval`） | `ApprovalPanel`（1319–1442） |
 * | `AttachmentThumb` | 附件条上的图片缩略图 | `AttachmentThumb` 一类的解码小件 |
 *
 * 三者都是**只吃入参、只吐回调**的叶子组件，没有任何一个拖 `ChatDetail` 的状态 ——
 * 所以它们能整体搬走而不必动调用方的状态管线。原先都不带 `export`（只给同文件的
 * `ChatDetail` 用），拆开后改成 `export struct`：跨文件引用必须显式导出。
 *
 * 两条随代码一起搬过来的判据（原写在 `ChatDetail.ets` 文件头/正文注释里）：
 *
 * 1. **问答卡按 `callId` 记住勾选与自由文本**（见 `aboutToAppear` 注释）：同一组题在重绘
 *    之间不能丢答案；换一组则从零开始，免得上一组的答案漏到下一组 —— 那是
 *    「提交上去的答案张冠李戴」这类事故。
 * 2. **图片缩略图必须单成一个组件**，因为解码要落在 `aboutToAppear`：`@Builder` 里
 *    不能声明局部变量，写在表达式里就会每帧重解一次图。
 */

import { ChatQuestion, PendingApproval, PendingQuestionSet, QuestionAnswer, QuestionOption } from '../core/Models';
import { allAnswered, buildAnswers } from '../core/QuestionAnswers';
import { decodeImageSync } from '../platform/ImageCodec';

/** 审批面板里「脱敏命令预览」的高度上限：对位源工程 `heightIn(max = 144.dp)`。 */
export const COMMAND_DETAIL_MAX_HEIGHT_VP: number = 144;

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
export struct QuestionCard {
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
export struct ApprovalPanel {
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

/**
 * 附件条上的图片缩略图。
 *
 * 单成一个组件是因为解码必须落在 `aboutToAppear`：`@Builder` 里不能声明局部变量，
 * 写在表达式里就会每帧重解一次图。
 */
@Component
export struct AttachmentThumb {
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
