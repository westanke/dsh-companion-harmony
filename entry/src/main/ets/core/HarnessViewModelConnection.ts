/**
 * 界面主状态机 —— **第 6 层：连接管理 + 启动恢复 + 事件流**（从 `HarnessViewModel.ts` 拆出）。
 *
 * 三件事放在一起，是因为它们在服务端是一个整体：**事件流是连接的产物**，
 * 而连接失败要靠事件流的重连路径兜底 —— 拆成两个文件会出现互相调用（继承链只能单向），
 * 所以这里坦率地合成一层。
 *
 * | 组 | 成员 |
 * | --- | --- |
 * | 连接管理 | `setEndpointDraft` / `testConnection` / `pair` / `importConfiguration` / `connectHost` / 地址与主机的增删改查 / `connectHostInternal` / `applyProbes` / `hostFromPairing` / `disconnect` / `clearError` / `refreshDashboard` |
 * | 启动恢复 | `restoreConnection`（读回主机、必要时迁移旧版数据、自动连最近用过的一台） |
 * | 事件流 | `pauseEvents` / `resumeEvents` / `connectEvents` / `handleConnection` / `handleEvent` / `handleTurnFailed` / `loadSnapshot` / `dispose` |
 *
 * 它排在最后，是因为它要用前面每一层的东西（会话命令刷新、目录读取、运行态查询……
 * 见 `HarnessViewModel.ts` 文件头的继承链说明）。`HarnessViewModel` 只是它加了一个空壳。
 *
 * 拆分来龙去脉见 `HarnessViewModel.ts`。
 */

import {
  AgentPreset,
  ChatHistory,
  ChatSession,
  ChatWorkspace,
  DeviceView,
  DirectoryPage,
  PairingResult,
  PluginInventory,
  ProviderSettings,
  RootView,
  TrashEntry,
  WorkspaceEvent,
  eventDataInt,
  eventDataString,
} from './Models';
import {
  BridgeCapabilities,
  parseBridgeCapabilities,
} from './BridgeCapabilities';
import {
  SeqVerdict,
  baselineBehind,
  seqVerdict,
} from './ChatSeqMonitor';
import {
  DshClient,
} from './DshClient';
import {
  ActiveConnection,
  DshConnectionException,
} from './ConnectionCoordinator';
import {
  Credential,
  CredentialKind,
  Endpoint,
  EndpointProbe,
  Host,
} from './ConnectionModels';
import {
  LegacyConnectionMigration,
} from './ConnectionStorage';
import {
  ConnectionShare,
  SharePayload,
} from './ConnectionShare';
import {
  normalizeEndpoint,
  stripApiSuffix,
} from './EndpointUrl';
import {
  ChatDelta,
  ChatTurnFailure,
  LiveChatState,
  chatDelta,
  chatTurnFailure,
} from './ChatPresentation';
import {
  isBlank,
  trimText,
} from './TextPredicates';
import {
  localizedErrorText,
  toastText,
} from './ErrorMessages';
import {
  SEND_MODE_QUEUE,
} from './ComposerSendPolicy';
import {
  HarnessState,
  CONFIG_INVALID,
  LAST_ENDPOINT,
} from './HarnessTypes';
import {
  LiveKey,
  QUESTION_REFRESH_EVENTS,
  removeQuestion,
  isToolResultFrame,
  markSessionStopped,
} from './HarnessHelpers';
import { HarnessViewModelComposer } from './HarnessViewModelComposer';

export class HarnessViewModelConnection extends HarnessViewModelComposer {
  /** 覆盖基类钩子：真正的实现在本文件的 `restoreConnection`。 */
  protected startRestore(): void {
    void this.restoreConnection();
  }

  // ————————————————— 连接管理 —————————————————

  setEndpointDraft(value: string): void {
    this.update((s: HarnessState): void => {
      s.endpointDraft = value;
      s.healthOk = false;
      s.error = null;
    });
  }

  async testConnection(endpoint: string): Promise<void> {
    await this.launchOperation(async (): Promise<void> => {
      const normalized: string = normalizeEndpoint(endpoint);
      await this.deps.clientFactory.create(normalized, null).health();
      this.update((s: HarnessState): void => {
        s.endpointDraft = stripApiSuffix(normalized);
        s.healthOk = true;
      });
    });
  }

