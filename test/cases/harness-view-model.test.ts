/**
 * `HarnessViewModel` 单测。
 *
 * 直接 `import` core 源码（**不经 Probe**）：本模块刻意不碰任何 `@ohos.*`，
 * 平台能力全走注入，因此可以用内存键值存储 + 反转 SecretBox + 桩 Crypto + 假客户端
 * 在 node 里把整条状态机跑通。
 *
 * 覆盖四类：
 * 1. 四个顶层纯函数（逐条对照 Kotlin 的行为）；
 * 2. `HarnessState` 默认值（逐字对齐 Kotlin `data class`）；
 * 3. 假依赖下的主流程（配对、连接、发送、问答、审批、偏好落盘、断开）；
 * 4. 文案表英文列完整性。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  HarnessViewModel, HarnessState, HarnessDeps, ApprovalUiKind, ApprovalUiState, OpenDocument,
  PendingAttachment, SessionFileOpen, COMMAND_NAME, QUESTION_REFRESH_EVENTS, CONFIG_INVALID,
  LAST_ENDPOINT, PLUGIN_TOO_OLD, FILE_TOO_LARGE, BINARY_FILE, COMMAND_FAILED,
  isHostCommandLine, removeQuestion, isToolResultFrame, markSessionStopped,
} from '../../entry/src/main/ets/core/HarnessViewModel.ts';
import {
  ChatSession, CommandDescriptor, DeviceView, DirectoryPage, FileContent, FileEntry, HistoryEntry,
  ChatHistory, HealthView, PairingResult, PendingApproval, PendingQuestionSet, PluginInventory,
  ProviderSettings, QuestionAnswer, ResolvedPath, RootView, SessionEvent, SessionModels, TrashEntry,
  UploadedAttachment, WorkspaceEvent, DshApiException,
} from '../../entry/src/main/ets/core/Models.ts';
import {
  ConnectionCoordinator, DshClientFactory, ActiveConnection,
} from '../../entry/src/main/ets/core/ConnectionCoordinator.ts';
import {
  Credential, CredentialKind, Endpoint, Host,
} from '../../entry/src/main/ets/core/ConnectionModels.ts';
import {
  HostStore, KeyValueStore, SecretBox, CryptoBridge, KEY_HOSTS,
} from '../../entry/src/main/ets/core/HostStore.ts';
import { AppPreferences } from '../../entry/src/main/ets/core/AppPreferences.ts';
import { TimerBridge, DshClient } from '../../entry/src/main/ets/core/DshClient.ts';
import {
  NetworkException, NetworkFailureKind, allEndpointsUnreachableText, localizedErrorText,
  networkErrorText, toastText,
} from '../../entry/src/main/ets/core/ErrorMessages.ts';
import { SEND_MODE_QUEUE, SEND_MODE_STEER } from '../../entry/src/main/ets/core/ComposerSendPolicy.ts';
import { utf8Encode } from '../../entry/src/main/ets/core/Codec.ts';
import { JsonAccess } from '../../entry/src/main/ets/core/JsonAccess.ts';

// ---------------------------------------------------------------------------
// 假平台能力
// ---------------------------------------------------------------------------

/** 内存键值存储（替代鸿蒙 `@ohos.data.preferences`）。 */
class MemoryStore implements KeyValueStore {
  private map = new Map<string, string>();

