/**
 * 界面主状态机 —— **第 1 层：核心**（从 `HarnessViewModel.ts` 拆出）。
 *
 * 装的是「所有层都要用的那一小撮」：私有字段与构造、对外订阅（`subscribe` / `revision`）、
 * 就地改状态的 `update` / `notifyListeners`、连接闸门与连接上下文（`client` / `lang` /
 * `hasScope` / `notify`），以及三个**被所有调用方复用**的执行壳：
 *
 * | 成员 | 作用 |
 * | --- | --- |
 * | `withClient` | 「没连接就静默返回」+ 统一的 busy/错误收尾 |
 * | `launchOperation` | busy 置起、异常 → 文案、busy 落下 |
 * | `scheduleChatRefresh`（含循环） | 400ms 静默窗口后只拉一次 history |
 * | `sleep` | 用注入的定时器等一会儿（可被 `dispose` 取消） |
 * | `messageOf` | 异常 → 给人看的句子（三层：错误码 / 不可达 / 网络） |
 *
 * ## 为什么这几件在最底层
 *
 * 它们是**横向依赖**：`withClient` / `messageOf` / `scheduleChatRefresh` 会被后面几乎每一层
 * 调用。ArkTS 里跨文件共享私有状态只有"继承"一条路，而继承是**单向**的 ——
 * 所以被所有人依赖的东西必须排在最前面，否则后面的层就没法引用它。
 *
 * 拆分来龙去脉见 `HarnessViewModel.ts`。
 */

import {
  ChatHistory,
  ChatSession,
  DeviceView,
  DshApiException,
} from './Models';
import {
  DshClient,
} from './DshClient';
import {
  ActiveConnection,
  DshConnectionException,
} from './ConnectionCoordinator';
import {
  NetworkException,
  allEndpointsUnreachableText,
  localizedErrorText,
  networkErrorText,
} from './ErrorMessages';
import {
  HarnessState,
} from './HarnessTypes';
import { HarnessDeps } from './HarnessHelpers';
import {
  LiveKey,
} from './HarnessHelpers';

export class HarnessViewModelBase {
  protected deps: HarnessDeps;
  /** 正在下载中的附件 id。界面每次组合都会调 loadAttachmentImage，靠它去重。 */
  protected loadingAttachments: Set<string> = new Set<string>();
  /**
   * 因**授权**失败的附件 id：允许重试。
   *
   * 与 `HarnessState.attachmentFailures` 分开，是因为「记住失败」和「允许重试」两件事
   * 不能共用一个容器。
   */
  protected retryableAttachmentFailures: Set<string> = new Set<string>();
  /**
   * 同步发送闸（防双击）。
   *
   * 与「禁用发送按钮」是两回事：按钮的禁用状态要等下一次重组才生效，而双击的两次点击
   * 之间完全可能一次重组都没有；这个布尔量在 `sendMessage` 的第一行就同步置起，
   * 因此第二次点击进来时已经被挡住。
   */
  protected sending: boolean = false;

  /** 对外共享状态（就地改，不重建）。 */
  state: HarnessState;
  /** 每次 `update` 自增，供监听者/界面判断「变了」。 */
  revision: number = 0;
  protected listeners: (() => void)[] = [];

  /**
   * 连接页门闩：**进程级**，刻意不放进 `HarnessState`。
   *
   * `HarnessState` 在三个地方被整份重建（初始、disconnect、loadSnapshot），
   * 把门闩塞进那份状态，连上之后就会被重建冲掉 —— 用户看到的是「刚进聊天页又被弹回
   * 连接页」。放这里则只有一个来源能改变它：`passConnectGate()`。
   */
  connectGate: boolean = false;

  /** 当前活跃连接。null 表示未连接。 */
  protected active: ActiveConnection | null = null;
  protected eventSubscription: { close(): void } | null = null;
  /**
   * 事件流是否因熄屏而主动暂停。
   *
   * 用它区分「用户主动断开」与「熄屏暂停」：前者 `active` 已被清空、不该被 resumeEvents
   * 复活；后者连接还在，亮屏就该接回去。
   */
  protected eventsPaused: boolean = false;
  protected chatRefreshActive: boolean = false;
  protected chatRefreshPending: boolean = false;
  protected chatSessionRefreshPending: boolean = false;
  protected liveFinalizeTarget: LiveKey | null = null;
  /** 未触发的定时器句柄，`dispose()` 时一次性取消。 */
  protected timerHandles: number[] = [];
  protected disposed: boolean = false;

  constructor(deps: HarnessDeps) {
    this.deps = deps;
    this.state = new HarnessState();
    this.applyPreferences(this.state);
    // Kotlin 的 init { restoreConnection() }。
    // 注意：实现排在继承链**最后一层**（`HarnessViewModelConnection.restoreConnection`），
    // 直接 `this.restoreConnection()` 会让最底层反向依赖最后一层、继承链成环；
    // 所以基类只调一个**可覆盖的钩子**，由最后一层把它转发给真正的实现。
    // 语义与 Kotlin 一致：构造末尾异步发起一次恢复，不等待。
    void this.startRestore();
  }