  /**
   * 用一次性配对码把一台电脑加进来并连接。
   *
   * 配对码适合「电脑就在手边」的场合（同一局域网，或你正坐在电脑前）。
   * 人已经出门在外、看不到电脑屏幕时请改用 `importConfiguration`。
   */
  async pair(endpoint: string, code: string, deviceName: string): Promise<void> {
    await this.launchOperation(async (): Promise<void> => {
      if (isBlank(code)) {
        throw new Error('Pairing code is required.');
      }
      if (isBlank(deviceName)) {
        throw new Error('Device name is required.');
      }
      const unauthenticated: DshClient = this.deps.clientFactory.create(endpoint, null);
      await unauthenticated.health();
      const pairing: PairingResult = await unauthenticated.pair(code, deviceName);
      const host: Host = this.hostFromPairing(unauthenticated.endpoint, pairing.token, pairing.device, deviceName);
      this.deps.hostStore.upsert(host);
      this.update((s: HarnessState): void => {
        s.hosts = this.deps.hostStore.loadHosts();
        s.selectedHostId = host.id;
      });
      await this.connectHostInternal(host, pairing.device);
    });
  }

  /**
   * 导入一段配置文本（形如 `DSH1:...`），把一台电脑加进来并连接。
   *
   * 这是取代扫码的主路径：配置文本可以在电脑上生成后发给自己，到了外面再粘贴。
   * 全程不需要电脑在旁边，也不需要摄像头。
   */
  async importConfiguration(text: string): Promise<void> {
    await this.launchOperation(async (): Promise<void> => {
      const payload: SharePayload | null = ConnectionShare.decode(text);
      if (payload === null) {
        throw new Error(CONFIG_INVALID);
      }
      const host: Host = ConnectionShare.buildHost(payload);
      this.deps.hostStore.upsert(host);
      this.update((s: HarnessState): void => {
        s.hosts = this.deps.hostStore.loadHosts();
        s.selectedHostId = host.id;
      });
      await this.connectHostInternal(host);
    });
  }

  /** 连接已保存的某台电脑：并发探活其全部地址并自动选路。 */
  async connectHost(hostId: string): Promise<void> {
    await this.launchOperation(async (): Promise<void> => {
      const host: Host | null = this.deps.hostStore.host(hostId);
      if (host === null) {
        return;
      }
      this.update((s: HarnessState): void => {
        s.selectedHostId = hostId;
      });
      await this.connectHostInternal(host);
    });
  }

  /** 给某台电脑追加一个可达地址（例如新增虚拟网地址）。 */
  async addEndpoint(hostId: string, label: string, baseUrl: string): Promise<void> {
    await this.launchOperation(async (): Promise<void> => {
      const host: Host | null = this.deps.hostStore.host(hostId);
      if (host === null) {
        return;
      }
      const normalized: string = stripApiSuffix(normalizeEndpoint(baseUrl));
      for (let i = 0; i < host.endpoints.length; i++) {
        if (host.endpoints[i].baseUrl === normalized) {
          return;
        }
      }
      const endpoint: Endpoint = Endpoint.create(label, normalized, `ep-${this.deps.newId()}`);
      const next: Host = host.copy();
      next.endpoints = host.endpoints.concat([endpoint]);
      next.updatedAt = this.deps.now();
      this.deps.hostStore.upsert(next);
      this.update((s: HarnessState): void => {
        s.hosts = this.deps.hostStore.loadHosts();
      });
    });
  }

  /** 删除某台电脑的一个地址。保留最后一个地址的行为由界面负责拦截。 */
  async removeEndpoint(hostId: string, endpointId: string): Promise<void> {
    await this.launchOperation(async (): Promise<void> => {
      const host: Host | null = this.deps.hostStore.host(hostId);
      if (host === null) {
        return;
      }
      if (host.endpoints.length <= 1) {
        throw new Error(LAST_ENDPOINT);
      }
      const endpoints: Endpoint[] = [];
      for (let i = 0; i < host.endpoints.length; i++) {
        if (host.endpoints[i].id !== endpointId) {
          endpoints.push(host.endpoints[i]);
        }
      }
      let preferred: string | null = host.preferredEndpointId;
      if (preferred !== null) {
        let found: boolean = false;
        for (let i = 0; i < endpoints.length; i++) {
          if (endpoints[i].id === preferred) {
            found = true;
            break;
          }
        }
        if (!found) {
          preferred = null;
        }
      }
      const next: Host = host.copy();
      next.endpoints = endpoints;
      next.preferredEndpointId = preferred;
      next.updatedAt = this.deps.now();
      this.deps.hostStore.upsert(next);
      this.update((s: HarnessState): void => {
        s.hosts = this.deps.hostStore.loadHosts();
      });
    });
  }

