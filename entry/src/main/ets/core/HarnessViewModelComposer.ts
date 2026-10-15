/**
 * 界面主状态机 —— **第 5 层：发送与附件**（从 `HarnessViewModel.ts` 拆出）。
 *
 * 一条消息从「打字」到「发出去」的全过程：发送（`sendMessage`，含**同步取走并清空**
 * 待发附件的防双击闸）、失败描述、附件入列（`attachImage` / `attachFile` /
 * `removePendingAttachment` / `clearPendingAttachments`）、运行态查询（`selectedSessionRunning` /
 * `isSessionRunning`）、几个开关（busy 发送模式 / Web 聊天 / 上下文 / dsh-ui 调试），
 * 以及大图附件的按需下载（`loadAttachmentImage`）。
 *
 * 事件层要用它的 `isSessionRunning`（判断某会话是否还在跑，决定事件是否要触发刷新）。
 *
 * 拆分来龙去脉见 `HarnessViewModel.ts`。
 */

import {
  ChatHistory,
  ChatSession,
  CommandDescriptor,
  CommandExecution,
  DshApiException,
  FileContent,
  PromptPart,
  ResolvedPath,
  UploadedAttachment,
} from './Models';
import {
  DshClient,
} from './DshClient';
import {
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  formatBytes,
  imagePart,
} from './ChatContentParts';
import {
  handoffPathOf,
} from './ChatPresentation';
import {
  isBlank,
  isNotBlank,
  trimEndText,
} from './TextPredicates';
import {
  toastText,
} from './ErrorMessages';
import {
  HarnessState,
  PendingAttachment,
  COMMAND_FAILED,
} from './HarnessTypes';
import {
  isHostCommandLine,
  distinctById,
} from './HarnessHelpers';
import { HarnessViewModelSessions } from './HarnessViewModelSessions';

export class HarnessViewModelComposer extends HarnessViewModelSessions {
  // ————————————————— 发送与附件 —————————————————

  /**
   * 发一条消息：文本 + 待发附件一起组装成 content 数组。
   *
   * `/命令` 分支只在不带附件时走 —— 命令是发给宿主的一行文本，附件跟着它没有意义；
   * 带附件时按普通消息发。
   *
   * 防重复提交靠的是**在调用线程上同步**「置闸 + 取走并清空待发内容」，**不是**靠禁用按钮：
   * 按钮的禁用状态要等下一次重组才生效，而双击的两次点击之间完全可能一次重组都没有 ——
   * 于是同一条消息（连同同一张图）发两遍。所以闸与清空必须在**任何 await 之前**同步完成；
   * 光清空附件还不够（纯文本消息没有附件可清），所以另设一个同步的 `sending` 闸兜底。
   * 之所以不能把取状态留到 await 之后做：第二次点击可能抢在它前面读到同一批附件。
   * 发送失败时把附件**与文字**一起还回输入区。
   */
  async sendMessage(text: string, steer: boolean): Promise<void> {
    const api: DshClient | null = this.client();
    if (api === null) {
      return;
    }
    const id: string | null = this.state.selectedSessionId;
    if (id === null) {
      return;
    }
    // ⚠️ 同步置闸：这一行与下面的清空都必须早于**任何 await**。
    if (this.sending) {
      return;
    }
    this.sending = true;
    try {
      // 同步取走待发附件（引用即可，不逐条拷贝）。
      const attachments: PendingAttachment[] = this.state.pendingAttachments;
      const line: string = trimEndText(text);
      if (attachments.length === 0 && isHostCommandLine(line, this.state.commands)) {
        await this.launchOperation(async (): Promise<void> => {
          const execution: CommandExecution = await api.executeCommand(id, line);
          if (execution.result.kind === 'error') {
            throw new DshApiException(409, COMMAND_FAILED,
              execution.result.text !== null ? execution.result.text : 'Command failed.');
          }
          const history: ChatHistory = await api.history(id);
          const commands: CommandDescriptor[] = await api.sessionCommands(id);
          this.update((s: HarnessState): void => {
            s.history = history;
            s.commands = commands;
          });
        });
        return;
      }
      const parts: PromptPart[] = [];
      if (isNotBlank(text)) {
        parts.push(PromptPart.text(text));
      }
      for (let i = 0; i < attachments.length; i++) {
        parts.push(attachments[i].part);
      }
      if (parts.length === 0) {
        return;
      }
      // 清空在这里做，但**原文记在局部变量里**：失败时才写回 pendingText。
      // 写成「提交时就存进 state」的话，UI 监听 pendingText 会把刚提交的正文立刻塞回输入框，
      // 用户看着就像「发了又没发」。
      this.update((s: HarnessState): void => {
        s.pendingAttachments = [];
        s.pendingText = '';
      });
      await this.launchOperation(async (): Promise<void> => {
        try {
          await api.sendMessage(id, parts, steer);
        } catch (failure) {
          // 把附件与文字都放回输入区；期间新加的条目按 id 去重，不重复。
          this.update((s: HarnessState): void => {
            s.pendingAttachments = distinctById(attachments.concat(s.pendingAttachments));
            s.pendingText = text;
          });
          this.notify(toastText('send_failed_restore', this.lang(), this.describeSendFailure(failure as Object)));
          throw failure;
        }
        this.chatSessionRefreshPending = true;
        this.scheduleChatRefresh();
      });
    } finally {
      // 无论成功、失败还是提前返回，闸都要在**这一轮结束**时放开。
      this.sending = false;
    }
  }