  /**
   * 启动恢复的钩子 —— 空实现，由继承链最后一层覆盖（见上）。
   * 单独成方法是为了让"构造时触发恢复"这件事不必把最后一层拉进基类。
   */
  protected startRestore(): void {
  }

  // ————————————————— 对外订阅 —————————————————

  subscribe(listener: () => void): () => void {
    this.listeners.push(listener);
    const self: HarnessViewModelBase = this;
    return (): void => {
      const at: number = self.listeners.indexOf(listener);
      if (at >= 0) {
        self.listeners.splice(at, 1);
      }
    };
  }

  protected notifyListeners(): void {
    const copy: (() => void)[] = this.listeners.slice();
    for (let i = 0; i < copy.length; i++) {
      copy[i]();
    }
  }

  /**
   * 就地改状态 + `revision++` + 通知监听者（对应 Kotlin 的 `MutableStateFlow.update`）。
   */
  protected update(fn: (s: HarnessState) => void): void {
    fn(this.state);
    this.revision = this.revision + 1;
    this.notifyListeners();
  }

  /** 把偏好里存着的设置盖到状态上（三处整份重建都必须调它，漏一处设置就会「变回去」）。 */
  protected applyPreferences(s: HarnessState): void {
    s.busySendMode = this.deps.preferences.busySendMode;
    s.genUiDebug = this.deps.preferences.genUiDebug;
    s.useWebChat = this.deps.preferences.useWebChat;
    s.showContext = this.deps.preferences.showContext;
  }

  /** 放行连接页，进入 App（幂等）。只由用户的主动动作调用。 */
  passConnectGate(): void {
    if (this.connectGate) {
      return;
    }
    this.connectGate = true;
    // 这一行**不能省**：界面的切页判据（`Index.showConnect()`）读的就是 `vm.connectGate`，
    // 而界面重绘靠的是 `revision`（`AppStorage` 那个 `dshRevision` 键，见 AppRuntime）。
    // 源工程里它是 `MutableStateFlow`，赋值天然通知订阅者（Compose 重组）；移植成普通字段后
    // 通知语义丢了 —— 只改字段不通知，用户点「进入应用」后门闩已经放行、界面却纹丝不动，
    // 表现就是「点了没反应 / 不进入下一个页面」（真机踩坑，见 PORT-MAP 坑 19）。
    // 传空变换：本次不改任何状态字段，只需要那一次「变了」的通知。
    this.update((_s: HarnessState): void => {
    });
  }

  /** 当前活跃连接；null 表示未连接。只读暴露，供 WebView 版聊天页复用同一条链路。 */
  activeConnection(): ActiveConnection | null {
    return this.active;
  }

  protected client(): DshClient | null {
    return this.active === null ? null : this.active.client;
  }

  protected lang(): string {
    return this.deps.languageTag();
  }

  /** 走全局错误通道（界面层转成 snackbar）；文案在这里就已经是人话。 */
  protected notify(message: string): void {
    this.update((s: HarnessState): void => {
      s.error = message;
    });
  }

  protected hasScope(scope: string): boolean {
    const device: DeviceView | null = this.state.device;
    if (device === null) {
      return false;
    }
    for (let i = 0; i < device.scopes.length; i++) {
      if (device.scopes[i] === scope) {
        return true;
      }
    }
    return false;
  }

  /**
   * 400ms **去抖**，不是轮询周期。
   *
   * 旧实现是 `delay(1_000)` 之后回 while 条件，而**每一个事件帧都会把 chatRefreshPending
   * 重新置 true**。于是模型流式输出期间，这一秒内只要来过任何一帧，循环就继续转 —— 实际
   * 表现是**整个流式期间每秒拉一次全量 history**。用户侧的体感就是「一用 APP 电量掉得快」。
   *
   * 现在改成：等到**安静 400ms** 才拉一次，且一轮只拉一次。流式输出期间事件不断到来，
   * 窗口一直被重置、任务一直不起跑；等这一轮消息落定、事件安静下来，才做那唯一一次
   * history()。400ms 是取舍：短于它会漏掉「最后一条消息落盘」的信号，长于它用户会看到
   * 正文延迟。liveChat 的 delta 推送不受这个窗口影响。
   */
  protected scheduleChatRefresh(): void {
    this.chatRefreshPending = true;
    if (this.chatRefreshActive) {
      return;
    }
    this.chatRefreshActive = true;
    const self: HarnessViewModelBase = this;
    // 句柄必须记下来：`dispose()` 要把它（以及下面 `sleep` 里的那一批）一次性取消，
    // 否则页面销毁后这个定时器还会醒过来、去访问已经作废的连接。Kotlin 侧靠
    // `viewModelScope` 自动取消，这里得自己管。
    const handle: number = this.deps.timers.schedule(400, (): void => {
      void self.runChatRefresh();
    });
    this.timerHandles.push(handle);
  }

  protected async runChatRefresh(): Promise<void> {
    try {
      await this.chatRefreshLoop();
    } finally {
      this.chatRefreshActive = false;
    }
  }