  /** 重命名一台电脑。 */
  async renameHost(hostId: string, displayName: string): Promise<void> {
    await this.launchOperation(async (): Promise<void> => {
      const host: Host | null = this.deps.hostStore.host(hostId);
      if (host === null) {
        return;
      }
      const next: Host = host.copy();
      next.displayName = trimText(displayName);
      next.updatedAt = this.deps.now();
      this.deps.hostStore.upsert(next);
      this.update((s: HarnessState): void => {
        s.hosts = this.deps.hostStore.loadHosts();
      });
    });
  }

  /**
   * 删除一台电脑（含其凭据）。
   *
   * 与 `disconnect` 分开：断开只是断连，删除才是抹掉令牌。
   */
  removeHost(hostId: string): void {
    if (this.state.activeHostId === hostId) {
      this.disconnect();
    }
    this.deps.hostStore.remove(hostId);
    this.update((s: HarnessState): void => {
      s.hosts = this.deps.hostStore.loadHosts();
      s.selectedHostId = s.selectedHostId === hostId ? null : s.selectedHostId;
    });
  }

  selectHost(hostId: string | null): void {
    this.update((s: HarnessState): void => {
      s.selectedHostId = hostId;
    });
  }

  /**
   * 把当前连接状态落回主机记录：探活结果 + 实际选中的地址。
   */
  protected async connectHostInternal(host: Host, device: DeviceView | null = null): Promise<void> {
    console.info('[DSH] connect start ' + host.id);
    this.update((s: HarnessState): void => {
      s.connecting = true;
      s.endpointProbes = [];
      s.error = null;
    });
    let connection: ActiveConnection;
    try {
      connection = await this.deps.coordinator.connect(host);
    } catch (failure) {
      const probes: EndpointProbe[] = failure instanceof DshConnectionException ? failure.probes : [];
      if (probes.length > 0) {
        this.deps.hostStore.upsert(this.applyProbes(host, probes));
      }
      this.update((s: HarnessState): void => {
        s.connecting = false;
        // 冷启动的自动重连失败走的正是这条路，而它是**正常返回**（不抛异常），
        // 所以 restoreConnection 的兜底接不住 —— 不在这里复位，restoring 会一直停在 true。
        s.restoring = false;
        s.hosts = this.deps.hostStore.loadHosts();
        s.endpointProbes = probes;
        s.error = this.messageOf(failure as Object);
      });
      return;
    }
    console.info('[DSH] connect probed, endpoint=' + connection.endpoint.id);
    const recorded: Host = this.applyProbes(connection.host, connection.probes)
      .withPreferred(connection.endpoint.id);
    this.deps.hostStore.upsert(recorded);
    // 探测成功 ≠ 连接完成：取设备信息与拉快照是普通 HTTP，**同样可能失败**。这两步若抛
    // 异常而只靠外层（launchOperation / restoreConnection）兜底，外层不会复位 `connecting`
    // —— UI 就永远停在「正在探测 N 个地址…」、连接按钮一直禁用（真机踩坑，见 PORT-MAP
    // 坑 18）。所以在这里就地收口：失败也把连接态复位干净。
    try {
      const resolved: DeviceView = device !== null ? device : await connection.client.currentDevice();
      console.info('[DSH] connect device ok scopes=' + resolved.scopes.join(','));
      const snapshot: HarnessState = await this.loadSnapshot(connection.client, resolved);
      console.info('[DSH] connect snapshot ok');
      this.active = connection;
      // 换主机 = 换上下文：连上之前发出的请求（上一次连接的快照、目录、历史）结果作废。
      // 换主机比换会话更彻底 —— 连上限流/配额失败的那次连接，它的在飞响应不该写进新连接的状态。
      this.requestGate.invalidate();
      this.update((s: HarnessState): void => {
        s.copyFrom(snapshot);
        s.restoring = false;
        s.busy = true;
        s.connecting = false;
        s.connected = true;
        s.healthOk = true;
        s.hosts = this.deps.hostStore.loadHosts();
        s.activeHostId = recorded.id;
        s.activeEndpointId = connection.endpoint.id;
        s.endpointProbes = connection.probes;
      });
    } catch (failure) {
      console.error('[DSH] connect post-probe FAIL: ' + String(failure));
      this.active = null;
      this.update((s: HarnessState): void => {
        s.restoring = false;
        s.connecting = false;
        s.connected = false;
        s.error = this.messageOf(failure as Object);
      });
      return;
    }
    console.info('[DSH] connect done, opening events');
    this.connectEvents(connection.client);
    // 走到这里连接已完全就绪（设备信息 / 快照 / 事件流都到位），`busy` 的语义「有请求在跑」
    // 不再成立，必须复位。不复位的话冷启动自动重连（`restoreConnection` 直接调用本方法、
    // **没有** launchOperation 那层收尾）会把 `busy = true` 一直留给用户：连接页的
    // 🗑「删除」是灰的、主界面会话列表每一行也点不动（它们的 enabled 都含 `!state.busy`）
    // —— 用户看到的就是「删除连接信息点了没反应」（真机踩坑，见 PORT-MAP 坑 19）。
    // 手动连接那条路有 launchOperation 兜尾，这里再置一次是同值、无副作用。
    this.update((s: HarnessState): void => {
      s.busy = false;
    });
  }