  /**
   * 把发送失败翻译成一句用户看得懂的话。
   *
   * 直接把 `BODY_INVALID: text is required.` 甩到屏幕上，用户能做的只有 staring。
   */
  protected describeSendFailure(failure: Object): string {
    const raw: string = this.messageOf(failure);
    if (raw.indexOf('401') >= 0 || raw.indexOf('TOKEN') >= 0) {
      return toastText('send_failed_auth', this.lang());
    }
    if (raw.indexOf('413') >= 0 || raw.indexOf('too large') >= 0) {
      return toastText('send_failed_too_large', this.lang());
    }
    if (raw.indexOf('BODY_INVALID') >= 0) {
      return toastText('send_failed_body', this.lang());
    }
    return raw;
  }

  /**
   * 把选中的图片内联进「待发附件」。
   *
   * 图片不走上传端点（内核的 image part 直接带 base64），所以这里唯一要防的就是体积：
   * 超限当场拒绝并给出可照做的提示，而不是等一个 413。
   *
   * 平台层已按 `MAX_IMAGE_BYTES + 1` 读好字节；这里只按 `bytes.length` 判定。
   */
  async attachImage(name: string, mediaType: string, bytes: Uint8Array): Promise<void> {
    if (bytes.length > MAX_IMAGE_BYTES) {
      this.notify(toastText('attachment_image_too_large', this.lang(), formatBytes(MAX_IMAGE_BYTES)));
      return;
    }
    let part: PromptPart;
    try {
      part = imagePart(mediaType, bytes, name);
    } catch (e) {
      this.notify(toastText('attachment_image_too_large', this.lang(), formatBytes(MAX_IMAGE_BYTES)));
      return;
    }
    this.update((s: HarnessState): void => {
      s.pendingAttachments = s.pendingAttachments.concat([
        new PendingAttachment(this.deps.newId(), part, name, bytes.length, bytes),
      ]);
    });
  }

  /**
   * 上传选中的文件，换回 `receiptId` 后放进「待发附件」。
   *
   * 上传是网络动作，单独一个 `attachmentUploading` 只用于显示进度；**不**参与发送键的
   * 可用性判断。
   */
  async attachFile(name: string, bytes: Uint8Array): Promise<void> {
    const api: DshClient | null = this.client();
    if (api === null) {
      return;
    }
    const sessionId: string | null = this.state.selectedSessionId;
    if (sessionId === null) {
      return;
    }
    if (bytes.length > MAX_FILE_BYTES) {
      this.notify(toastText('attachment_file_too_large', this.lang(), formatBytes(MAX_FILE_BYTES)));
      return;
    }
    this.update((s: HarnessState): void => {
      s.attachmentUploading = true;
    });
    try {
      const uploaded: UploadedAttachment = await api.uploadAttachment(sessionId, bytes, name);
      // 上传期间用户可能换了会话：附件属于发起它的那条会话，别塞到别的会话里。
      if (this.state.selectedSessionId !== sessionId) {
        return;
      }
      this.update((s: HarnessState): void => {
        s.pendingAttachments = s.pendingAttachments.concat([
          new PendingAttachment(this.deps.newId(), PromptPart.file(uploaded.receiptId),
            isBlank(uploaded.name) ? name : uploaded.name, bytes.length, null),
        ]);
      });
    } catch (failure) {
      let text: string;
      // 服务端的上限可能比客户端更严；这时不能引用我们自己的 24 MiB，否则用户会被
      // 「明明没到 24 MiB」搞糊涂。
      if (failure instanceof DshApiException && failure.code === 'TOO_LARGE') {
        text = toastText('attachment_file_rejected', this.lang());
      } else if (failure instanceof DshApiException && failure.code === 'ROUTE_NOT_FOUND') {
        text = toastText('attachment_upload_unsupported', this.lang());
      } else {
        text = this.messageOf(failure as Object);
      }
      this.update((s: HarnessState): void => {
        s.error = text;
      });
    } finally {
      this.update((s: HarnessState): void => {
        s.attachmentUploading = false;
      });
    }
  }

