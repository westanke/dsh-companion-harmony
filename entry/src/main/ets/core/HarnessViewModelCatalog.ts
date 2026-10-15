/**
 * 界面主状态机 —— **第 2 层：命令 / 模型 / 供应商 / 插件**（从 `HarnessViewModel.ts` 拆出）。
 *
 * 装的是「会话界面之外的那些**清单类刷新**」：可用命令（斜杠补全的数据源）、
 * 权限预设、会话模型与推理档位、Agent 预设、供应商设置与自定义供应商、插件清单与开关、
 * 以及中断当前运行（`cancelRun`）。
 *
 * 这一层排在前面是因为会话层（第 4 层）要用它的 `refreshCommands` /
 * `refreshSessionModels` / `refreshPendingApprovals` / `refreshPendingQuestions`
 * —— 见 `HarnessViewModel.ts` 文件头的继承链说明。
 *
 * 拆分来龙去脉见 `HarnessViewModel.ts`。
 */

import {
  ChatHistory,
  ChatSession,
  CommandDescriptor,
  CommandExecution,
  CustomProviderCreate,
  DshApiException,
  ModelSelection,
  PendingApproval,
  PendingQuestionSet,
  PluginInventory,
  ProviderModel,
  ProviderPatch,
  ProviderSettings,
  QuestionAnswer,
  SessionModels,
} from './Models';
import {
  DshClient,
} from './DshClient';
import {
  toastText,
} from './ErrorMessages';
import {
  HarnessState,
  ApprovalUiKind,
  ApprovalUiState,
  COMMAND_FAILED,
} from './HarnessTypes';
import { HarnessViewModelBase } from './HarnessViewModelBase';

export class HarnessViewModelCatalog extends HarnessViewModelBase {
  // ————————————————— 命令 / 模型 / 供应商 / 插件 —————————————————