  protected applyProbes(host: Host, probes: EndpointProbe[]): Host {
    let acc: Host = host;
    for (let i = 0; i < probes.length; i++) {
      const p: EndpointProbe = probes[i];
      acc = acc.withEndpointProbe(p.endpointId, p.latencyMs, p.error, this.deps.now());
    }
    return acc;
  }

  protected hostFromPairing(endpoint: string, token: string, device: DeviceView,
                          displayName: string): Host {
    const now: number = this.deps.now();
    const baseUrl: string = stripApiSuffix(normalizeEndpoint(endpoint));
    const endpointId: string = 'ep-paired';
    const hosts: Host[] = this.deps.hostStore.loadHosts();
    let existing: Host | null = null;
    for (let i = 0; i < hosts.length; i++) {
      if (hosts[i].id === `host-${device.id}`) {
        existing = hosts[i];
        break;
      }
    }
    const trimmed: string = trimText(displayName);
    // 主机名优先用用户填的设备名，其次是电脑自己报的名字（对应 Kotlin 的 orEmpty 兜底）。
    const finalName: string = trimmed.length > 0 ? trimmed : device.name;
    // `Endpoint.create` 会在 label 为空时退回 baseUrl，所以这里直接拿主机名当标签。
    const issuedAt: number = existing !== null && existing.credential !== null && existing.credential.issuedAt > 0
      ? existing.credential.issuedAt : now;
    const credential: Credential = new Credential(CredentialKind.DEVICE_TOKEN, token, device.id,
      device.name, device.scopes, issuedAt, null);
    return new Host(`host-${device.id}`, finalName,
      [Endpoint.create(finalName, baseUrl, endpointId)], endpointId, credential,
      existing !== null ? existing.createdAt : now, now);
  }

  /**
   * 断开当前连接。
   *
   * 注意**不再清除已保存的主机**：旧实现把「断开」和「删除令牌」绑成一个动作，
   * 于是网络抖一下、手点错一次，用户就得重新配对 —— 而配对又要求电脑在身边。
   */
  disconnect(): void {
    if (this.eventSubscription !== null) {
      this.eventSubscription.close();
      this.eventSubscription = null;
    }
    // 手动断开要清掉熄屏暂停标志：否则下次亮屏 resumeEvents 会把用户刚刚主动断开的
    // 连接又接回去 —— 那是最容易让人以为「断开没用」的 bug。
    this.eventsPaused = false;
    this.active = null;
    // 断开 = 上下文作废：在飞的目录/历史/快照请求即使回来了，也没有状态可写（state 即将被重建），
    // 但闸门也要一起打 —— 否则「断开后又立刻连上另一台」时，上一台的响应会写到新连接的状态里。
    this.requestGate.invalidate();
    // 去抖里挂着一次目录刷新时，断开后它到点会拿一个空 `active` 去发请求 —— 先取消掉。
    this.directoryDebouncer.cancel();
    const next: HarnessState = new HarnessState();
    next.restoring = false;
    next.hosts = this.deps.hostStore.loadHosts();
    this.applyPreferences(next);
    this.state.copyFrom(next);
    this.revision = this.revision + 1;
    this.notifyListeners();
  }

  clearError(): void {
    this.update((s: HarnessState): void => {
      s.error = null;
    });
  }

  async refreshDashboard(): Promise<void> {
    await this.withClient(async (api: DshClient): Promise<void> => {
      const device: DeviceView = await api.currentDevice();
      const snapshot: HarnessState = await this.loadSnapshot(api, device);
      const prevSessionId: string | null = this.state.selectedSessionId;
      const prevRootId: string | null = this.state.selectedRootId;
      this.update((s: HarnessState): void => {
        s.copyFrom(snapshot);
        s.restoring = false;
        s.busy = true;
        let keepSession: boolean = false;
        if (prevSessionId !== null) {
          for (let i = 0; i < snapshot.sessions.length; i++) {
            if (snapshot.sessions[i].id === prevSessionId) {
              keepSession = true;
              break;
            }
          }
        }
        s.selectedSessionId = keepSession ? prevSessionId : null;
        let rootOk: boolean = false;
        if (prevRootId !== null) {
          for (let i = 0; i < snapshot.roots.length; i++) {
            if (snapshot.roots[i].id === prevRootId) {
              rootOk = true;
              break;
            }
          }
        }
        s.selectedRootId = rootOk ? prevRootId
          : (snapshot.roots.length > 0 ? snapshot.roots[0].id : null);
      });
    });
  }