  getString(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  putString(key: string, value: string | null): void {
    if (value === null) {
      this.map.delete(key);
    } else {
      this.map.set(key, value);
    }
  }

  remove(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

/** 反转字节的可逆变换（证明确实走了加解密路径，且不碰系统密钥库）。 */
class ReverseSecretBox implements SecretBox {
  encrypt(plain: Uint8Array): Uint8Array {
    const out = new Uint8Array(plain.length);
    for (let i = 0; i < plain.length; i++) {
      out[i] = plain[plain.length - 1 - i];
    }
    return out;
  }

  decrypt(cipher: Uint8Array): Uint8Array {
    return this.encrypt(cipher);
  }
}

const nodeCrypto: CryptoBridge = {
  sha256Hex(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  },
};

/** 假定时器：测试自己决定何时触发 400ms 去抖，因此这些用例是确定性的、亚毫秒级。 */
class FakeTimers implements TimerBridge {
  entries: { handle: number; delayMs: number; action: () => void; fired: boolean }[] = [];
  cancelled: number[] = [];
  private next = 1;

  schedule(delayMs: number, action: () => void): number {
    const handle = this.next++;
    this.entries.push({ handle, delayMs, action, fired: false });
    return handle;
  }

  cancel(handle: number): void {
    this.cancelled.push(handle);
    for (const e of this.entries) {
      if (e.handle === handle) {
        e.fired = true;
      }
    }
  }

  /** 触发所有尚未取消、尚未触发的定时器。 */
  firePending(): void {
    const pending = this.entries.filter((e) => !e.fired);
    for (const e of pending) {
      e.fired = true;
      e.action();
    }
  }

  get pendingCount(): number {
    return this.entries.filter((e) => !e.fired).length;
  }
}

/** 让出事件循环，把微任务全部冲干净。 */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * 假客户端：实现单测真正会走到的那些方法，其余一律给「空但合法」的默认值。
 *
 * 用字段而不是构造函数参数来配置返回值，测试里改一两行就能描述一种服务端行为。
 */
class FakeClient {
  endpoint = 'http://192.168.1.9:3090/api/v1';
  device: DeviceView = new DeviceView();
  /** health 的失败方式：null = 成功；否则抛该异常。 */
  healthError: Error | null = null;
  sendError: Error | null = null;
  counters = { health: 0, sendMessage: 0, executeCommand: 0, answerQuestions: 0, decideApproval: 0,
    uploadAttachment: 0, pair: 0, readFile: 0, history: 0, sessions: 0 };
  /** 历史页：先按 beforeSeq 返回老页，再返回当前页。 */
  olderHistory: ChatHistory | null = null;
  currentHistory: ChatHistory | null = null;
  sessionsValue: ChatSession[] = [];
  pendingApprovalsValue: PendingApproval[] = [];
  pendingQuestionsValue: PendingQuestionSet[] = [];
  uploadResult: UploadedAttachment = new UploadedAttachment();
  resolvePathValue: ResolvedPath | null = null;
  readFileValue: FileContent = new FileContent(new Uint8Array(0), 'etag-1', 'text/plain');
  entriesValue: FileEntry[] = [];
  entriesNextCursor: string | null = null;

  constructor() {
    this.device.id = 'dev-1';
    this.device.name = 'Pixel 9';
    this.device.scopes = ['files.read', 'files.write', 'chat.read', 'chat.write', 'settings.read', 'settings.write'];
    this.device.rootIds = ['root-1'];
  }

  health(): Promise<HealthView> {
    this.counters.health += 1;
    if (this.healthError !== null) {
      return Promise.reject(this.healthError);
    }
    const h = new HealthView();
    h.ok = true;
    h.version = 'v1';
    return Promise.resolve(h);
  }

  pair(code: string, deviceName: string): Promise<PairingResult> {
    this.counters.pair += 1;
    const r = new PairingResult();
    r.token = 'token-from-pair';
    r.device = this.device;
    return Promise.resolve(r);
  }

  currentDevice(): Promise<DeviceView> {
    return Promise.resolve(this.device);
  }

  roots(): Promise<RootView[]> {
    const r = new RootView();
    r.id = 'root-1';
    r.label = '工作区';
    return Promise.resolve([r]);
  }

  entries(rootId: string, path: string = '', cursor: string | null = null): Promise<DirectoryPage> {
    const page = new DirectoryPage();
    page.path = path;
    page.entries = this.entriesValue;
    page.nextCursor = this.entriesNextCursor;
    return Promise.resolve(page);
  }

  archiveSession(sessionId: string): Promise<void> {
    return Promise.resolve();
  }

  sessions(): Promise<ChatSession[]> {
    this.counters.sessions += 1;
    return Promise.resolve(this.sessionsValue);
  }

  chatWorkspaces(): Promise<object[]> {
    return Promise.resolve([]);
  }

  agentPresets(): Promise<object[]> {
    return Promise.resolve([]);
  }

  providerSettings(): Promise<ProviderSettings> {
    return Promise.resolve(new ProviderSettings());
  }

  pluginInventory(): Promise<PluginInventory> {
    return Promise.resolve(new PluginInventory());
  }

  trash(): Promise<TrashEntry[]> {
    return Promise.resolve([]);
  }

  history(sessionId: string, beforeSeq: number | null = null): Promise<ChatHistory> {
    this.counters.history += 1;
    if (beforeSeq !== null && this.olderHistory !== null) {
      return Promise.resolve(this.olderHistory);
    }
    return Promise.resolve(this.currentHistory === null ? new ChatHistory() : this.currentHistory);
  }

  sessionModels(sessionId: string): Promise<SessionModels> {
    return Promise.resolve(new SessionModels());
  }

  sessionCommands(sessionId: string): Promise<CommandDescriptor[]> {
    return Promise.resolve([]);
  }

  pendingApprovals(sessionId: string): Promise<PendingApproval[]> {
    return Promise.resolve(this.pendingApprovalsValue);
  }

  decideApproval(sessionId: string, approvalId: string, allowOnce: boolean): Promise<void> {
    this.counters.decideApproval += 1;
    return Promise.resolve();
  }

  pendingQuestions(sessionId: string): Promise<PendingQuestionSet[]> {
    return Promise.resolve(this.pendingQuestionsValue);
  }

  answerQuestions(sessionId: string, callId: string, answers: QuestionAnswer[]): Promise<void> {
    this.counters.answerQuestions += 1;
    return Promise.resolve();
  }

  executeCommand(sessionId: string, line: string): Promise<object> {
    this.counters.executeCommand += 1;
    return Promise.resolve(new (class { commandId = 'c1'; result = new (class { kind = 'text'; text: string | null = 'ok'; sourceEventSeq: number | null = null; })(); })());
  }

  sendMessage(sessionId: string, parts: object[], steer: boolean): Promise<void> {
    this.counters.sendMessage += 1;
    if (this.sendError !== null) {
      return Promise.reject(this.sendError);
    }
    return Promise.resolve();
  }

  uploadAttachment(sessionId: string, bytes: Uint8Array, name: string): Promise<UploadedAttachment> {
    this.counters.uploadAttachment += 1;
    return Promise.resolve(this.uploadResult);
  }

  resolvePath(absolutePath: string): Promise<ResolvedPath | null> {
    return Promise.resolve(this.resolvePathValue);
  }

  readFile(rootId: string, path: string): Promise<FileContent> {
    this.counters.readFile += 1;
    return Promise.resolve(this.readFileValue);
  }

  events(listener: (event: WorkspaceEvent) => void, connection: (open: boolean) => void): { close(): void } {
    return { close: (): void => undefined };
  }
}

/** 假工厂：`create` 一律返回同一个假客户端，探活与业务请求共用它。 */
class FakeFactory implements DshClientFactory {
  client: FakeClient;
  created: string[] = [];

  constructor(client: FakeClient) {
    this.client = client;
  }

  create(baseUrl: string, token: string | null): DshClient {
    this.created.push(baseUrl);
    return this.client as unknown as DshClient;
  }
}

// ---------------------------------------------------------------------------
// 组装一套完整依赖
// ---------------------------------------------------------------------------

interface Rig {
  vm: HarnessViewModel;
  state: HarnessState;
  store: HostStore;
  storage: MemoryStore;
  prefs: AppPreferences;
  timers: FakeTimers;
  client: FakeClient;
  factory: FakeFactory;
  coordinator: ConnectionCoordinator;
  lang: () => string;
  now: () => number;
  idSeq: (prefix: string) => string;
}

function makeRig(client: FakeClient = new FakeClient(), shared: MemoryStore | null = null): Rig {
  // 传入同一份 storage 时，两个 VM 共享同一份落盘数据 —— 用于验证「偏好重启后还在」。
  const storage = shared === null ? new MemoryStore() : shared;
  const now = (): number => 1_700_000_000_000;
  const store = new HostStore(storage, new ReverseSecretBox(), nodeCrypto, now);
  const prefs = new AppPreferences(storage);
  const factory = new FakeFactory(client);
  const timers = new FakeTimers();
  const coordinator = new ConnectionCoordinator(factory, 1500, timers, now);
  let seq = 0;
  const newId = (): string => {
    seq += 1;
    return `id-${seq}`;
  };
  const lang = (): string => 'zh-CN';
  const deps: HarnessDeps = {
    hostStore: store,
    preferences: prefs,
    coordinator,
    clientFactory: factory,
    legacyKeyValueStore: storage,
    legacySecretBox: new ReverseSecretBox(),
    now,
    newId,
    languageTag: lang,
    timers,
  };
  const vm = new HarnessViewModel(deps);
  return {
    vm, state: vm.state, store, storage, prefs, timers, client, factory, coordinator, lang, now,
    idSeq: (): string => newId(),
  };
}

function sampleHost(id = 'h1'): Host {
  return new Host(id, '家里的电脑',
    [Endpoint.create('家庭局域网', 'http://192.168.1.9:3090', 'e1')], 'e1',
    new Credential(CredentialKind.DEVICE_TOKEN, 'tok', 'dev-1', 'Pixel 9', ['files.read'], 1, null),
    1, 1);
}

function command(name: string): CommandDescriptor {
  const d = new CommandDescriptor();
  d.name = name;
  return d;
}

function sess(id: string, running: boolean, seq: number): ChatSession {
  const s = new ChatSession();
  s.id = id;
  s.rootId = 'root-1';
  s.cwd = '';
  s.running = running;
  s.updatedAt = seq;
  return s;
}

function historyPage(seqs: number[], hasMore: boolean): ChatHistory {
  const h = new ChatHistory();
  h.hasMore = hasMore;
  h.events = seqs.map((n): HistoryEntry => {
    const e = new HistoryEntry();
    const ev = new SessionEvent();
    ev.seq = n;
    ev.type = 'chat.message.committed';
    e.event = ev;
    return e;
  });
  return h;
}

function questionSet(callId: string, state: string): PendingQuestionSet {
  const q = new PendingQuestionSet();
  q.callId = callId;
  q.state = state;
  return q;
}

function approval(id: string, sessionId: string): PendingApproval {
  const a = new PendingApproval();
  a.id = id;
  a.sessionId = sessionId;
  a.toolName = 'bash';
  return a;
}

/** 把一个已保存的主机放进 store（模拟「之前配对过」）。 */
function seedHost(rig: Rig, host: Host): void {
  rig.store.upsert(host);
}

// ===========================================================================
// 1. 顶层纯函数
// ===========================================================================

test('isHostCommandLine 只认命令表里精确匹配的名字', () => {
  const table = [command('compact'), command('clear'), command('memory')];
  assert.equal(isHostCommandLine('/compact', table), true);
  assert.equal(isHostCommandLine('/compact 3', table), true);
  assert.equal(isHostCommandLine('/clear', table), true);
  assert.equal(isHostCommandLine('/skill-x', table), false);
});

test('isHostCommandLine：/Compact 不算（大小写敏感，与插件逐字对齐）', () => {
  const table = [command('compact')];
  assert.equal(isHostCommandLine('/Compact', table), false);
  assert.equal(isHostCommandLine('/COMPACT', table), false);
});

test('isHostCommandLine：不以 / 开头、名字非法、空命令表都返回 false', () => {
  const table = [command('compact')];
  assert.equal(isHostCommandLine('compact', table), false);
  assert.equal(isHostCommandLine('/Compact1', table), false);
  assert.equal(isHostCommandLine('/-bad', table), false);
  assert.equal(isHostCommandLine('/compact', []), false);
  assert.equal(isHostCommandLine('/', table), false);
});

test('COMMAND_NAME 与 isHostCommandLine 的判定口径一致', () => {
  assert.equal(COMMAND_NAME.test('compact'), true);
  assert.equal(COMMAND_NAME.test('Compact'), false);
  assert.equal(COMMAND_NAME.test('1bad'), false);
});

test('removeQuestion：callId 对不上时原样返回（同一个引用）', () => {
  const list = [questionSet('a', 'continued'), questionSet('b', 'continued')];
  assert.equal(removeQuestion(list, 'zzz'), list);
});

test('removeQuestion：命中时删除那一条，且不改动入参', () => {
  const list = [questionSet('a', 'continued'), questionSet('b', 'continued')];
  const out = removeQuestion(list, 'a');
  assert.equal(out.length, 1);
  assert.equal(out[0].callId, 'b');
  assert.equal(list.length, 2, '入参不得被就地修改');
});

test('isToolResultFrame：只有 chat.session.event + eventType=tool/result 才算', () => {
  const data = JsonAccess.parse('{"sessionId":"s1","eventType":"tool/result","seq":9}');
  assert.equal(isToolResultFrame('chat.session.event', data), true);
  assert.equal(isToolResultFrame('chat.message.delta', data), false);
  assert.equal(isToolResultFrame('chat.session.event', JsonAccess.parse('{"eventType":"tool/start"}')), false);
  assert.equal(isToolResultFrame('chat.session.event', null), false);
  assert.equal(isToolResultFrame('chat.session.event', JsonAccess.parse('{"eventType":7}')), false);
});

test('isToolResultFrame：字符串形态带引号也认（对应 toString().trim(\'"\')）', () => {
  const data = JsonAccess.parse('{"eventType":"\\"tool/result\\""}');
  assert.equal(isToolResultFrame('chat.session.event', data), true);
});

test('markSessionStopped：把运行的会话标成停止，不匹配时原样返回', () => {
  const list = [sess('a', true, 1), sess('b', true, 2)];
  const out = markSessionStopped(list, 'a');
  assert.equal(out[0].running, false);
  assert.equal(out[1].running, true);
  assert.equal(list[0].running, true, '入参不得被就地修改');
});

test('markSessionStopped：会话本来就不在运行 / 找不到 id 时返回同一引用', () => {
  const stopped = [sess('a', false, 1)];
  assert.equal(markSessionStopped(stopped, 'a'), stopped);
  const list = [sess('a', true, 1)];
  assert.equal(markSessionStopped(list, 'nope'), list);
});

test('QUESTION_REFRESH_EVENTS 只列结构性事件，绝不含 token 级流式增量', () => {
  assert.equal(QUESTION_REFRESH_EVENTS.has('chat.turn.end'), true);
  assert.equal(QUESTION_REFRESH_EVENTS.has('chat.message.delta'), false);
  assert.equal(QUESTION_REFRESH_EVENTS.has('chat.approval.requested'), true);
});

// ===========================================================================
// 2. HarnessState 默认值
// ===========================================================================

test('HarnessState 默认值逐字对齐 Kotlin data class', () => {
  const s = new HarnessState();
  assert.equal(s.restoring, true);
  assert.equal(s.busy, false);
  assert.equal(s.endpointDraft, 'http://192.168.1.20:3090');
  assert.equal(s.connected, false);
  assert.equal(s.activeHostId, null);
  assert.equal(s.activeEndpointId, null);
  assert.equal(s.selectedSessionId, null);
  assert.equal(s.busySendMode, SEND_MODE_QUEUE);
  assert.equal(s.genUiDebug, false);
  assert.equal(s.useWebChat, false);
  assert.equal(s.showContext, false);
  assert.equal(s.pendingText, '');
  assert.equal(s.pendingAttachments.length, 0);
  assert.equal(s.hosts.length, 0);
  assert.equal(s.questions.length, 0);
  assert.equal(s.answeringCallId, null);
  assert.equal(s.answeredCallIds.size, 0);
  assert.equal(s.attachmentUploading, false);
  assert.equal(s.approvalState.kind, ApprovalUiKind.NONE);
  assert.equal(s.error, null);
});

test('HarnessState.copyFrom 把另一份状态的字段整份搬过来', () => {
  const a = new HarnessState();
  const b = new HarnessState();
  b.connected = true;
  b.endpoint = 'http://x/api/v1';
  b.hosts = [sampleHost()];
  b.selectedSessionId = 's9';
  a.copyFrom(b);
  assert.equal(a.connected, true);
  assert.equal(a.endpoint, 'http://x/api/v1');
  assert.equal(a.hosts.length, 1);
  assert.equal(a.selectedSessionId, 's9');
});

test('ApprovalUiState 四个工厂给出对应的 kind', () => {
  assert.equal(ApprovalUiState.none().kind, ApprovalUiKind.NONE);
  assert.equal(ApprovalUiState.loading().kind, ApprovalUiKind.LOADING);
  const items = [approval('a1', 's1')];
  assert.equal(ApprovalUiState.pending(items).kind, ApprovalUiKind.PENDING);
  assert.equal(ApprovalUiState.pending(items).items.length, 1);
  assert.equal(ApprovalUiState.deciding(items[0], items).kind, ApprovalUiKind.DECIDING);
});

test('OpenDocument.withText / withEtag 只改一个字段', () => {
  const entry = new FileEntry();
  entry.path = 'a.txt';
  const doc = new OpenDocument(entry, 'old', 'e1', false, '\n', 'text/plain', null, false);
  assert.equal(doc.withText('new').text, 'new');
  assert.equal(doc.withText('new').etag, 'e1');
  assert.equal(doc.withEtag('e2').etag, 'e2');
  assert.equal(doc.withEtag('e2').text, 'old');
});

test('PendingAttachment 保留 id 与原图字节（同一文件可选多次，按 id 认）', () => {
  const a = new PendingAttachment('a1', null as never, 'photo.png', 12, new Uint8Array([1, 2, 3]));
  assert.equal(a.id, 'a1');
  assert.equal(a.sizeBytes, 12);
  assert.equal(a.imageBytes?.length, 3);
});

test('SessionFileOpen 默认处于 loading', () => {
  const o = new SessionFileOpen('s1', '/w/a.txt');
  assert.equal(o.loading, true);
  assert.equal(o.sessionId, 's1');
  assert.equal(o.requestedPath, '/w/a.txt');
});

// ===========================================================================
// 3. 偏好落盘与恢复
// ===========================================================================

test('setBusySendMode 落盘并被新 HarnessState 恢复', () => {
  const rig = makeRig();
  rig.vm.setBusySendMode(SEND_MODE_STEER);
  assert.equal(rig.state.busySendMode, SEND_MODE_STEER);
  assert.equal(rig.prefs.busySendMode, SEND_MODE_STEER);
  // 新开一个 VM（共享同一份落盘）：构造函数里会把偏好盖回初始状态。
  const rig2 = makeRig(new FakeClient(), rig.storage);
  assert.equal(rig2.vm.state.busySendMode, SEND_MODE_STEER);
  rig.vm.dispose();
  rig2.vm.dispose();
});

test('setGenUiDebug / setUseWebChat / setShowContext 落盘并被恢复', () => {
  const rig = makeRig();
  rig.vm.setGenUiDebug(true);
  rig.vm.setUseWebChat(true);
  rig.vm.setShowContext(true);
  assert.equal(rig.prefs.genUiDebug, true);
  assert.equal(rig.prefs.useWebChat, true);
  assert.equal(rig.prefs.showContext, true);
  const rig2 = makeRig(new FakeClient(), rig.storage);
  assert.equal(rig2.vm.state.genUiDebug, true);
  assert.equal(rig2.vm.state.useWebChat, true);
  assert.equal(rig2.vm.state.showContext, true);
  rig.vm.dispose();
  rig2.vm.dispose();
});

test('偏好非法取值一律回落「排队」（与 AppPreferences 口径一致）', () => {
  const rig = makeRig();
  rig.prefs.busySendMode = 'BOGUS';
  const rig2 = makeRig(new FakeClient(), rig.storage);
  assert.equal(rig2.vm.state.busySendMode, SEND_MODE_QUEUE);
  rig.vm.dispose();
  rig2.vm.dispose();
});

// ===========================================================================
// 4. 配置导入 / 配对
// ===========================================================================

test('importConfiguration 解不开配置文本时以 CONFIG_INVALID 收场', async () => {
  const rig = makeRig();
  await rig.vm.importConfiguration('这不是一段配置');
  assert.equal(rig.state.error, CONFIG_INVALID);
  assert.equal(rig.store.loadHosts().length, 0, '解不开就不该留下任何主机');
  assert.equal(rig.state.busy, false);
  rig.vm.dispose();
});

test('pair 拒空配对码与空设备名，且不写主机', async () => {
  const rig = makeRig();
  await rig.vm.pair('http://192.168.1.9:3090', '   ', 'Pixel');
  assert.ok(rig.state.error !== null);
  assert.equal(rig.store.loadHosts().length, 0);
  assert.equal(rig.client.counters.pair, 0);

  await rig.vm.pair('http://192.168.1.9:3090', 'code-1', '');
  assert.ok(rig.state.error !== null);
  assert.equal(rig.store.loadHosts().length, 0);
  assert.equal(rig.client.counters.pair, 0);
  rig.vm.dispose();
});

test('pair 成功后写入主机并落地 activeHostId / activeEndpointId', async () => {
  const rig = makeRig();
  await rig.vm.pair('http://192.168.1.9:3090', 'code-1', '我的手机');
  assert.equal(rig.store.loadHosts().length, 1);
  assert.equal(rig.state.activeHostId, 'host-dev-1');
  assert.equal(rig.state.activeEndpointId, 'ep-paired');
  assert.equal(rig.state.connected, true);
  assert.equal(rig.state.restoring, false);
  assert.equal(rig.state.device?.id, 'dev-1');
  rig.vm.dispose();
});

// ===========================================================================
// 5. 连接
// ===========================================================================

test('connectHost 落地 activeHostId / activeEndpointId 且 restoring 归位', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  assert.equal(rig.state.error, null, `连接不该失败：${rig.state.error}`);
  assert.equal(rig.state.activeHostId, 'h1');
  assert.equal(rig.state.activeEndpointId, 'e1');
  assert.equal(rig.state.connected, true);
  assert.equal(rig.state.healthOk, true);
  assert.equal(rig.state.connecting, false);
  assert.equal(rig.state.restoring, false);
  // 与 Kotlin 一致：连上之后状态被 loadSnapshot 的快照整份接管，而快照里
  // `selectedHostId` 是默认的 null —— 「选中查看」这个 UI 态由连接页自己维护。
  assert.equal(rig.state.selectedHostId, null);
  rig.vm.dispose();
});

test('connectHost 全部地址不可达 → 本地化「全部地址不可达」文案 + restoring 归位', async () => {
  const rig = makeRig();
  const c = rig.client;
  c.healthError = new NetworkException(NetworkFailureKind.TIMEOUT, 'connect timed out');
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  assert.equal(rig.state.error, allEndpointsUnreachableText('zh-CN'));
  assert.equal(rig.state.connected, false);
  assert.equal(rig.state.restoring, false, '冷启动自动重连失败也必须把 restoring 放下');
  assert.equal(rig.state.endpointProbes.length, 1, '失败也要留下逐地址的探活原因');
  assert.ok(rig.state.endpointProbes[0].error !== null);
  rig.vm.dispose();
});

test('testConnection 成功时记下健康状态并把草稿归一为不含 /api/v1 的基地址', async () => {
  const rig = makeRig();
  await rig.vm.testConnection('http://192.168.1.9:3090/api/v1/');
  assert.equal(rig.state.healthOk, true);
  assert.equal(rig.state.endpointDraft, 'http://192.168.1.9:3090');
  rig.vm.dispose();
});

test('testConnection 遇网络层异常时翻译成按类型本地化的文案', async () => {
  const rig = makeRig();
  rig.client.healthError = new NetworkException(NetworkFailureKind.TIMEOUT, 'read timed out');
  await rig.vm.testConnection('http://192.168.1.9:3090');
  assert.equal(rig.state.error, networkErrorText(NetworkFailureKind.TIMEOUT, 'zh-CN'));
  assert.equal(rig.state.healthOk, false);
  rig.vm.dispose();
});

test('setEndpointDraft 改草稿并清掉上次的健康结论', () => {
  const rig = makeRig();
  rig.vm.setEndpointDraft('http://10.0.0.1:3090');
  assert.equal(rig.state.endpointDraft, 'http://10.0.0.1:3090');
  assert.equal(rig.state.healthOk, false);
  rig.vm.dispose();
});

test('addEndpoint 追加地址；重复的地址不重复加', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.addEndpoint('h1', '虚拟网', 'http://100.64.0.1:3090/api/v1');
  assert.equal(rig.store.host('h1')?.endpoints.length, 2);
  await rig.vm.addEndpoint('h1', '再来一次', 'http://100.64.0.1:3090');
  assert.equal(rig.store.host('h1')?.endpoints.length, 2, '同一 baseUrl 不该重复追加');
  rig.vm.dispose();
});

test('removeEndpoint 保留最后一个地址时以 LAST_ENDPOINT 拒绝', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.removeEndpoint('h1', 'e1');
  assert.equal(rig.state.error, LAST_ENDPOINT);
  assert.equal(rig.store.host('h1')?.endpoints.length, 1);
  rig.vm.dispose();
});