  async refreshCommands(): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const id: string | null = this.state.selectedSessionId;
      if (id === null) {
        return;
      }
      const commands: CommandDescriptor[] = await api.sessionCommands(id);
      this.update((s: HarnessState): void => {
        s.commands = commands;
      });
    });
  }

  async selectPermissionPreset(preset: string): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const id: string | null = this.state.selectedSessionId;
      if (id === null) {
        return;
      }
      const execution: CommandExecution = await api.executeCommand(id, `/permission ${preset}`);
      if (execution.result.kind === 'error') {
        throw new DshApiException(409, COMMAND_FAILED,
          execution.result.text !== null ? execution.result.text : 'Permission change failed.');
      }
      const history: ChatHistory = await api.history(id);
      const commands: CommandDescriptor[] = await api.sessionCommands(id);
      this.update((s: HarnessState): void => {
        s.history = history;
        s.commands = commands;
      });
    });
  }

  async refreshSessionModels(): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const id: string | null = this.state.selectedSessionId;
      if (id === null) {
        return;
      }
      const models: SessionModels = await api.sessionModels(id);
      this.update((s: HarnessState): void => {
        s.sessionModels = models;
      });
    });
  }

  async selectModel(selection: ModelSelection): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const id: string | null = this.state.selectedSessionId;
      if (id === null) {
        return;
      }
      await api.selectModel(id, selection);
      const models: SessionModels = await api.sessionModels(id);
      this.update((s: HarnessState): void => {
        s.sessionModels = models;
      });
    });
  }

  async selectAgentPreset(agentPreset: string): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const id: string | null = this.state.selectedSessionId;
      if (id === null) {
        return;
      }
      await api.selectAgentPreset(id, agentPreset);
      const sessions: ChatSession[] = await api.sessions();
      const models: SessionModels = await api.sessionModels(id);
      const commands: CommandDescriptor[] = await api.sessionCommands(id);
      this.update((s: HarnessState): void => {
        s.sessions = sessions;
        s.sessionModels = models;
        s.commands = commands;
      });
    });
  }

  async refreshProviderSettings(): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      if (!this.hasScope('settings.read')) {
        return;
      }
      const settings: ProviderSettings = await api.providerSettings();
      this.update((s: HarnessState): void => {
        s.providerSettings = settings;
      });
    });
  }

  async refreshPluginInventory(): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      if (!this.hasScope('settings.read')) {
        return;
      }
      const inventory: PluginInventory = await api.pluginInventory();
      this.update((s: HarnessState): void => {
        s.pluginInventory = inventory;
      });
    });
  }

  /**
   * 带版本检查地刷新插件清单（用户主动点「检查更新」时）。
   *
   * 单独一条路而不是给 refreshPluginInventory 加参数：版本检查要给每个已装包发一次
   * registry 请求，清单会从毫秒级变成好几秒。默认那条必须保持轻快。
   */
  async refreshPluginInventoryWithUpdates(): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      if (!this.hasScope('settings.read')) {
        return;
      }
      const inventory: PluginInventory = await api.pluginInventoryWithUpdates();
      this.update((s: HarnessState): void => {
        s.pluginInventory = inventory;
      });
    });
  }

  /**
   * 启用 / 停用一个插件。
   *
   * 走 launchOperation：全局 busy 把按钮禁掉，重复点击不会连发两次写请求（这是改
   * profile 的 package.json 的操作）；失败统一落进既有错误通道。
   * 成功后**必须重拉清单**，否则开关会弹回原位。
   */
  async setPluginLoaded(name: string, loaded: boolean): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      if (!this.hasScope('settings.write')) {
        this.notify(toastText('plugins_write_permission_required', this.lang()));
        return;
      }
      const result = await api.setPluginLoaded(name, loaded);
      const inventory: PluginInventory = await api.pluginInventory();
      this.update((s: HarnessState): void => {
        s.pluginInventory = inventory;
      });
      if (result.restartRequired) {
        this.notify(toastText('plugins_toggle_saved', this.lang()));
      }
    });
  }

  async updateProvider(providerId: string, patch: ProviderPatch): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const settings: ProviderSettings = await api.updateProvider(providerId, patch);
      this.update((s: HarnessState): void => {
        s.providerSettings = settings;
        s.discoveredModels = [];
      });
    });
  }

  async createCustomProvider(provider: CustomProviderCreate): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const settings: ProviderSettings = await api.createCustomProvider(provider);
      this.update((s: HarnessState): void => {
        s.providerSettings = settings;
        s.discoveredModels = [];
      });
    });
  }

  async discoverModels(providerId: string, baseURL: string | null, protocol: string | null,
                       apiKey: string | null): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const models: ProviderModel[] = await api.discoverModels(providerId, baseURL, protocol, apiKey);
      this.update((s: HarnessState): void => {
        s.discoveredModels = models;
      });
    });
  }

  clearDiscoveredModels(): void {
    this.update((s: HarnessState): void => {
      s.discoveredModels = [];
    });
  }

  async cancelRun(): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const id: string | null = this.state.selectedSessionId;
      if (id === null) {
        return;
      }
      await api.cancel(id);
      this.chatSessionRefreshPending = true;
      this.scheduleChatRefresh();
    });
  }

  async refreshPendingApprovals(): Promise<void> {
    const api: DshClient | null = this.client();
    if (api === null) {
      return;
    }
    const id: string | null = this.state.selectedSessionId;
    if (id === null) {
      return;
    }
    let approvals: PendingApproval[] | null = null;
    let failure: Object | null = null;
    try {
      approvals = await api.pendingApprovals(id);
    } catch (e) {
      failure = e as Object;
    }
    if (this.state.selectedSessionId !== id) {
      return;
    }
    if (approvals !== null) {
      this.update((s: HarnessState): void => {
        s.approvalState = approvals.length === 0
          ? ApprovalUiState.none() : ApprovalUiState.pending(approvals);
      });
    } else {
      this.update((s: HarnessState): void => {
        s.approvalState = ApprovalUiState.none();
        s.error = failure instanceof DshApiException && failure.code === 'RATE_LIMITED'
          ? null : this.messageOf(failure);
      });
    }
  }

  /**
   * 取当前会话的待回答问题。
   *
   * **只对当前选中的会话调**，一次一个 GET。插件的 `resolveAgent` 是「resolve **or
   * resume**」，对冷会话调会把那边已经停下的 Agent 拉活 —— 所以这里永远只看
   * `selectedSessionId`，绝不遍历 sessions，也不做任何后台轮询。
   *
   * 失败**刻意静默**：这条路会挂在全轮的 turn 事件上，插件版本旧（404）或一次网络抖都会
   * 失败；把错误塞进 snackbar 就等于每轮弹一次。列表也**保留原样**不清空。
   */
  async refreshPendingQuestions(): Promise<void> {
    const api: DshClient | null = this.client();
    if (api === null) {
      return;
    }
    const id: string | null = this.state.selectedSessionId;
    if (id === null) {
      return;
    }
    let sets: PendingQuestionSet[] | null = null;
    try {
      sets = await api.pendingQuestions(id);
    } catch (e) {
      sets = null;
    }
    // 期间用户可能已经切走：这份结果只对发起它的那个会话有效。
    if (this.state.selectedSessionId !== id) {
      return;
    }
    if (sets !== null) {
      const list: PendingQuestionSet[] = sets;
      const kept: PendingQuestionSet[] = [];
      for (let i = 0; i < list.length; i++) {
        // `state === continued`：内核已经继续跑了，答复属于**补交**而不是阻塞应答。
        // 其余状态（error/answered/…）再怎么答也没有意义，不该占着界面。
        if (list[i].isAnswerable()) {
          kept.push(list[i]);
        }
      }
      this.update((s: HarnessState): void => {
        s.questions = kept;
      });
    }
  }

  /**
   * 回答一组问题（`ask_user_question`）。
   *
   * 防重复提交两道闸：本地 `answeringCallId` 非空时直接忽略后续点击，已经答过的 callId
   * 也不再发；插件的 409 是最后一道防线，但不该让用户点到那一步。
   */
  async answerQuestions(callId: string, answers: QuestionAnswer[]): Promise<void> {
    const api: DshClient | null = this.client();
    if (api === null) {
      return;
    }
    const id: string | null = this.state.selectedSessionId;
    if (id === null) {
      return;
    }
    // 闸一：已有提交在飞。
    if (this.state.answeringCallId !== null) {
      return;
    }
    // 闸二：这一组已经答过。
    if (this.state.answeredCallIds.has(callId)) {
      return;
    }
    this.update((s: HarnessState): void => {
      s.answeringCallId = callId;
      s.error = null;
    });
    let failure: Object | null = null;
    try {
      await api.answerQuestions(id, callId, answers);
    } catch (e) {
      failure = e as Object;
    }
    if (this.state.selectedSessionId !== id) {
      return;
    }
    if (failure === null) {
      this.update((s: HarnessState): void => {
        s.answeringCallId = null;
        const answered: Set<string> = new Set<string>();
        s.answeredCallIds.forEach((v: string): void => {
          answered.add(v);
        });
        answered.add(callId);
        s.answeredCallIds = answered;
      });
      // 问一次服务端：答复被内核吃掉了的话，这条问题就该从列表里消失。
      await this.refreshPendingQuestions();
    } else {
      const err: Object = failure;
      this.update((s: HarnessState): void => {
        s.answeringCallId = null;
        s.error = this.describeAnswerFailure(err);
      });
    }
  }

  /**
   * 提交失败的人话。
   *
   * 插件用 409 区分两种**完全不同**的情况：答复已经在队列里（你答过了）与问题已经不作答
   * （这条作废了）。把 code 原样甩给用户，他既看不懂也不知道该不该重试。
   */
  protected describeAnswerFailure(failure: Object): string {
    if (failure instanceof DshApiException && failure.code === 'QUESTION_REPLY_QUEUED') {
      return toastText('answer_already_queued', this.lang());
    }
    if (failure instanceof DshApiException && failure.code === 'QUESTION_NOT_PENDING') {
      return toastText('answer_not_pending', this.lang());
    }
    if (failure instanceof DshApiException && (failure.status === 403
      || failure.code.indexOf('FORBIDDEN') >= 0 || failure.code.indexOf('SCOPE') >= 0)) {
      return toastText('answer_no_write', this.lang());
    }
    return toastText('answer_failed', this.lang(), this.messageOf(failure));
  }

  async decideApproval(approval: PendingApproval, allowOnce: boolean): Promise<void> {
    const api: DshClient | null = this.client();
    if (api === null) {
      return;
    }
    const id: string | null = this.state.selectedSessionId;
    if (id === null) {
      return;
    }
    if (approval.sessionId !== id) {
      return;
    }
    const current: ApprovalUiState = this.state.approvalState;
    let items: PendingApproval[];
    if (current.kind === ApprovalUiKind.PENDING || current.kind === ApprovalUiKind.DECIDING) {
      items = current.items;
    } else {
      items = [approval];
    }
    this.update((s: HarnessState): void => {
      s.approvalState = ApprovalUiState.deciding(approval, items);
      s.error = null;
    });
    let approvals: PendingApproval[] | null = null;
    let sessions: ChatSession[] | null = null;
    let failure: Object | null = null;
    try {
      await api.decideApproval(id, approval.id, allowOnce);
      approvals = await api.pendingApprovals(id);
      sessions = await api.sessions();
    } catch (e) {
      failure = e as Object;
    }
    if (this.state.selectedSessionId === id) {
      if (approvals !== null && sessions !== null) {
        const nextApprovals: PendingApproval[] = approvals;
        const nextSessions: ChatSession[] = sessions;
        this.update((s: HarnessState): void => {
          s.approvalState = nextApprovals.length === 0
            ? ApprovalUiState.none() : ApprovalUiState.pending(nextApprovals);
          s.sessions = nextSessions;
        });
        this.chatSessionRefreshPending = true;
        this.scheduleChatRefresh();
      } else {
        const err: Object = failure;
        this.update((s: HarnessState): void => {
          s.approvalState = ApprovalUiState.pending(items);
          s.error = this.messageOf(err);
        });
      }
    }
  }
}