  // ————————————————— 启动恢复 / 事件流 —————————————————

  /**
   * 启动时恢复连接：读取已保存的主机（必要时先迁移旧版数据），再自动尝试最近用过的那台。
   *
   * 与旧实现的一个关键差别：旧版在恢复失败时执行 `store.clear()`，把令牌一并删掉。
   * 那意味着「此刻网络不通」会被误判成「凭据失效」—— 用户回到家才发现要重新配对。
   * 现在连不上只保留未连接状态，主机记录不动。
   */
  async restoreConnection(): Promise<void> {
    const hosts: Host[] = await this.loadOrMigrateHosts();
    if (hosts.length === 0) {
      this.update((s: HarnessState): void => {
        s.restoring = false;
      });
      return;
    }
    // updatedAt 会在每次探活后刷新，所以「最近活动过」近似等于「上次用过的」。
    let target: Host = hosts[0];
    for (let i = 1; i < hosts.length; i++) {
      if (hosts[i].updatedAt > target.updatedAt) {
        target = hosts[i];
      }
    }
    const chosen: Host = target;
    this.update((s: HarnessState): void => {
      s.hosts = hosts;
      s.selectedHostId = chosen.id;
      s.endpointDraft = chosen.endpoints.length > 0 ? chosen.endpoints[0].baseUrl : '';
      s.restoring = true;
    });
    try {
      await this.connectHostInternal(chosen);
    } catch (e) {
      const failure: Object = e as Object;
      this.update((s: HarnessState): void => {
        s.restoring = false;
        s.connecting = false;
        s.error = this.messageOf(failure);
      });
    }
  }

  /** 读取主机列表；为空时尝试把旧版单连接数据迁进来。迁移是幂等的。 */
  protected async loadOrMigrateHosts(): Promise<Host[]> {
    const existing: Host[] = this.deps.hostStore.loadHosts();
    if (existing.length > 0) {
      return existing;
    }
    try {
      LegacyConnectionMigration.migrate(this.deps.legacyKeyValueStore, this.deps.legacySecretBox,
        this.deps.hostStore);
      return this.deps.hostStore.loadHosts();
    } catch (e) {
      return [];
    }
  }

  /**
   * 熄屏暂停事件流；亮屏恢复（用户定下的策略：**熄屏=断连，亮屏=实时**）。
   *
   * 为什么不是断开连接：`disconnect()` 会把 `active` 一起清掉，亮屏后得重新走一遍探活 +
   * 配对校验。熄屏时真正费电的只有那条 WebSocket，所以只关流、**保留已建立的连接与令牌**。
   */
  pauseEvents(): void {
    if (this.eventSubscription === null) {
      return;
    }
    this.eventsPaused = true;
    this.eventSubscription.close();
    this.eventSubscription = null;
    // 状态里保留 connected = true：连接本身（主机、令牌、端点）都还在，只是事件流暂停。
  }

  async resumeEvents(): Promise<void> {
    if (!this.eventsPaused) {
      return;
    }
    this.eventsPaused = false;
    const connection: ActiveConnection | null = this.active;
    if (connection === null) {
      return;
    }
    this.connectEvents(connection.client);
    // 补上熄屏期间错过的一切：当前会话的历史 + 会话列表。
    this.chatSessionRefreshPending = true;
    this.scheduleChatRefresh();
    // 还要单独补两类**交互性**状态：审批面板与待答问题。
    await this.refreshPendingApprovals();
    await this.refreshPendingQuestions();
  }

  protected connectEvents(api: DshClient): void {
    if (this.eventSubscription !== null) {
      this.eventSubscription.close();
      this.eventSubscription = null;
    }
    const self: HarnessViewModelConnection = this;
    this.eventSubscription = api.events(
      (event: WorkspaceEvent): void => {
        self.handleEvent(event);
      },
      (connected: boolean): void => {
        self.handleConnection(connected);
      },
    );
  }

  protected handleConnection(connected: boolean): void {
    this.update((s: HarnessState): void => {
      s.eventsConnected = connected;
    });
    if (connected && this.state.selectedSessionId !== null) {
      this.scheduleChatRefresh();
      void this.refreshPendingApprovals();
      // 断线期间问出来的问题要靠这一下补回来。
      void this.refreshPendingQuestions();
      void this.refreshCommands();
    }
  }