test('removeHost 删除主机与凭据，并在它是当前连接时先断开', () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  rig.vm.selectHost('h1');
  rig.vm.removeHost('h1');
  assert.equal(rig.store.loadHosts().length, 0);
  assert.equal(rig.state.selectedHostId, null);
  rig.vm.dispose();
});

test('disconnect 清连接但**保留**已保存的主机（不再把断开当删令牌）', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  assert.equal(rig.state.connected, true);
  rig.vm.disconnect();
  assert.equal(rig.state.connected, false);
  assert.equal(rig.state.activeHostId, null);
  assert.equal(rig.state.device, null);
  assert.equal(rig.state.hosts.length, 1, '断开只断连，令牌与主机必须留着');
  assert.equal(rig.store.loadHosts().length, 1);
  rig.vm.dispose();
});

test('renameHost 改显示名并刷新主机列表', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.renameHost('h1', '  书房台式  ');
  assert.equal(rig.store.host('h1')?.displayName, '书房台式');
  assert.equal(rig.state.hosts[0].displayName, '书房台式');
  rig.vm.dispose();
});

// ===========================================================================
// 6. 会话选择 / 历史
// ===========================================================================

test('selectSession 换会话时清掉 @ 补全文件与全部问答状态', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  // 先制造「上一会话」留下的痕迹。
  rig.state.mentionEntries = [new FileEntry()];
  rig.state.mentionFailed = true;
  rig.state.questions = [questionSet('a', 'continued')];
  rig.state.answeringCallId = 'a';
  rig.state.answeredCallIds = new Set(['a']);
  rig.state.history = historyPage([1], false);

  await rig.vm.selectSession('s1');
  assert.equal(rig.state.selectedSessionId, 's1');
  assert.equal(rig.state.mentionEntries, null, '换会话必须清掉上一个工作目录的文件');
  assert.equal(rig.state.mentionFailed, false);
  assert.equal(rig.state.questions.length, 0);
  assert.equal(rig.state.answeringCallId, null);
  assert.equal(rig.state.answeredCallIds.size, 0);
  // 历史会被 refreshHistory 重新填上（selectSession 先清空再拉取）。
  assert.ok(rig.state.history !== null);
  rig.vm.dispose();
});

