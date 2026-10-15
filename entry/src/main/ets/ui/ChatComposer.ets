/**
 * 聊天详情页的**输入区（药丸）+ 补全面板** —— 从 `ui/ChatDetail.ets` 拆出
 * （见该文件头的「拆分说明」）。
 *
 * | 装什么 | 对应源工程 |
 * |---|---|
 * | 输入药丸：附件条 + `＋` / 输入框 / 圆形发送键 | `Composer`（1645–1866） |
 * | 药丸上方的 `@` / `/` 补全面板（互斥） | `MentionSuggestions` / `CommandSuggestions` |
 *
 * ## 状态与装饰器（违反会出「点了没反应 / 数据不更新」的真缺陷）
 *
 * - `message`（输入框原文）的**唯一数据源在 `ChatDetail`**（父组件）：本组件用 `@Link` 双向
 *   绑定，因为输入框的 `onChange` 与补全面板的选中结果都要把新值写回去。
 * - **`onChange` 里显式回调 `onMessageEdited()`**：父组件的 `message` 上挂着
 *   `@Watch('onMessageChanged')`（它把「补全面板是否开着」推给 ViewModel）。值经 `@Link`
 *   写回父组件的 `@State` 后，`@Watch` **不保证**会被触发；这里主动回调一次父组件的
 *   `syncComposerOverlay()`，不依赖 `@Watch`。vm 侧对这次同步是幂等的，重复调用无副作用。
 * - `onScrollToBottom` / `onMessageEdited` 是普通成员（函数类型不用 `@Prop`）。
 * - 其余判据（`canWrite` / `sessionRunning` / `@`·`/` 面板的可见性）都由本组件经
 *   `st()` / `vm()` 现算，不复制父组件的 `@State`。
 */
import { common } from '@kit.AbilityKit';
import { ChatSession } from '../core/Models';
import { HarnessState, HarnessViewModel, PendingAttachment } from '../core/HarnessViewModel';
import { ComposerHint, composerHint } from '../core/ComposerPill';
import { SEND_MODE_STEER, canSubmit, resolveSendMode } from '../core/ComposerSendPolicy';
import { activeStart, applySelection } from '../core/MentionQuery';
import { MAX_FILE_BYTES, MAX_IMAGE_BYTES, formatBytes } from '../core/ChatContentParts';
import { PickFailureKind, PickResult, pickFile, pickImage } from '../platform/Pickers';
import { harnessState, harnessVm } from './AppRuntime';
import { AttachmentThumb } from './ChatDetailPanels';
import { CommandSuggestions, MentionSuggestions } from './ComposerSuggestions';

/** 聊天详情页的输入药丸 + 补全面板。 */
@Component
export struct ChatComposer {
  /** 输入框原文：唯一数据源在 `ChatDetail`，这里与它（以及 `ChatHeaderPanelHost`）共享同一份。 */
  @Link message: string;

  // ——— 交回父组件的动作（函数类型用普通成员）———
  /** 滚到会话尾部（原 `ChatDetail.scrollToBottom`）：发送成功后要用。 */
  onScrollToBottom: () => void = (): void => {};
  /**
   * 输入框内容变过一次：请父组件同步「补全面板是否开着」。
   *
   * 为什么不只靠父组件的 `@Watch`：见文件头「状态与装饰器」第 2 条。
   */
  onMessageEdited: () => void = (): void => {};

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

  // ————————————————— 输入区（药丸） —————————————————

  private sessionRunning(): boolean {
    const vm: HarnessViewModel | null = this.vm();
    return vm === null ? false : vm.selectedSessionRunning();
  }

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
    this.onScrollToBottom();
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
              // `message` 经 `@Link` 写回父组件的 `@State` 后，父组件的
              // `@Watch('onMessageChanged')` 不保证被触发（见文件头「状态与装饰器」）；
              // 这里显式回调一次，保证「补全面板是否开着」照样推给 ViewModel。
              this.onMessageEdited();
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

  /** 输入区（药丸 + 补全面板）。审批态为 `NONE` 时由 `ChatDetail.approvalArea` 装配。 */
  build() {
    Column() {
      this.composer()
    }
    .width('100%')
  }
}