  protected handleEvent(event: WorkspaceEvent): void {
    const delta: ChatDelta | null = chatDelta(event);
    if (delta !== null) {
      const d: ChatDelta = delta;
      if (this.state.selectedSessionId === d.sessionId) {
        this.update((s: HarnessState): void => {
          const base: LiveChatState = s.liveChat !== null
            ? s.liveChat : new LiveChatState(d.sessionId, d.turn, d.step);
          s.liveChat = base.append(d);
        });
        // 正文一律走历史那条路（页面只从历史渲染），所以每来一段增量都要让历史跟上，
        // 否则流式文字要等消息落盘才出现。scheduleChatRefresh 自带 400ms 去抖 + 单飞。
        this.scheduleChatRefresh();
      }
    } else if (event.type === 'connection.ready') {
      // 服务端连上就自报版本与能力位。读到就存：缺关键能力时界面要**明说**，
      // 因为「卡片不弹」与「本来就没有待审批」在屏幕上完全一样（源工程踩过，
      // 见 `core/BridgeCapabilities.ts` 文件头）。
      //
      // 读不到（`parseBridgeCapabilities` 返回 null）时**什么都不做**，保持上一次的值 ——
      // 不把「未知」写成「空清单」，那样会让归档入口与警告横幅给出假结论。
      const reported: BridgeCapabilities | null = parseBridgeCapabilities(event.dataMap());
      if (reported !== null) {
        const caps: BridgeCapabilities = reported;
        this.update((s: HarnessState): void => {
          s.bridgeVersion = caps.bridgeVersion === null ? s.bridgeVersion : caps.bridgeVersion;
          s.bridgeCapabilities = caps.capabilities;
        });
      }
    } else if (event.type.startsWith('chat.')) {
      const sessionId: string | null = eventDataString(event, 'sessionId');
      // ——— 断档检测 ———
      //
      // WS 是「订阅之后才收得到」，REST 历史是「发请求那一刻的快照」——
      // 两者的时间差里发生的事件**谁都管不着**，除非客户端能自己发现「我漏了一段」。
      // 判据、以及「为什么重复和倒退不算断档」，见 `core/ChatSeqMonitor.ts`。
      //
      // 只对**当前会话**计数：别的会话有自己的序号序列，混在一起必然误判。
      const incomingSeq: number | null = eventDataInt(event, 'seq');
      if (incomingSeq !== null && sessionId === this.state.selectedSessionId) {
        const seq: number = incomingSeq;
        if (seqVerdict(this.state.lastEventSeq, seq) === SeqVerdict.RESYNC) {
          // 重取历史。`scheduleChatRefresh` 自带 400ms 去抖 + 单飞，连续跳号也只会合并成一次。
          this.chatSessionRefreshPending = true;
          this.scheduleChatRefresh();
        }
        this.update((s: HarnessState): void => {
          s.lastEventSeq = seq;
        });
      }
      if (event.type === 'chat.session.snapshot') {
        // 订阅基线：服务端告诉我们「这条订阅从哪个持久 seq 开始接增量」。
        // 本地历史落后于它 ⇒「拉历史」与「订阅」之间的窗口**真漏了**事件，重取一次。
        const cursor: number | null = eventDataInt(event, 'cursor');
        if (cursor !== null && sessionId !== null) {
          const value: number = cursor;
          this.update((s: HarnessState): void => {
            s.baselineCursor = value;
          });
          if (sessionId === this.state.selectedSessionId) {
            const history: ChatHistory | null = this.state.history;
            let localMax: number | null = null;
            if (history !== null) {
              for (let i = 0; i < history.events.length; i++) {
                const seq: number = history.events[i].event.seq;
                if (localMax === null || seq > localMax) {
                  localMax = seq;
                }
              }
            }
            if (baselineBehind(localMax, value)) {
              this.chatSessionRefreshPending = true;
              this.scheduleChatRefresh();
            }
          }
        }
      } else if (event.type === 'chat.deliverables.presented') {
        // 交付物（内核 `present` 工具）：卡片数据在**历史**里，收到这条就刷新一次，
        // 新交付物立刻出现在会话文件卡片里。此前这个事件名客户端不认识 ——
        // 数据一直在历史里原样透传，只是要等下一次消息完成才顺带刷到。
        if (sessionId === this.state.selectedSessionId) {
          this.chatSessionRefreshPending = true;
          this.scheduleChatRefresh();
        }
      } else if (event.type === 'chat.message.committed') {
        if (sessionId !== null && sessionId === this.state.selectedSessionId) {
          if (eventDataString(event, 'role') === 'assistant') {
            const turn: number | null = eventDataInt(event, 'turn');
            const step: number | null = eventDataInt(event, 'step');
            if (turn !== null && step !== null) {
              this.liveFinalizeTarget = new LiveKey(sessionId, turn, step);
            }
          }
          this.scheduleChatRefresh();
        }
      } else if (event.type === 'chat.turn.start' || event.type === 'chat.turn.end'
        || event.type === 'chat.session.status') {
        this.chatSessionRefreshPending = true;
        this.scheduleChatRefresh();
        // 「这一轮刚结束」= 会话已不在运行。这是工具结果帧那条路的兜底：在轮次结束的
        // **那一刻**补拉一次，之后彻底停止 —— 不是轮询。
        if (event.type === 'chat.turn.end' && sessionId !== null && !this.isSessionRunning(sessionId)) {
          void this.refreshPendingQuestions();
        }
      } else if (event.type === 'chat.agent-preset.selected') {
        this.chatSessionRefreshPending = true;
        this.scheduleChatRefresh();
        if (sessionId === this.state.selectedSessionId) {
          void this.refreshSessionModels();
        }
      } else if (event.type === 'chat.turn.failed') {
        this.handleTurnFailed(event, sessionId);
      } else if (event.type === 'chat.approval.requested' || event.type === 'chat.approval.resolved') {
        this.chatSessionRefreshPending = true;
        this.scheduleChatRefresh();
        if (sessionId === this.state.selectedSessionId) {
          void this.refreshPendingApprovals();
        }
      } else if (sessionId === this.state.selectedSessionId) {
        this.scheduleChatRefresh();
      }

      // 待答问题的刷新靠事件驱动，**不引定时器、不轮询**：一条相关事件一次 GET。
      // `chat.session.event` 是插件给所有「非特殊」会话事件的统一降级形态，
      // `tool/result` 走的正是它。这里按 eventType 精确挑出工具结果，不做「来一帧就拉一次」。
      if (QUESTION_REFRESH_EVENTS.has(event.type) || isToolResultFrame(event.type, event.data)) {
        void this.refreshPendingQuestions();
      }
      // 插件为问答推的**专属帧**：提问一落地就能拿到通知；答完之后卡片也能**立刻**消失。
      if (event.type === 'chat.userQuestions/requested') {
        void this.refreshPendingQuestions();
      } else if (event.type === 'chat.userQuestions/answered' || event.type === 'chat.userQuestions/dismissed') {
        // 这两帧是「这道题已经不用答了」的确定性事实 —— 直接摘掉，不必等一次网络往返。
        const callId: string | null = eventDataString(event, 'callId');
        if (callId !== null) {
          this.update((s: HarnessState): void => {
            s.questions = removeQuestion(s.questions, callId);
          });
        }
      }
    }
    if (event.type.startsWith('file.')) {
      // 内核批量改文件时会连着推很多帧（构建产物、批量格式化），每帧都重取一次目录
      // 就是请求风暴。去抖到「安静 500ms」后只取一次（见 `core/EventDebouncer.ts`）。
      this.directoryDebouncer.trigger();
    }
  }