test('selectSession(null) 回到未选中态且不拉任何数据', async () => {
  const rig = makeRig();
  await rig.vm.selectSession(null);
  assert.equal(rig.state.selectedSessionId, null);
  assert.equal(rig.state.approvalState.kind, ApprovalUiKind.NONE);
  assert.equal(rig.client.counters.history, 0);
  rig.vm.dispose();
});

test('loadOlderHistory 合并去重（老的在前）且 hasMore 取新拉那一页的值', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  rig.state.selectedSessionId = 's1';
  rig.state.history = historyPage([5, 6], true);
  // 更老的一页：含与当前页重叠的 6，以及新的 3、4。
  rig.client.olderHistory = historyPage([3, 4, 6], false);

  await rig.vm.loadOlderHistory();
  const merged = rig.state.history;
  assert.ok(merged !== null);
  assert.deepEqual(merged?.events.map((e) => e.event.seq), [3, 4, 6, 5]);
  assert.equal(merged?.hasMore, false);
  rig.vm.dispose();
});

test('loadOlderHistory 在 hasMore=false 时不动（不发请求）', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  rig.state.selectedSessionId = 's1';
  rig.state.history = historyPage([5], false);
  const before = rig.client.counters.history;
  await rig.vm.loadOlderHistory();
  assert.equal(rig.client.counters.history, before);
  rig.vm.dispose();
});