  protected async chatRefreshLoop(): Promise<void> {
    while (this.chatRefreshPending || this.chatSessionRefreshPending) {
      this.chatRefreshPending = false;
      const refreshSessions: boolean = this.chatSessionRefreshPending;
      this.chatSessionRefreshPending = false;
      const finalizeTarget: LiveKey | null = this.liveFinalizeTarget;
      this.liveFinalizeTarget = null;
      const api: DshClient | null = this.client();
      if (api === null) {
        break;
      }
      const id: string | null = this.state.selectedSessionId;
      if (id !== null) {
        let history: ChatHistory | null = null;
        try {
          history = await api.history(id);
        } catch (error) {
          if (!(error instanceof DshApiException && error.code === 'RATE_LIMITED')) {
            const err: Object = error as Object;
            this.update((s: HarnessState): void => {
              s.error = this.messageOf(err);
            });
          } else {
            if (finalizeTarget !== null) {
              this.liveFinalizeTarget = finalizeTarget;
            }
            this.chatRefreshPending = true;
          }
        }
        if (history !== null) {
          const got: ChatHistory = history;
          if (this.state.selectedSessionId === id) {
            this.update((s: HarnessState): void => {
              let clearLive: boolean = false;
              if (finalizeTarget !== null && s.liveChat !== null) {
                clearLive = s.liveChat.sessionId === finalizeTarget.sessionId
                  && s.liveChat.turn === finalizeTarget.turn
                  && s.liveChat.step === finalizeTarget.step;
              }
              s.history = got;
              if (clearLive) {
                s.liveChat = null;
              }
            });
          }
        }
      }
      if (refreshSessions) {
        let sessions: ChatSession[] | null = null;
        try {
          sessions = await api.sessions();
        } catch (error) {
          if (error instanceof DshApiException && error.code === 'RATE_LIMITED') {
            this.chatSessionRefreshPending = true;
          } else {
            const err: Object = error as Object;
            this.update((s: HarnessState): void => {
              s.error = this.messageOf(err);
            });
          }
        }
        if (sessions !== null) {
          const got: ChatSession[] = sessions;
          this.update((s: HarnessState): void => {
            s.sessions = got;
          });
        }
      }
      // 限流重试之外的正常路径到这里就该收工了。保留一个短的「再确认一次」窗口：
      // 处理 history 的这段时间里可能又来了新帧。
      await this.sleep(400);
      if (!this.chatRefreshPending && !this.chatSessionRefreshPending) {
        break;
      }
    }
  }

  /** 用注入的定时器睡一觉（对应 Kotlin `delay(ms)`）。 */
  protected sleep(ms: number): Promise<void> {
    const self: HarnessViewModelBase = this;
    return new Promise<void>((resolve: () => void): void => {
      let handle: number = -1;
      handle = self.deps.timers.schedule(ms, (): void => {
        const at: number = self.timerHandles.indexOf(handle);
        if (at >= 0) {
          self.timerHandles.splice(at, 1);
        }
        resolve();
      });
      self.timerHandles.push(handle);
    });
  }

  protected async withClient(block: (api: DshClient) => Promise<void>): Promise<void> {
    const api: DshClient | null = this.client();
    if (api === null) {
      return;
    }
    await this.launchOperation(async (): Promise<void> => {
      await block(api);
    });
  }

  protected async launchOperation(block: () => Promise<void>): Promise<void> {
    this.update((s: HarnessState): void => {
      s.busy = true;
      s.error = null;
    });
    try {
      await block();
    } catch (e) {
      const failure: Object = e as Object;
      this.update((s: HarnessState): void => {
        s.error = this.messageOf(failure);
      });
    }
    this.update((s: HarnessState): void => {
      s.busy = false;
    });
  }

  /**
   * 异常 → 给人看的句子。分三层：
   *
   * 1. `DshApiException`（服务端错误码）→ 按码查本地化表；认不出**保留原文**。
   * 2. `DshConnectionException` → 「全部地址不可达」的本地化句（携带全部探活原因）。
   * 3. `NetworkException`（平台层把错误码翻译成 `NetworkFailureKind` 再抛）→ 按类型本地化。
   *    安卓那 7 个 `IOException` 分支（超时/未知主机/连接被拒/SSL/Socket/EOF/其他）在这里
   *    **有意收敛成一条** —— 平台层已把病因归好类，core 不必认识那些平台异常类。
   * 4. 其余未知异常 → 保留原文，能搜能贴给开发者（与错误码表「认不出不硬猜」同一原则）。
   */
  protected messageOf(error: Object): string {
    if (error instanceof DshApiException) {
      const text: string | null = localizedErrorText(error.code, this.lang());
      return text === null ? error.message : text;
    }
    if (error instanceof DshConnectionException) {
      return allEndpointsUnreachableText(this.lang());
    }
    if (error instanceof NetworkException) {
      return networkErrorText(error.kind, this.lang(), error.detail);
    }
    if (error instanceof Error) {
      if (error.message.length > 0) {
        return error.message;
      }
      return error.name.length > 0 ? error.name : 'Error';
    }
    return 'unknown failure';
  }
}