  /**
   * 终局失败帧（限流 429、配额用尽、密钥无效、登出停止）的就地处理。
   *
   * 为什么必须在这里就地处理、而不是等 `chat.turn.end`：插件为失败发的**就是**这一帧，
   * `chat.turn.end` 那一帧在失败时不再发。做三件事：
   * 1) 立即把会话标记为不在运行（本地置位，不等下一次 GET）；
   * 2) 走全局错误通道让用户看见那句话；
   * 3) 拉一次历史与待答问题。
   */
  protected handleTurnFailed(event: WorkspaceEvent, sessionId: string | null): void {
    const failure: ChatTurnFailure | null = chatTurnFailure(event);
    if (failure === null) {
      return;
    }
    const f: ChatTurnFailure = failure;
    if (sessionId !== null) {
      const sid: string = sessionId;
      this.update((s: HarnessState): void => {
        s.sessions = markSessionStopped(s.sessions, sid);
        if (s.selectedSessionId === sid) {
          s.liveChat = null;
          s.busySendMode = SEND_MODE_QUEUE;
        }
      });
    }
    if (sessionId === this.state.selectedSessionId) {
      // 流式缓冲清掉：失败之后留着半截文字，用户会以为「它还在说，只是慢」。
      // 出错文案跟随界面语言：先按错误码本地化，命不中才用内核原文。
      const localized: string | null = localizedErrorText(f.code, this.lang());
      let message: string;
      if (localized === null) {
        message = f.message.length > 0 ? f.message : toastText(f.titleKey, this.lang());
      } else {
        message = localized;
      }
      this.notify(message);
      // 挂起的提问卡片也要撤：这一轮已经结束了，卡片继续挂着会让人以为问题还有效。
      void this.refreshPendingQuestions();
    }
    this.chatSessionRefreshPending = true;
    this.scheduleChatRefresh();
  }