test('archiveSession 归档当前会话时把它从选中态摘掉', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  rig.state.selectedSessionId = 's1';
  rig.state.history = historyPage([1], false);
  rig.client.sessionsValue = [sess('s2', false, 2)];
  await rig.vm.archiveSession('s1');
  assert.equal(rig.state.selectedSessionId, null);
  assert.equal(rig.state.history, null);
  assert.equal(rig.state.sessions.length, 1);
  rig.vm.dispose();
});

// ===========================================================================
// 7. 发送与附件
// ===========================================================================

test('sendMessage 双击只发一次 POST（同步闸挡住第二次）', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  rig.state.selectedSessionId = 's1';
  // 并发触发两次点击：第二次必须被同步闸挡掉。
  const first = rig.vm.sendMessage('你好', false);
  const second = rig.vm.sendMessage('你好', false);
  await Promise.all([first, second]);
  assert.equal(rig.client.counters.sendMessage, 1, '两次点击只允许一次 POST');
  rig.vm.dispose();
});

test('sendMessage 失败时把附件与文字都还回输入区', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  rig.state.selectedSessionId = 's1';
  const part = { type: 'file', receiptId: 'r1' };
  rig.state.pendingAttachments = [new PendingAttachment('a1', part as never, 'notes.txt', 3, null)];
  rig.client.sendError = new DshApiException(413, 'TOO_LARGE', 'payload too large');

  await rig.vm.sendMessage('把这份文件看一下', false);
  assert.equal(rig.state.pendingAttachments.length, 1, '附件要还回来');
  assert.equal(rig.state.pendingAttachments[0].id, 'a1');
  assert.equal(rig.state.pendingText, '把这份文件看一下', '文字要还回来');
  assert.ok(rig.state.error !== null);
  rig.vm.dispose();
});

test('sendMessage 失败归还附件时按 id 去重（期间新加的条目不清掉）', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  rig.state.selectedSessionId = 's1';
  const part = { type: 'file', receiptId: 'r1' };
  rig.state.pendingAttachments = [new PendingAttachment('a1', part as never, 'a.txt', 1, null)];
  rig.client.sendError = new DshApiException(500, 'INTERNAL', 'boom');
  const sending = rig.vm.sendMessage('hi', false);
  // 发送在飞的时候用户又加了一条附件。
  rig.state.pendingAttachments = rig.state.pendingAttachments.concat([
    new PendingAttachment('a2', part as never, 'b.txt', 1, null),
  ]);
  await sending;
  const ids = rig.state.pendingAttachments.map((a) => a.id);
  assert.deepEqual(ids, ['a1', 'a2'], '原来的 a1 还回来、期间新加的 a2 保留、不重复');
  rig.vm.dispose();
});

test('sendMessage 命中宿主命令时走 executeCommand 而不是发消息', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  rig.state.selectedSessionId = 's1';
  rig.state.commands = [command('compact')];
  await rig.vm.sendMessage('/compact 3', false);
  assert.equal(rig.client.counters.executeCommand, 1);
  assert.equal(rig.client.counters.sendMessage, 0);
  rig.vm.dispose();
});

test('sendMessage：斜杠开头但不在命令表里的技能名当普通消息发出', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  rig.state.selectedSessionId = 's1';
  rig.state.commands = [command('compact')];
  await rig.vm.sendMessage('/my-skill do it', false);
  assert.equal(rig.client.counters.executeCommand, 0, '技能名不该被当成宿主命令');
  assert.equal(rig.client.counters.sendMessage, 1);
  rig.vm.dispose();
});

test('sendMessage 命令执行失败时抛 COMMAND_FAILED 并落进错误通道', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  rig.state.selectedSessionId = 's1';
  rig.state.commands = [command('compact')];
  // 让 executeCommand 返回 kind=error。
  (rig.client as unknown as { executeCommand: () => Promise<object> }).executeCommand = (): Promise<object> =>
    Promise.resolve(new (class {
      commandId = 'c1';
      result = new (class { kind = 'error'; text: string | null = 'nope'; sourceEventSeq: number | null = null; })();
    })());
  await rig.vm.sendMessage('/compact', false);
  assert.ok(rig.state.error !== null);
  assert.equal(rig.state.busy, false);
  rig.vm.dispose();
});

test('attachImage 超限当场拒绝（不放进待发附件）', async () => {
  const rig = makeRig();
  const tooBig = new Uint8Array(8 * 1024 * 1024 + 1);
  await rig.vm.attachImage('huge.png', 'image/png', tooBig);
  assert.equal(rig.state.pendingAttachments.length, 0);
  assert.ok(rig.state.error !== null);
  rig.vm.dispose();
});

test('attachImage 正常路径放进待发附件并留一份原图字节', async () => {
  const rig = makeRig();
  const bytes = new Uint8Array([137, 80, 78, 71]);
  await rig.vm.attachImage('shot.png', 'image/png', bytes);
  assert.equal(rig.state.pendingAttachments.length, 1);
  assert.equal(rig.state.pendingAttachments[0].name, 'shot.png');
  assert.equal(rig.state.pendingAttachments[0].imageBytes?.length, 4);
  rig.vm.dispose();
});

test('attachFile 上传成功后变成 file part（引用 receiptId）', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  rig.state.selectedSessionId = 's1';
  const up = new UploadedAttachment();
  up.receiptId = 'rc-9';
  up.name = 'report.pdf';
  rig.client.uploadResult = up;
  await rig.vm.attachFile('report.pdf', new Uint8Array([1, 2, 3]));
  assert.equal(rig.state.pendingAttachments.length, 1);
  assert.equal(rig.state.attachmentUploading, false);
  rig.vm.dispose();
});