  /** 从待发附件里删掉一条。 */
  removePendingAttachment(id: string): void {
    this.update((s: HarnessState): void => {
      const out: PendingAttachment[] = [];
      for (let i = 0; i < s.pendingAttachments.length; i++) {
        if (s.pendingAttachments[i].id !== id) {
          out.push(s.pendingAttachments[i]);
        }
      }
      s.pendingAttachments = out;
    });
  }

  /** 清空待发附件（例如用户放弃了这条消息）。 */
  clearPendingAttachments(): void {
    this.update((s: HarnessState): void => {
      s.pendingAttachments = [];
    });
  }

  /** 当前选中的会话是否正在运行（决定「排队 / 插话」有没有区别）。 */
  selectedSessionRunning(): boolean {
    const id: string | null = this.state.selectedSessionId;
    if (id === null) {
      return false;
    }
    return this.isSessionRunning(id);
  }

  /**
   * 这个会话是否正在运行。
   *
   * 刻意不限于「当前选中的会话」：`chat.turn.end` 判「这一轮刚结束」时用的是事件里的那个
   * sessionId —— 它可能不是当前正在看的那个。会话列表里查不到时**返回 false**。
   */
  protected isSessionRunning(sessionId: string): boolean {
    const sessions: ChatSession[] = this.state.sessions;
    for (let i = 0; i < sessions.length; i++) {
      if (sessions[i].id === sessionId) {
        return sessions[i].running === true;
      }
    }
    return false;
  }

  /** 改「智能体运行时」的默认提交行为，并立刻落盘（下次启动保持）。 */
  setBusySendMode(mode: string): void {
    this.deps.preferences.busySendMode = mode;
    this.update((s: HarnessState): void => {
      s.busySendMode = mode;
    });
  }

  /** 会话详情页是否走 WebView 版。立刻生效，不需要重启。 */
  setUseWebChat(enabled: boolean): void {
    this.deps.preferences.useWebChat = enabled;
    this.update((s: HarnessState): void => {
      s.useWebChat = enabled;
    });
  }

  /** 聊天页是否显示「上下文注入」块。 */
  setShowContext(enabled: boolean): void {
    this.deps.preferences.showContext = enabled;
    this.update((s: HarnessState): void => {
      s.showContext = enabled;
    });
  }

  /** 开关 dsh-ui 诊断行；立刻生效，不需要重启。 */
  setGenUiDebug(enabled: boolean): void {
    this.deps.preferences.genUiDebug = enabled;
    this.update((s: HarnessState): void => {
      s.genUiDebug = enabled;
    });
  }