  protected async loadSnapshot(api: DshClient, device: DeviceView): Promise<HarnessState> {
    const canReadFiles: boolean = device.scopes.indexOf('files.read') >= 0;
    const canReadChat: boolean = device.scopes.indexOf('chat.read') >= 0;
    const canReadSettings: boolean = device.scopes.indexOf('settings.read') >= 0;
    // 这些快照请求**互不依赖**，全部并行发出 —— 原版串行 await（最多 7 个请求排队）在局域网
    // 上也要累加每个请求的往返，用户体感就是连接页的「正在探测…」挂好几秒（真机反馈：
    // 「局域网应该 1 秒左右就好」）。写法上先启动全部 Promise、再逐个 await：已完成的
    // promise await 起来是零开销，错误也仍从对应的那一个 await 点抛出（与串行版一致）。
    // 唯一的依赖链是 `entries()` 要等 `roots()` 给出第一个根目录，所以单独放第二波。
    const rootsP: Promise<RootView[]> = canReadFiles ? api.roots() : Promise.resolve<RootView[]>([]);
    const sessionsP: Promise<ChatSession[]> = canReadChat ? api.sessions() : Promise.resolve<ChatSession[]>([]);
    const workspacesP: Promise<ChatWorkspace[]> = canReadChat
      ? api.chatWorkspaces() : Promise.resolve<ChatWorkspace[]>([]);
    const presetsP: Promise<AgentPreset[]> = canReadChat
      ? api.agentPresets() : Promise.resolve<AgentPreset[]>([]);
    const settingsP: Promise<ProviderSettings | null> = canReadSettings
      ? api.providerSettings() : Promise.resolve<ProviderSettings | null>(null);
    const pluginsP: Promise<PluginInventory | null> = canReadSettings
      ? api.pluginInventory() : Promise.resolve<PluginInventory | null>(null);
    const trashP: Promise<TrashEntry[]> = canReadFiles ? api.trash() : Promise.resolve<TrashEntry[]>([]);

    const roots: RootView[] = await rootsP;
    const selectedRoot: string | null = roots.length > 0 ? roots[0].id : null;
    const directoryP: Promise<DirectoryPage | null> = selectedRoot !== null
      ? api.entries(selectedRoot) : Promise.resolve<DirectoryPage | null>(null);

    const sessions: ChatSession[] = await sessionsP;
    const chatWorkspaces: ChatWorkspace[] = await workspacesP;
    const agentPresets: AgentPreset[] = await presetsP;
    const providerSettings: ProviderSettings | null = await settingsP;
    const pluginInventory: PluginInventory | null = await pluginsP;
    const trash: TrashEntry[] = await trashP;
    const directory: DirectoryPage | null = await directoryP;
    const st: HarnessState = new HarnessState();
    st.restoring = false;
    st.connected = true;
    st.endpoint = api.endpoint;
    st.endpointDraft = stripApiSuffix(api.endpoint);
    st.healthOk = true;
    st.device = device;
    st.roots = roots;
    st.sessions = sessions;
    st.chatWorkspaces = chatWorkspaces;
    st.agentPresets = agentPresets;
    st.providerSettings = providerSettings;
    st.pluginInventory = pluginInventory;
    st.selectedRootId = selectedRoot;
    st.directory = directory;
    st.trash = trash;
    // 快照是整份重建的，偏好字段必须重新盖回去。
    this.applyPreferences(st);
    return st;
  }

  /** 替代 Kotlin 的 `onCleared()`：取消定时器、关闭事件订阅、关闭协调层。 */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (let i = 0; i < this.timerHandles.length; i++) {
      this.deps.timers.cancel(this.timerHandles[i]);
    }
    this.timerHandles = [];
    this.chatRefreshActive = false;
    // 去抖里还挂着一次「目录刷新」时，页面已经销毁了 —— 让它到点后再跑一次
    // 网络请求没有任何意义，而且会往一个已经无人监听的状态里写值。
    this.directoryDebouncer.cancel();
    if (this.eventSubscription !== null) {
      this.eventSubscription.close();
      this.eventSubscription = null;
    }
    // 协调层自带在途探活，不显式关闭的话，探活期间挂死的调用会一直占着资源。
    this.deps.coordinator.close();
    this.listeners = [];
  }
}