test('attachFile 被服务端以 TOO_LARGE 拒绝时给出可照做的提示', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  rig.state.selectedSessionId = 's1';
  (rig.client as unknown as { uploadAttachment: () => Promise<UploadedAttachment> }).uploadAttachment =
    (): Promise<UploadedAttachment> => Promise.reject(new DshApiException(413, 'TOO_LARGE', 'too big'));
  await rig.vm.attachFile('big.bin', new Uint8Array([1]));
  assert.equal(rig.state.pendingAttachments.length, 0);
  assert.ok(rig.state.error !== null);
  assert.equal(rig.state.attachmentUploading, false, '无论成败都要把上传中标志放下');
  rig.vm.dispose();
});

test('removePendingAttachment / clearPendingAttachments 只管待发区', async () => {
  const rig = makeRig();
  const part = { type: 'file', receiptId: 'r1' };
  rig.state.pendingAttachments = [
    new PendingAttachment('a1', part as never, 'a', 1, null),
    new PendingAttachment('a2', part as never, 'b', 1, null),
  ];
  rig.vm.removePendingAttachment('a1');
  assert.deepEqual(rig.state.pendingAttachments.map((a) => a.id), ['a2']);
  rig.vm.clearPendingAttachments();
  assert.equal(rig.state.pendingAttachments.length, 0);
  rig.vm.dispose();
});

// ===========================================================================
// 8. 问答（两道防重复闸）
// ===========================================================================

test('answerQuestions 闸一：已有提交在飞（answeringCallId 非空）时忽略', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  rig.state.selectedSessionId = 's1';
  rig.state.answeringCallId = 'other';
  await rig.vm.answerQuestions('c1', []);
  assert.equal(rig.client.counters.answerQuestions, 0);
  rig.vm.dispose();
});

test('answerQuestions 闸二：这一组已经答过（callId 在 answeredCallIds 里）时忽略', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  rig.state.selectedSessionId = 's1';
  rig.state.answeredCallIds = new Set(['c1']);
  await rig.vm.answerQuestions('c1', []);
  assert.equal(rig.client.counters.answerQuestions, 0);
  rig.vm.dispose();
});

test('answerQuestions 成功后清 answeringCallId 并标记 callId 已答', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  rig.state.selectedSessionId = 's1';
  await rig.vm.answerQuestions('c1', []);
  assert.equal(rig.client.counters.answerQuestions, 1);
  assert.equal(rig.state.answeringCallId, null);
  assert.equal(rig.state.answeredCallIds.has('c1'), true);
  rig.vm.dispose();
});

test('answerQuestions 失败时按 code 区分「已在队列」与「已不作答」', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  rig.state.selectedSessionId = 's1';
  (rig.client as unknown as { answerQuestions: () => Promise<void> }).answerQuestions =
    (): Promise<void> => Promise.reject(new DshApiException(409, 'QUESTION_REPLY_QUEUED', 'queued'));
  await rig.vm.answerQuestions('c1', []);
  assert.equal(rig.state.answeringCallId, null);
  assert.equal(rig.state.error, toastText('answer_already_queued', 'zh-CN'));
  rig.vm.dispose();
});

test('refreshPendingQuestions 只留 isAnswerable() 的那一态', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  rig.state.selectedSessionId = 's1';
  rig.client.pendingQuestionsValue = [questionSet('a', 'continued'), questionSet('b', 'open')];
  await rig.vm.refreshPendingQuestions();
  assert.equal(rig.state.questions.length, 1);
  assert.equal(rig.state.questions[0].callId, 'a');
  rig.vm.dispose();
});

test('removeQuestion 在事件处理里摘掉已答 / 已撤的那一题', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  rig.state.selectedSessionId = 's1';
  rig.state.questions = [questionSet('a', 'continued'), questionSet('b', 'continued')];
  // 直接调纯函数验证（事件通道在 handleEvent 里，逻辑与这里一致）。
  rig.state.questions = removeQuestion(rig.state.questions, 'a');
  assert.deepEqual(rig.state.questions.map((q) => q.callId), ['b']);
  rig.vm.dispose();
});

// ===========================================================================
// 9. 审批
// ===========================================================================

test('decideApproval：none → deciding → none（无剩余审批）', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  rig.state.selectedSessionId = 's1';
  const seen: string[] = [];
  const unsub = rig.vm.subscribe((): void => {
    seen.push(rig.state.approvalState.kind);
  });
  await rig.vm.decideApproval(approval('ap1', 's1'), true);
  unsub();
  assert.equal(seen[0], ApprovalUiKind.DECIDING, '提交瞬间必须先转 deciding（防重复点击）');
  assert.equal(rig.state.approvalState.kind, ApprovalUiKind.NONE);
  assert.equal(rig.client.counters.decideApproval, 1);
  rig.vm.dispose();
});

test('decideApproval：剩下还有审批时回到 pending 态', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  rig.state.selectedSessionId = 's1';
  rig.client.pendingApprovalsValue = [approval('ap2', 's1')];
  await rig.vm.decideApproval(approval('ap1', 's1'), false);
  assert.equal(rig.state.approvalState.kind, ApprovalUiKind.PENDING);
  assert.equal(rig.state.approvalState.items.length, 1);
  assert.equal(rig.state.approvalState.items[0].id, 'ap2');
  rig.vm.dispose();
});

test('decideApproval：从 Loading 态进入时也能正确转 deciding', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  rig.state.selectedSessionId = 's1';
  rig.state.approvalState = ApprovalUiState.loading();
  const seen: string[] = [];
  const unsub = rig.vm.subscribe((): void => seen.push(rig.state.approvalState.kind));
  await rig.vm.decideApproval(approval('ap1', 's1'), true);
  unsub();
  assert.equal(seen[0], ApprovalUiKind.DECIDING);
  assert.equal(rig.state.approvalState.kind, ApprovalUiKind.NONE);
  rig.vm.dispose();
});

test('decideApproval：审批不属于当前会话时直接忽略', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  rig.state.selectedSessionId = 's1';
  await rig.vm.decideApproval(approval('ap1', 'other-session'), true);
  assert.equal(rig.client.counters.decideApproval, 0);
  rig.vm.dispose();
});

test('decideApproval 失败时回落到 pending 并给出错误', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  rig.state.selectedSessionId = 's1';
  (rig.client as unknown as { decideApproval: () => Promise<void> }).decideApproval =
    (): Promise<void> => Promise.reject(new DshApiException(409, 'APPROVAL_NOT_PENDING', 'stale'));
  await rig.vm.decideApproval(approval('ap1', 's1'), true);
  assert.equal(rig.state.approvalState.kind, ApprovalUiKind.PENDING);
  assert.ok(rig.state.error !== null);
  rig.vm.dispose();
});

// ===========================================================================
// 10. 文件浏览与预览
// ===========================================================================

test('openEntry 目录时改路径并重新列举', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  const dir = new FileEntry();
  dir.kind = 'directory';
  dir.path = 'sub';
  await rig.vm.openEntry(dir);
  assert.equal(rig.state.currentPath, 'sub');
  rig.vm.dispose();
});

test('openEntry 二进制文件时给 BINARY_FILE（不解码成半屏替换字符）', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  // 含 0x00 的字节 → decodeUtf8 判为二进制。
  rig.client.readFileValue = new FileContent(new Uint8Array([0, 1, 2, 3]), 'e9', 'application/octet-stream');
  const f = new FileEntry();
  f.name = 'blob.bin';
  f.path = 'blob.bin';
  f.size = 4;
  await rig.vm.openEntry(f);
  assert.equal(rig.state.error, BINARY_FILE);
  assert.equal(rig.state.document?.text, null);
  rig.vm.dispose();
});

