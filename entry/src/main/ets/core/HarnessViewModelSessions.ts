/**
 * 界面主状态机 —— **第 4 层：会话**（从 `HarnessViewModel.ts` 拆出）。
 *
 * 选会话（连带拉历史、模型、命令、审批、问答）、历史的向前翻页（游标分页）、
 * 打开会话内的文件（`openSessionFile` / `revealDirectory` / `closeSessionFile` 及其两个私有助手）、
 * 以及工作区与会话本体的增删改（`createSession` / `createWorkspaceAndSession` /
 * `renameSession` / `forkSession` / `archiveSession` / 工作区选择器）。
 *
 * 它依赖第 2 层的清单刷新和第 3 层的目录读取，所以排在这两层之后。
 *
 * 拆分来龙去脉见 `HarnessViewModel.ts`。
 */

import {
  ChatHistory,
  ChatSession,
  ChatWorkspace,
  CommandDescriptor,
  CreatedSession,
  DirectoryPage,
  DshApiException,
  FileContent,
  FileEntry,
  HistoryEntry,
  ResolvedPath,
  SessionModels,
} from './Models';
import {
  supportsArchiveListing,
} from './BridgeCapabilities';
import {
  DshClient,
} from './DshClient';
import {
  PreviewKind,
  binaryPreviewByteLimit,
  previewKind,
  previewKindOf,
} from './PreviewKind';
import {
  isNotBlank,
  trimChar,
} from './TextPredicates';
import {
  HarnessState,
  OpenDocument,
  SessionFileOpen,
  ApprovalUiState,
  MAX_EDIT_BYTES,
  PREVIEW_CHARS,
  PLUGIN_TOO_OLD,
} from './HarnessTypes';
import {
  SessionFileOutcome,
  DecodedText,
  decodeUtf8,
  substringBeforeLast,
  substringAfterLast,
} from './HarnessHelpers';
import { HarnessViewModelFiles } from './HarnessViewModelFiles';

export class HarnessViewModelSessions extends HarnessViewModelFiles {
  // ————————————————— 会话 —————————————————

  async selectSession(id: string | null): Promise<void> {
    // 换会话 = 换上下文：在飞的历史 / 模型 / 命令请求的结果从此作废。
    // 不作废的话，用户从 A 切到 B 时会看到 A 的历史（A 的响应后到、把 B 的覆盖了）——
    // 标题写着 B、内容却是 A，比「转圈久一点」坏得多。
    this.requestGate.invalidate();
    this.update((s: HarnessState): void => {
      s.selectedSessionId = id;
      s.history = null;
      s.liveChat = null;
      s.sessionModels = null;
      s.commands = [];
      // 序号序列是**每个会话各自**的，换会话必须把起点清零：
      // 拿 A 的序号去比 B 的事件必然误判（见 `core/ChatSeqMonitor.ts`）。
      s.lastEventSeq = null;
      s.baselineCursor = null;
      s.approvalState = id === null ? ApprovalUiState.none() : ApprovalUiState.loading();
      // 换会话就把问答状态清干净：上一组的草稿/已答标记留在界面上会张冠李戴。
      s.questions = [];
      s.answeringCallId = null;
      s.answeredCallIds = new Set<string>();
      // `@` 补全的文件列表属于**上一个会话的工作目录**，换会话必须清掉。
      s.mentionEntries = null;
      s.mentionFailed = false;
    });
    if (id !== null) {
      await this.refreshHistory();
      await this.refreshSessionModels();
      await this.refreshPendingApprovals();
      await this.refreshCommands();
      // 进会话就顺手把工作目录的文件捞回来，等用户打 `@` 时直接可用。
      await this.loadMentionEntries();
    }
  }