  /**
   * 按需取回一张会话图片。
   *
   * **两种来源、两条读法**，前缀就是判据：
   * - 原生附件（模型支持图片输入）：字节在服务端附件存储里，走 `readAttachment`，
   *   必须带当前会话 id；
   * - 交接图片（纯文本模型发图时插件落进工作区 `.dsh-images/` 的文件）：字节根本不在
   *   附件存储里，走官方那条「绝对路径 → 授权根」的解析与读文件，与会话无关。
   *
   * 幂等且可反复调用：已缓存的直接返回，正在取的会被 `loadingAttachments` 挡住，
   * 取失败的连同**原因**记进 `attachmentFailures` 不再重试（授权类失败除外）。
   */
  async loadAttachmentImage(attachmentId: string): Promise<void> {
    if (isBlank(attachmentId)) {
      return;
    }
    const api: DshClient | null = this.client();
    if (api === null) {
      return;
    }
    const current: HarnessState = this.state;
    // 交接图的 id 本身就是一条服务器绝对路径。
    const handoffPath: string | null = handoffPathOf(attachmentId);
    const sessionId: string | null = current.selectedSessionId;
    if (handoffPath === null && (sessionId === null || isBlank(sessionId))) {
      return;
    }
    if (current.attachmentImages.has(attachmentId)) {
      return;
    }
    // 授权类失败**不永久记住**：用户重新配对之后图就该能显示。附件真的没了（404）才记死。
    if (current.attachmentFailures.has(attachmentId) && !this.retryableAttachmentFailures.has(attachmentId)) {
      return;
    }
    if (this.loadingAttachments.has(attachmentId)) {
      return;
    }
    this.loadingAttachments.add(attachmentId);
    let bytes: Uint8Array | null = null;
    let failure: Object | null = null;
    try {
      if (handoffPath !== null) {
        bytes = await this.readHandoffImage(api, handoffPath);
      } else {
        bytes = await api.readAttachment(sessionId as string, attachmentId);
      }
    } catch (e) {
      failure = e as Object;
    }
    this.loadingAttachments.delete(attachmentId);
    if (bytes !== null) {
      const imageBytes: Uint8Array = bytes;
      this.update((s: HarnessState): void => {
        const images: Map<string, Uint8Array> = new Map<string, Uint8Array>();
        s.attachmentImages.forEach((v: Uint8Array, k: string): void => {
          images.set(k, v);
        });
        images.set(attachmentId, imageBytes);
        const failures: Map<string, string> = new Map<string, string>();
        s.attachmentFailures.forEach((v: string, k: string): void => {
          if (k !== attachmentId) {
            failures.set(k, v);
          }
        });
        s.attachmentImages = images;
        s.attachmentFailures = failures;
      });
      this.retryableAttachmentFailures.delete(attachmentId);
    } else if (failure !== null) {
      const reason: string = this.describeAttachmentFailure(failure);
      if (this.isRetryableAttachmentFailure(failure)) {
        this.retryableAttachmentFailures.add(attachmentId);
      }
      this.update((s: HarnessState): void => {
        const failures: Map<string, string> = new Map<string, string>();
        s.attachmentFailures.forEach((v: string, k: string): void => {
          failures.set(k, v);
        });
        failures.set(attachmentId, reason);
        s.attachmentFailures = failures;
      });
    }
  }

  /**
   * 读一张**交接图片**（纯文本模型发图时落进会话工作区 `.dsh-images/` 的那份）。
   *
   * 用官方那条现成的路：`resolvePath` 把服务器绝对路径解析成「授权根 + 相对路径」，
   * 再 `readFile` 取字节。解析不出来就按失败上报。
   */
  protected async readHandoffImage(api: DshClient, path: string): Promise<Uint8Array> {
    const resolved: ResolvedPath | null = await api.resolvePath(path);
    if (resolved === null) {
      throw new DshApiException(404, 'PATH_OUTSIDE_ROOTS', `PATH_OUTSIDE_ROOTS: ${path}`);
    }
    const content: FileContent = await api.readFile(resolved.rootId, resolved.path);
    return content.bytes;
  }

  /**
   * 这类失败在重新配对后可能自愈，因此允许重试。
   *
   * 判据是**病因**而不是错误码：401/403 是授权状态问题，换一次配对就好了；
   * 404 是服务端确实没有这份字节，再试一百次也一样。
   */
  protected isRetryableAttachmentFailure(failure: Object): boolean {
    const raw: string = this.messageOf(failure);
    return raw.indexOf('401') >= 0 || raw.indexOf('403') >= 0 || raw.indexOf('TOKEN') >= 0
      || raw.indexOf('SCOPE') >= 0 || raw.indexOf('FORBIDDEN') >= 0;
  }

  /** 把取图失败翻译成一句能照做的提示。 */
  protected describeAttachmentFailure(failure: Object): string {
    const raw: string = this.messageOf(failure);
    if (raw.indexOf('PATH_OUTSIDE_ROOTS') >= 0 || raw.indexOf('PATH_NOT_FOUND') >= 0
      || raw.indexOf('PATH_NOT_ABSOLUTE') >= 0) {
      return toastText('attachment_fail_outside_roots', this.lang());
    }
    if (raw.indexOf('401') >= 0 || raw.indexOf('TOKEN') >= 0) {
      return toastText('attachment_fail_auth', this.lang());
    }
    if (raw.indexOf('403') >= 0 || raw.indexOf('SCOPE') >= 0 || raw.indexOf('FORBIDDEN') >= 0) {
      return toastText('attachment_fail_scope', this.lang());
    }
    if (raw.indexOf('404') >= 0 || raw.indexOf('NOT_FOUND') >= 0) {
      return toastText('attachment_fail_missing', this.lang());
    }
    return toastText('attachment_fail_other', this.lang(), raw);
  }
}