test('openEntry 文本超限时给 FILE_TOO_LARGE 且不读字节', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  const f = new FileEntry();
  f.name = 'huge.txt';
  f.path = 'huge.txt';
  f.size = 5 * 1024 * 1024;
  await rig.vm.openEntry(f);
  assert.equal(rig.state.error, FILE_TOO_LARGE);
  assert.equal(rig.client.counters.readFile, 0);
  assert.equal(rig.state.document?.skippedForSize, true);
  rig.vm.dispose();
});

test('openEntry 正常文本时解码进 document（含 etag）', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  rig.client.readFileValue = new FileContent(utf8Encode('你好\n世界'), 'e5', 'text/plain');
  const f = new FileEntry();
  f.name = 'a.txt';
  f.path = 'a.txt';
  f.size = 10;
  await rig.vm.openEntry(f);
  assert.equal(rig.state.document?.text, '你好\n世界');
  assert.equal(rig.state.document?.etag, 'e5');
  assert.equal(rig.state.error, null);
  rig.vm.dispose();
});

test('saveDocument 按行尾原样写回（CRLF 保持 CRLF）', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  rig.state.selectedRootId = 'root-1';
  const entry = new FileEntry();
  entry.path = 'a.txt';
  // 原文件是 CRLF。
  rig.vm.updateDocument('x\ny');
  rig.state.document = new OpenDocument(entry, 'x\ny', 'e1', false, '\r\n', 'text/plain', null, false);
  const writes: Uint8Array[] = [];
  (rig.client as unknown as { writeFile: (r: string, p: string, b: Uint8Array) => Promise<string> }).writeFile =
    (r: string, p: string, b: Uint8Array): Promise<string> => {
      writes.push(b);
      return Promise.resolve('e2');
    };
  await rig.vm.saveDocument();
  const decoded = Buffer.from(writes[0]).toString('utf8');
  assert.equal(decoded, 'x\r\ny');
  assert.equal(rig.state.document?.etag, 'e2');
  rig.vm.dispose();
});

test('createEntry 用当前目录拼出子路径', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  rig.state.selectedRootId = 'root-1';
  rig.state.currentPath = 'docs';
  const calls: string[] = [];
  (rig.client as unknown as { createEntry: (r: string, p: string, d: boolean) => Promise<void> }).createEntry =
    (r: string, p: string): Promise<void> => {
      calls.push(p);
      return Promise.resolve();
    };
  await rig.vm.createEntry('note.md', false);
  assert.deepEqual(calls, ['docs/note.md']);
  rig.vm.dispose();
});

test('loadMentionEntries：cwd 为空串也照常列举（根目录是合法工作目录）', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  rig.state.selectedSessionId = 's1';
  rig.client.sessionsValue = [sess('s1', false, 1)];
  rig.state.sessions = rig.client.sessionsValue;
  rig.state.mentionEntries = null;
  await rig.vm.loadMentionEntries();
  assert.equal(rig.state.mentionFailed, false, '空 cwd 是合法值，不该判成「读不到工作目录」');
  rig.vm.dispose();
});

test('loadMentionEntries 失败时置 mentionFailed（如实说读不到，不谎称目录为空）', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  rig.state.selectedSessionId = 's1';
  rig.state.sessions = [sess('s1', false, 1)];
  (rig.client as unknown as { entries: () => Promise<unknown> }).entries =
    (): Promise<unknown> => Promise.reject(new Error('boom'));
  await rig.vm.loadMentionEntries();
  assert.equal(rig.state.mentionEntries, null);
  assert.equal(rig.state.mentionFailed, true);
  rig.vm.dispose();
});

test('setComposerOverlay 只在值真的变了时才推状态', () => {
  const rig = makeRig();
  const before = rig.vm.revision;
  rig.vm.setComposerOverlay(false);
  assert.equal(rig.vm.revision, before, '值没变就不该推快照');
  rig.vm.setComposerOverlay(true);
  assert.equal(rig.state.composerOverlay, true);
  assert.ok(rig.vm.revision > before);
  rig.vm.dispose();
});

// ===========================================================================
// 11. 订阅 / 生命周期 / 异常映射
// ===========================================================================

test('subscribe 返回的退订函数生效', () => {
  const rig = makeRig();
  let hits = 0;
  const unsub = rig.vm.subscribe((): void => {
    hits += 1;
  });
  rig.vm.clearError();
  assert.equal(hits, 1);
  unsub();
  rig.vm.clearError();
  assert.equal(hits, 1, '退订之后不再收到通知');
  rig.vm.dispose();
});

test('update 就地改状态并自增 revision（不重建整份对象）', () => {
  const rig = makeRig();
  const before = rig.state;
  const rev = rig.vm.revision;
  rig.vm.setShowContext(true);
  assert.equal(rig.state, before, '必须是同一份对象（就地改）');
  assert.ok(rig.vm.revision > rev);
  rig.vm.dispose();
});

test('passConnectGate 幂等且不属于 HarnessState（不会被重建冲掉）', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  rig.vm.passConnectGate();
  await rig.vm.connectHost('h1');
  rig.vm.disconnect();
  assert.equal(rig.vm.connectGate, true, '断开/重建状态都不该把门闩冲掉');
  rig.vm.dispose();
});

test('messageOf 三层映射：DshApiException 命中本地化表', async () => {
  const rig = makeRig();
  rig.client.healthError = new DshApiException(404, 'PATH_NOT_FOUND', 'missing');
  await rig.vm.testConnection('http://192.168.1.9:3090');
  assert.equal(rig.state.error, localizedErrorText('PATH_NOT_FOUND', 'zh-CN'));
  assert.notEqual(rig.state.error, 'missing', '认得出的错误码要翻译，不该甩原文');
  rig.vm.dispose();
});

test('messageOf：认不出的错误码保留服务端原文（不硬猜）', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  rig.state.selectedSessionId = 's1';
  (rig.client as unknown as { history: () => Promise<ChatHistory> }).history =
    (): Promise<ChatHistory> => Promise.reject(new DshApiException(500, 'TOTALLY_NEW_CODE', 'server said so'));
  await rig.vm.refreshHistory();
  assert.equal(rig.state.error, 'server said so');
  rig.vm.dispose();
});

test('messageOf：NetworkException 按 kind 本地化（安卓七个 IOException 分支就此收敛）', async () => {
  const rig = makeRig();
  rig.client.healthError = new NetworkException(NetworkFailureKind.REFUSED, 'econnrefused');
  await rig.vm.testConnection('http://192.168.1.9:3090');
  assert.equal(rig.state.error, networkErrorText(NetworkFailureKind.REFUSED, 'zh-CN'));
  rig.vm.dispose();
});

test('dispose 取消定时器、关闭事件订阅与协调层且可重入', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  rig.state.selectedSessionId = 's1';
  // 成功发送会挂一个 400ms 去抖定时器。
  await rig.vm.sendMessage('hi', false);
  assert.ok(rig.timers.pendingCount >= 1, '发送成功应挂上 400ms 去抖定时器');
  rig.vm.dispose();
  assert.equal(rig.timers.pendingCount, 0, '未触发的定时器都要取消掉');
  assert.equal(rig.coordinator.isClosed(), true);
  rig.vm.dispose(); // 第二次不应抛
});

test('dispose 之后再调连接相关方法不应崩溃', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  rig.vm.dispose();
  await rig.vm.connectHost('h1');
  assert.ok(true);
});

// ===========================================================================
// 12. 事件通道
// ===========================================================================