  async refreshHistory(): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const id: string | null = this.state.selectedSessionId;
      if (id === null) {
        return;
      }
      const history: ChatHistory = await api.history(id);
      this.update((s: HarnessState): void => {
        s.history = history;
      });
      // 顺手把待答问题也拉一次：顶栏刷新正是用户遇到「卡片该出现却没出现」时唯一的自救入口。
      await this.refreshPendingQuestions();
    });
  }

  async loadOlderHistory(): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const id: string | null = this.state.selectedSessionId;
      if (id === null) {
        return;
      }
      const current: ChatHistory | null = this.state.history;
      if (current === null) {
        return;
      }
      if (!current.hasMore) {
        return;
      }
      let beforeSeq: number | null = null;
      for (let i = 0; i < current.events.length; i++) {
        const seq: number = current.events[i].event.seq;
        if (beforeSeq === null || seq < beforeSeq) {
          beforeSeq = seq;
        }
      }
      if (beforeSeq === null) {
        return;
      }
      const older: ChatHistory = await api.history(id, beforeSeq);
      this.update((s: HarnessState): void => {
        const currentNow: ChatHistory | null = s.history;
        if (currentNow === null) {
          return;
        }
        const seen: Set<number> = new Set<number>();
        const merged: HistoryEntry[] = [];
        for (let i = 0; i < older.events.length; i++) {
          const e: HistoryEntry = older.events[i];
          if (!seen.has(e.event.seq)) {
            seen.add(e.event.seq);
            merged.push(e);
          }
        }
        for (let i = 0; i < currentNow.events.length; i++) {
          const e: HistoryEntry = currentNow.events[i];
          if (!seen.has(e.event.seq)) {
            seen.add(e.event.seq);
            merged.push(e);
          }
        }
        const projections = currentNow.projections !== null ? currentNow.projections : older.projections;
        s.history = currentNow.withOlder(merged, older.hasMore, projections);
      });
    });
  }

  /**
   * 打开会话里提到的一个文件（服务器绝对路径）。
   *
   * 分两步：先用服务端的 `roots/resolve` 把绝对路径换成「授权根 + 相对路径」，再把内容
   * 取回来。成功时顺带把「文件」页也切到这个文件。
   */
  async openSessionFile(absolutePath: string): Promise<void> {
    const api: DshClient | null = this.client();
    if (api === null) {
      return;
    }
    const sessionId: string | null = this.state.selectedSessionId;
    if (sessionId === null) {
      return;
    }
    this.update((s: HarnessState): void => {
      s.sessionFileOpen = new SessionFileOpen(sessionId, absolutePath);
    });
    let outcome: SessionFileOutcome | null = null;
    let failure: Object | null = null;
    try {
      outcome = await this.loadSessionFile(api, sessionId, absolutePath);
    } catch (e) {
      failure = e as Object;
    }
    // 用户可能在读取期间切了会话；结果只对发起它的那个会话有效。
    if (this.state.selectedSessionId !== sessionId) {
      return;
    }
    if (outcome !== null) {
      const opened: SessionFileOutcome = outcome;
      this.update((s: HarnessState): void => {
        s.sessionFileOpen = opened.open;
        s.selectedRootId = opened.rootId !== null ? opened.rootId : s.selectedRootId;
        s.currentPath = opened.currentPath !== null ? opened.currentPath : s.currentPath;
        s.document = opened.document !== null ? opened.document : s.document;
      });
    } else {
      let text: string;
      // 端点不存在几乎只有一个原因：服务端插件版本过旧。这条提示必须可操作（去升级插件）。
      if (failure instanceof DshApiException && failure.code === 'ROUTE_NOT_FOUND') {
        text = PLUGIN_TOO_OLD;
      } else {
        text = this.messageOf(failure);
      }
      this.update((s: HarnessState): void => {
        s.sessionFileOpen = new SessionFileOpen(sessionId, absolutePath, false, null, null, null,
          false, false, false, text);
      });
    }
  }

  /**
   * 把「文件」页定位到某个目录（已经解析好的授权根 + 相对路径）。
   *
   * 与 [openSessionFile] 的分工：那个方法服务的是**会话里那个文件面板**（要开详情、
   * 要能显示「这是目录」「超出授权根」这些说明），本方法服务的是**「文件」页**（要的是就地浏览）。
   *
   * 两件事必须都做，少一件就是本文档里记的那个坑：
   * 1. 写 `selectedRootId` / `currentPath` —— 否则切过去还在原来那个目录；
   * 2. **真的把目录读出来**（`loadDirectory`）—— `roots/resolve` 只回答"是个目录"，
   *    不给目录内容；只改路径不读列表，用户切过去看到的是上一个目录的旧列表，
   *    比不切还糟（像是点错了目录）。
   */
  async revealDirectory(rootId: string, path: string): Promise<void> {
    if (rootId.length === 0 || path.length === 0) {
      return;
    }
    this.update((s: HarnessState): void => {
      s.selectedRootId = rootId;
      s.currentPath = path;
    });
    await this.loadDirectory(path);
  }

  /** 关闭面板里的文件详情，回到路径列表。 */
  closeSessionFile(): void {
    this.update((s: HarnessState): void => {
      s.sessionFileOpen = null;
    });
  }

  protected async loadSessionFile(api: DshClient, sessionId: string, absolutePath: string): Promise<SessionFileOutcome> {
    const resolved: ResolvedPath | null = await api.resolvePath(absolutePath);
    if (resolved === null) {
      return new SessionFileOutcome(
        new SessionFileOpen(sessionId, absolutePath, false, null, null, null, false, false, true, null));
    }
    const parent: string = substringBeforeLast(resolved.path, '/');
    if (resolved.kind === 'directory') {
      // 目录没有可预览的内容；但把「文件」页切过去，用户就能就地浏览。
      return new SessionFileOutcome(new SessionFileOpen(sessionId, absolutePath, false, resolved),
        resolved.rootId, resolved.path, null);
    }
    const entry: FileEntry = await this.sessionFileEntry(api, resolved, parent);
    // 图片 / PDF 与文本的上限不同：2 MiB 对一张手机截图太紧，但解码前整份字节要进内存。
    const provisional: PreviewKind = previewKind(resolved.path, resolved.contentType);
    const capRaw: number | null = binaryPreviewByteLimit(provisional);
    const cap: number = capRaw !== null ? capRaw : MAX_EDIT_BYTES;
    const tooLarge: boolean = entry.size > cap;
    const content: FileContent | null = tooLarge ? null : await api.readFile(resolved.rootId, resolved.path);
    const kind: PreviewKind = previewKindOf(resolved.path, resolved.contentType, content !== null ? content.bytes : null);
    const binary: boolean = kind === PreviewKind.IMAGE || kind === PreviewKind.PDF;
    // 图片 / PDF 不解 UTF-8：那是白费一次解码，还会把二进制变成一屏替换字符。
    const decoded: DecodedText | null = binary ? null : (content !== null ? decodeUtf8(content.bytes) : null);
    const text: string | null = decoded !== null ? decoded.text : null;
    const previewText: string | null = text !== null
      ? text.substring(0, text.length > PREVIEW_CHARS ? PREVIEW_CHARS : text.length) : null;
    const docBytes: Uint8Array | null = binary && content !== null ? content.bytes : null;
    return new SessionFileOutcome(
      new SessionFileOpen(sessionId, absolutePath, false, resolved, previewText, docBytes,
        text !== null && text.length > PREVIEW_CHARS, tooLarge, false, null),
      resolved.rootId, parent,
      new OpenDocument(entry, text, content !== null ? content.etag : '',
        decoded !== null ? decoded.hasBom : false, decoded !== null ? decoded.lineEnding : '\n',
        content !== null ? content.contentType : null, docBytes, false, text));
  }

  /**
   * `roots/resolve` 只说「是文件还是目录、多大、何时改」，**没有 writable**，而「文件」页
   * 的保存按钮正是看这个字段。目录列表能给出权威值，所以优先取列表里的那一条；列表读不到
   * 时退回保守构造：`writable = false`。
   */
  protected async sessionFileEntry(api: DshClient, resolved: ResolvedPath, parent: string): Promise<FileEntry> {
    let listed: FileEntry | null = null;
    try {
      const page: DirectoryPage = await api.entries(resolved.rootId, parent);
      for (let i = 0; i < page.entries.length; i++) {
        if (page.entries[i].path === resolved.path) {
          listed = page.entries[i];
          break;
        }
      }
    } catch (e) {
      listed = null;
    }
    if (listed !== null) {
      return listed;
    }
    const entry: FileEntry = new FileEntry();
    const tail: string = substringAfterLast(resolved.path, '/');
    entry.name = tail.length > 0 ? tail : resolved.path;
    entry.path = resolved.path;
    entry.kind = resolved.kind;
    entry.size = resolved.size !== null ? resolved.size : 0;
    entry.modifiedAt = resolved.modifiedAt;
    entry.writable = false;
    return entry;
  }

  async createSession(workspaceId: string, preset: string | null): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const created: CreatedSession = await api.createSession(workspaceId,
        preset !== null && isNotBlank(preset) ? preset : null);
      const sessions: ChatSession[] = await api.sessions();
      const history: ChatHistory = await api.history(created.id);
      const models: SessionModels = await api.sessionModels(created.id);
      const commands: CommandDescriptor[] = await api.sessionCommands(created.id);
      this.update((s: HarnessState): void => {
        s.sessions = sessions;
        s.selectedSessionId = created.id;
        s.history = history;
        s.sessionModels = models;
        s.commands = commands;
        s.approvalState = ApprovalUiState.none();
      });
    });
  }

  async prepareWorkspacePicker(): Promise<void> {
    let rootId: string | null = this.state.workspacePickerRootId;
    if (rootId !== null) {
      let found: boolean = false;
      for (let i = 0; i < this.state.roots.length; i++) {
        if (this.state.roots[i].id === rootId) {
          found = true;
          break;
        }
      }
      if (!found) {
        rootId = null;
      }
    }
    if (rootId === null) {
      rootId = this.state.selectedRootId;
    }
    if (rootId === null) {
      rootId = this.state.roots.length > 0 ? this.state.roots[0].id : null;
    }
    const chosen: string | null = rootId;
    this.update((s: HarnessState): void => {
      s.workspacePickerRootId = chosen;
      s.workspacePickerPath = '';
      s.workspacePickerDirectory = null;
    });
    if (chosen !== null) {
      await this.loadWorkspacePickerDirectory('');
    }
  }

  async selectWorkspacePickerRoot(rootId: string): Promise<void> {
    this.update((s: HarnessState): void => {
      s.workspacePickerRootId = rootId;
      s.workspacePickerPath = '';
      s.workspacePickerDirectory = null;
    });
    await this.loadWorkspacePickerDirectory('');
  }

  async loadWorkspacePickerDirectory(path: string): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const rootId: string | null = this.state.workspacePickerRootId;
      if (rootId === null) {
        return;
      }
      const normalized: string = trimChar(path, '/');
      const page: DirectoryPage = await api.entries(rootId, normalized);
      this.update((s: HarnessState): void => {
        s.workspacePickerPath = normalized;
        s.workspacePickerDirectory = page;
      });
    });
  }

  async createWorkspaceAndSession(rootId: string, path: string, preset: string | null): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const workspace: ChatWorkspace = await api.createChatWorkspace(rootId, trimChar(path, '/'));
      const created: CreatedSession = await api.createSession(workspace.id,
        preset !== null && isNotBlank(preset) ? preset : null);
      const sessions: ChatSession[] = await api.sessions();
      const workspaces: ChatWorkspace[] = await api.chatWorkspaces();
      const history: ChatHistory = await api.history(created.id);
      const models: SessionModels = await api.sessionModels(created.id);
      const commands: CommandDescriptor[] = await api.sessionCommands(created.id);
      this.update((s: HarnessState): void => {
        s.chatWorkspaces = workspaces;
        s.sessions = sessions;
        s.selectedSessionId = created.id;
        s.history = history;
        s.sessionModels = models;
        s.commands = commands;
        s.approvalState = ApprovalUiState.none();
      });
    });
  }

  async renameWorkspace(workspaceId: string, title: string): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      await api.renameChatWorkspace(workspaceId, title);
      const workspaces: ChatWorkspace[] = await api.chatWorkspaces();
      const sessions: ChatSession[] = await api.sessions();
      this.update((s: HarnessState): void => {
        s.chatWorkspaces = workspaces;
        s.sessions = sessions;
      });
    });
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      await api.deleteChatWorkspace(workspaceId);
      const workspaces: ChatWorkspace[] = await api.chatWorkspaces();
      const sessions: ChatSession[] = await api.sessions();
      this.update((s: HarnessState): void => {
        s.chatWorkspaces = workspaces;
        s.sessions = sessions;
      });
    });
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      await api.renameSession(sessionId, title);
      const sessions: ChatSession[] = await api.sessions();
      this.update((s: HarnessState): void => {
        s.sessions = sessions;
      });
    });
  }

  /**
   * 分叉会话。`atSeq` 非 null 时 = **从那条消息**分叉（消息级分叉入口把它传进来）。
   *
   * 为什么默认参数是 null 而不是 0：`null` 才是「整体分叉」，而 `0` 是内核不认识的
   * 事件序号（传过去只会换回一个报错弹窗）。判据见 `core/ChatFork.ts`。
   */
  async forkSession(sessionId: string, atSeq: number | null = null): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const forkedId: string = await api.forkSession(sessionId, atSeq);
      const sessions: ChatSession[] = await api.sessions();
      const history: ChatHistory = await api.history(forkedId);
      const models: SessionModels = await api.sessionModels(forkedId);
      const commands: CommandDescriptor[] = await api.sessionCommands(forkedId);
      this.update((s: HarnessState): void => {
        s.sessions = sessions;
        s.selectedSessionId = forkedId;
        s.history = history;
        s.sessionModels = models;
        s.commands = commands;
        s.approvalState = ApprovalUiState.none();
        s.liveChat = null;
      });
    });
  }

  /**
   * 拉取**已归档**会话（归档视图的入口动作）。对位源工程 `loadArchivedSessions`。
   *
   * 两道闸：
   * ① **能力位不支持就直接返回** —— 老 bridge 会忽略 `archived` 参数并返回未归档列表，
   *    那样展示出来的「没有归档会话」是**假结论**（比不显示入口更坏）；
   * ② **每次进视图都重拉、不做本地缓存** —— 归档状态可能在电脑端被改过，
   *    缓存会让手机端长期显示过期结果。
   */
  async loadArchivedSessions(): Promise<void> {
    if (!supportsArchiveListing(this.state.bridgeCapabilities)) {
      return;
    }
    await this.withClient(async (api: DshClient): Promise<void> => {
      const archived: ChatSession[] = await api.sessions(true);
      this.update((s: HarnessState): void => {
        s.archivedSessions = archived;
      });
    });
  }

  async archiveSession(sessionId: string): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      await api.archiveSession(sessionId);
      const sessions: ChatSession[] = await api.sessions();
      this.update((s: HarnessState): void => {
        if (s.selectedSessionId === sessionId) {
          s.sessions = sessions;
          s.selectedSessionId = null;
          s.history = null;
          s.liveChat = null;
          s.sessionModels = null;
          s.commands = [];
          s.approvalState = ApprovalUiState.none();
        } else {
          s.sessions = sessions;
        }
      });
    });
  }
}