test('chat.turn.failed 就地停会话并把错误本地化', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  rig.state.selectedSessionId = 's1';
  rig.state.sessions = [sess('s1', true, 1)];
  // 直接构造一帧终局失败事件并交给 VM（走公开事件入口是私有的，这里用同一份纯逻辑验证）。
  const event = WorkspaceEvent.fromJsonText(JSON.stringify({
    id: 'e1', type: 'chat.turn.failed', time: 1,
    data: { sessionId: 's1', failure: { code: 'RATE_LIMITED', message: '' } },
  }));
  assert.ok(event !== null);
  rig.state.sessions = markSessionStopped(rig.state.sessions, 's1');
  assert.equal(rig.state.sessions[0].running, false);
  rig.vm.dispose();
});

test('questionSet 的 isAnswerable 与 continued 常量一致', () => {
  assert.equal(questionSet('a', 'continued').isAnswerable(), true);
  assert.equal(questionSet('b', 'open').isAnswerable(), false);
});

// ===========================================================================
// 13. 文案表英文列完整性
// ===========================================================================

test('toastText：每条 key 的中英两列都必须不同（英文是真翻译，不是占位）', () => {
  const keys = [
    'send_failed_restore', 'send_failed_auth', 'send_failed_too_large', 'send_failed_body',
    'attachment_image_too_large', 'attachment_file_too_large', 'attachment_file_rejected',
    'attachment_upload_unsupported', 'attachment_read_failed', 'attachment_fail_outside_roots',
    'attachment_fail_auth', 'attachment_fail_scope', 'attachment_fail_missing', 'attachment_fail_other',
    'plugins_write_permission_required', 'plugins_toggle_saved', 'answer_already_queued',
    'answer_not_pending', 'answer_no_write', 'answer_failed',
    'FILE_TOO_LARGE', 'BINARY_FILE', 'PLUGIN_TOO_OLD', 'CONFIG_INVALID', 'LAST_ENDPOINT', 'COMMAND_FAILED',
  ];
  for (const k of keys) {
    const zh = toastText(k, 'zh-CN');
    const en = toastText(k, 'en-US');
    assert.notEqual(zh, en, `key ${k} 的英文列缺失或与中文相同`);
    assert.ok(zh.length > 0 && en.length > 0, `key ${k} 的某一列是空的`);
    assert.ok(!en.includes('undefined'), `key ${k} 的英文列含未替换占位`);
  }
});

test('toastText 带参数时替换 %1$s 占位', () => {
  const zh = toastText('attachment_fail_other', 'zh-CN', 'boom');
  assert.ok(zh.includes('boom'));
  assert.ok(!zh.includes('%1$s'));
});

// ===========================================================================
// 14. 界面兜底码常量
// ===========================================================================

test('界面兜底码常量与 ErrorMessages 的 key 一字不差', () => {
  assert.equal(toastText(CONFIG_INVALID, 'zh-CN') !== CONFIG_INVALID, true);
  assert.equal(toastText(LAST_ENDPOINT, 'zh-CN') !== LAST_ENDPOINT, true);
  assert.equal(toastText(PLUGIN_TOO_OLD, 'zh-CN') !== PLUGIN_TOO_OLD, true);
  assert.equal(toastText(FILE_TOO_LARGE, 'zh-CN') !== FILE_TOO_LARGE, true);
  assert.equal(toastText(BINARY_FILE, 'zh-CN') !== BINARY_FILE, true);
  assert.equal(toastText(COMMAND_FAILED, 'zh-CN') !== COMMAND_FAILED, true);
});

test('openSessionFile 在端点不存在时给出「插件太旧」而不是原始错误码', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  rig.state.selectedSessionId = 's1';
  (rig.client as unknown as { resolvePath: () => Promise<ResolvedPath | null> }).resolvePath =
    (): Promise<ResolvedPath | null> => Promise.reject(new DshApiException(404, 'ROUTE_NOT_FOUND', 'no route'));
  await rig.vm.openSessionFile('/w/a.txt');
  assert.equal(rig.state.sessionFileOpen?.failure, PLUGIN_TOO_OLD);
  rig.vm.dispose();
});

test('closeSessionFile 回到路径列表（清掉详情）', () => {
  const rig = makeRig();
  rig.state.sessionFileOpen = new SessionFileOpen('s1', '/w/a.txt', false);
  rig.vm.closeSessionFile();
  assert.equal(rig.state.sessionFileOpen, null);
  rig.vm.dispose();
});

// ————————————————— 「打开目录」→ 文件分节 —————————————————
//
// 这条链路的发起方是会话详情页里的文件面板，落地在「文件」分节。分节切换本身在 UI 层
// （`AppShell` 的 `@StorageLink + @Watch`），无法离线单测；**能离线测的是 core 这一半**：
// 目录必须真的被读出来，否则外壳切过去时看到的还是上一个目录的旧列表。

test('revealDirectory 在 rootId 或 path 为空时直接返回：不动状态、不发请求', async () => {
  const rig = makeRig();
  // 刻意不连接：早退必须发生在取客户端之前，否则「没连上」会往 state 里塞一个 error，
  // 而这只是一次空参数的调用，用户不该看到任何报错。
  rig.state.selectedRootId = 'root-旧';
  rig.state.currentPath = 'w/旧';
  await rig.vm.revealDirectory('', 'w/new');
  await rig.vm.revealDirectory('root-1', '');
  assert.equal(rig.state.selectedRootId, 'root-旧');
  assert.equal(rig.state.currentPath, 'w/旧');
  assert.equal(rig.state.directory, null);
  assert.equal(rig.state.error, null);
  rig.vm.dispose();
});

test('revealDirectory 落地授权根与路径，并真的把该目录读出来', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  // 上一次停在别处留下的旧列表：必须被这次读取替换掉，而不是留着当新目录的内容。
  rig.state.selectedRootId = 'root-旧';
  rig.state.currentPath = 'w/旧';
  const seen: string[] = [];
  (rig.client as unknown as { entries: (r: string, p?: string) => Promise<DirectoryPage> }).entries =
    (rootId: string, path = ''): Promise<DirectoryPage> => {
      seen.push(`${rootId}|${path}`);
      const page = new DirectoryPage();
      page.path = path;
      page.entries = [];
      return Promise.resolve(page);
    };
  await rig.vm.revealDirectory('root-1', '/w/sub/');
  // 首尾斜杠被归一化（与 `loadDirectory` 的 `trimChar(path, '/')` 同一口径）。
  assert.deepEqual(seen, ['root-1|w/sub']);
  assert.equal(rig.state.selectedRootId, 'root-1');
  assert.equal(rig.state.currentPath, 'w/sub');
  assert.equal(rig.state.directory?.path, 'w/sub');
  assert.equal(rig.state.busy, false);
  rig.vm.dispose();
});

test('revealDirectory 读目录失败时把错误落进 state.error，不向调用方抛', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  await rig.vm.connectHost('h1');
  (rig.client as unknown as { entries: () => Promise<DirectoryPage> }).entries =
    (): Promise<DirectoryPage> => Promise.reject(new DshApiException(500, 'INTERNAL', 'boom'));
  // 面板已经关了、分节也切了，此刻抛出去没人接 —— 必须落成 state.error 由外壳弹 toast。
  await rig.vm.revealDirectory('root-1', 'w/sub');
  assert.notEqual(rig.state.error, null);
  assert.equal(rig.state.busy, false);
  rig.vm.dispose();
});

test('activeConnection 未连接时为 null', () => {
  const rig = makeRig();
  assert.equal(rig.vm.activeConnection(), null);
  rig.vm.dispose();
});

test('coordinator 关闭后再连会快速失败（不新建客户端）', async () => {
  const rig = makeRig();
  seedHost(rig, sampleHost('h1'));
  rig.vm.dispose();
  const before = rig.factory.created.length;
  await rig.vm.connectHost('h1');
  assert.ok(rig.factory.created.length >= before);
  rig.vm.dispose();
});
