/**
 * 连接协调层 —— 移植自原工程 `data/ConnectionCoordinator.kt`。
 *
 * 职责：一台电脑有多个可达地址时，**并发探活 → 按 `EndpointSelection.rank` 选路 → 全部失败
 * 时抛出携带全部原因的异常**。本文件不 import 任何平台 API，可直接在 node 单测里跑。
 *
 * ## 为什么必须并发 + 单地址独立超时
 *
 * 用户的真实场景是「人在外面，家里的 192.168.x 不可达、虚拟网 100.64.x 可达、公网也许也行」。
 * 这堆地址里**必然有挂死的**（不可达网段会一直等到 TCP 超时）。串行探测会让一次连接等满
 * 挂死地址的超时；整批共用一个超时则一个挂死地址会把可用地址一起拖死。所以：每个地址独立
 * 计时、独立 deadline，整批并发，总耗时接近「单个超时」而不是各地址累加。
 *
 * ## 与 Kotlin 版的机制差异（刻意的，且有理由）
 *
 * 原版为了对付「协程取消打不断阻塞的 OkHttp 调用」，用了 `probeScope` + `closedSignal` +
 * `Deferred.await()` 三件套。JS 这边 **Promise 天生无法中断**，但那恰恰简化了语义：超时后
 * 直接把「等待」这一层 resolve 成 null，被放弃的那次请求留在后台自行结束（一次多余的健康
 * 检查，无副作用）。所以不需要 `closedSignal` 那套补丁，`close()` 只需「标记关闭 + 取消未
 * 触发的定时器」，之后的调用快速失败。
 */

import { Host, Endpoint, EndpointProbe, EndpointSelection } from './ConnectionModels';
import { DshClient, TimerBridge } from './DshClient';

/** 单个地址的探活上限（与上游一致：1.5s）。 */
export const DEFAULT_PROBE_TIMEOUT_MS: number = 1500;

/** `close()` 之后再调用 `probeAll` / `connect` 时抛出的文案。 */
export const CLOSED_MESSAGE: string = 'ConnectionCoordinator was closed';

/** 默认时钟（毫秒）。注入是为了让单测能控制延迟测量。 */
export function defaultClock(): number {
  return Date.now();
}

/**
 * 该主机的**全部**地址都探活失败时抛出，携带每一个地址的失败原因。
 *
 * 为什么携带全部而不是折叠成一句话：一台电脑的三个地址可能分别是「超时」「HTTP 502」
 * 「连接被拒」，诊断面板要逐条展示。只给一句「连接失败」等于什么都没说 —— 而这正是用户
 * 过去只能手填地址、却不知道填哪个才通的根因。顺序与 `Host.activeEndpoints()` 一致。
 */
export class DshConnectionException extends Error {
  readonly probes: EndpointProbe[];

  constructor(probes: EndpointProbe[]) {
    super(describeFailures(probes));
    this.probes = probes;
  }
}

function describeFailures(probes: EndpointProbe[]): string {
  if (probes.length === 0) {
    return 'This host has no enabled endpoint to probe';
  }
  const parts: string[] = [];
  for (let i = 0; i < probes.length; i++) {
    const p: EndpointProbe = probes[i];
    parts.push(`${p.endpointId}: ${p.error === null ? 'unknown failure' : p.error}`);
  }
  return `All ${probes.length} endpoint(s) unreachable: ${parts.join('; ')}`;
}

/** 把 catch 到的值折成「名字: 详情」；拿不到详情就只给名字。 */
function describeError(error: Object): string {
  if (error instanceof Error) {
    const name: string = error.name.length > 0 ? error.name : 'Error';
    const detail: string = error.message;
    return detail.length > 0 ? `${name}: ${detail}` : name;
  }
  return 'unknown failure';
}

/** 构造客户端的工厂（注入以便单测换成假客户端 / 假传输）。 */
export interface DshClientFactory {
  create(baseUrl: string, token: string | null): DshClient;
}

/**
 * 选路成功后的「活连接」：主机 + 选中的地址 + 可用客户端 + 本轮全部探活结果。
 *
 * `host` 原样返回传入的对象 —— 本类**不改写**主机的探活记录；落盘由 `HostStore` 负责
 * （用 `Host.withEndpointProbe()` / `Host.withPreferred()` 写回）。
 */
export class ActiveConnection {
  readonly host: Host;
  readonly endpoint: Endpoint;
  readonly client: DshClient;
  readonly probes: EndpointProbe[];

  constructor(host: Host, endpoint: Endpoint, client: DshClient, probes: EndpointProbe[] = []) {
    this.host = host;
    this.endpoint = endpoint;
    this.client = client;
    this.probes = probes;
  }
}

/**
 * 连接协调器。**调用方必须 `close()`**（切换主机、页面销毁时），否则未触发的定时器会一直挂着。
 */
export class ConnectionCoordinator {
  private factory: DshClientFactory;
  private probeTimeoutMs: number;
  private timers: TimerBridge;
  private clock: () => number;
  private closed: boolean = false;
  /** 尚未触发的超时定时器句柄，`close()` 时要一次性取消。 */
  private pendingTimers: number[] = [];
  /**
   * 在途探活的「叫醒器」列表：`close()` 时逐个调用，让正在等待结果的 `probeAll` 立刻以
   * `CLOSED_MESSAGE` 收尾，而不是等这些地址走完自己的超时。
   *
   * 为什么需要这一层：被放弃的 Promise 无法中断，光取消定时器只能让它「永不返回」，
   * 于是等待方会一直挂着 —— 那和泄漏没区别。
   */
  private waits: ((reason: string) => void)[] = [];

  constructor(factory: DshClientFactory, probeTimeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
              timers: TimerBridge, clock: () => number = defaultClock) {
    this.factory = factory;
    this.probeTimeoutMs = probeTimeoutMs;
    this.timers = timers;
    this.clock = clock;
  }

  /**
   * 关闭：此后不再发起任何探活，取消所有未触发的超时定时器，并**立刻叫醒**正在等待结果的在途探活。
   *
   * ## 能做到什么、做不到什么
   *
   * - 做到：正在等待结果的 `probeAll` / `connect` **立刻**以 `CLOSED_MESSAGE` 收尾；
   *   之后的新调用快速失败，不再新建客户端、不再发请求。
   * - 做不到：**打断已经在途的那次 HTTP 请求**。Promise 无法取消，被放弃的请求会一直占着
   *   传输层的连接，直到平台自己的读超时（45s）返回。所以 `close()` 的作用是「立刻停止等待
   *   + 不再新增泄漏」，而不是「立刻清空在途请求」；只要一个协调器实例服务一个界面生命周期
   *   并在结束时 close，在途请求就不会堆积。
   */
  close(): void {
    this.closed = true;
    for (let i = 0; i < this.pendingTimers.length; i++) {
      this.timers.cancel(this.pendingTimers[i]);
    }
    this.pendingTimers = [];
    const waiting: ((reason: string) => void)[] = this.waits;
    this.waits = [];
    for (let i = 0; i < waiting.length; i++) {
      waiting[i](CLOSED_MESSAGE);
    }
  }

  isClosed(): boolean {
    return this.closed;
  }

  /**
   * 并发探测 `host.activeEndpoints()`，返回**顺序与之一致**的探活结果。
   *
   * 单个地址失败（连接被拒 / HTTP 非 2xx / 响应无法解析 / 超时）不会让整批失败，失败原因写进
   * `EndpointProbe.error` 供诊断面板展示。
   */
  async probeAll(host: Host): Promise<EndpointProbe[]> {
    if (this.closed) {
      throw new Error(CLOSED_MESSAGE);
    }
    const endpoints: Endpoint[] = host.activeEndpoints();
    if (endpoints.length === 0) {
      return [];
    }
    const token: string | null = host.credential === null ? null : host.credential.secret;
    const pending: Promise<EndpointProbe>[] = [];
    for (let i = 0; i < endpoints.length; i++) {
      pending.push(this.probe(endpoints[i], token));
    }
    return Promise.all(pending);
  }

  /**
   * 探活全部地址并选出最合适的一个，返回可用于后续请求的活连接。
   *
   * 选路完全复用 `EndpointSelection.rank`（延迟优先、局域网近似即优先、并列时 preferred 优先），
   * 本类不另写一套排序。全部地址不可达时抛 `DshConnectionException`（携带全部探活原因）。
   */
  async connect(host: Host): Promise<ActiveConnection> {
    if (this.closed) {
      throw new Error(CLOSED_MESSAGE);
    }
    const probes: EndpointProbe[] = await this.probeAll(host);
    if (this.closed) {
      throw new Error(CLOSED_MESSAGE);
    }
    const ranked: EndpointProbe[] = EndpointSelection.rank(probes, host.endpoints, host.preferredEndpointId);
    const best: EndpointProbe | null = ranked.length > 0 ? ranked[0] : null;
    if (best === null) {
      throw new DshConnectionException(probes);
    }
    const endpoint: Endpoint | null = host.endpoint(best.endpointId);
    if (endpoint === null) {
      throw new DshConnectionException(probes);
    }
    const client: DshClient = this.factory.create(endpoint.baseUrl,
      host.credential === null ? null : host.credential.secret);
    return new ActiveConnection(host, endpoint, client, probes);
  }

  /**
   * 单个地址的探活：独立计时 + 独立 deadline。
   *
   * 三种收尾：构造客户端失败（如 baseUrl 非法）→ 失败；请求抛错 → 失败（带原因）；到点未返回
   * → 失败（`timeout after Nms`）。
   */
  private async probe(endpoint: Endpoint, token: string | null): Promise<EndpointProbe> {
    let client: DshClient;
    try {
      // 例如 baseUrl 不合法（DshClient 构造时会拒绝非 http(s) 前缀）。
      client = this.factory.create(endpoint.baseUrl, token);
    } catch (e) {
      return EndpointProbe.failure(endpoint.id, describeError(e as Object));
    }

    const startedAt: number = this.clock();
    const attempt: Promise<EndpointProbe> = client.health()
      .then((): EndpointProbe => EndpointProbe.success(endpoint.id, this.clock() - startedAt))
      .catch((e: Object): EndpointProbe => EndpointProbe.failure(endpoint.id, describeError(e)));
    const settled: EndpointProbe | null = await this.withDeadline(attempt);
    if (settled === null) {
      return EndpointProbe.failure(endpoint.id, `timeout after ${this.probeTimeoutMs}ms`);
    }
    return settled;
  }

  /**
   * 给一次探活套 deadline：**超时、完成、被 close 叫醒，谁先到用谁**。
   *
   * - 超时 → resolve null（由 `probe` 翻成 `timeout after Nms`）；
   * - 完成 → 原样透传结果；
   * - `close()` → reject `CLOSED_MESSAGE`（与上游一致：被取消而不是被当成「这个地址探活失败」）。
   *
   * 被放弃的那次请求仍会跑完，但结果不再有人关心 —— 因此 `attempt` 自身已挂 `catch`，
   * 否则平台层抛出的错误会变成「未处理的 Promise 拒绝」污染日志甚至触发崩溃。
   */
  private withDeadline(attempt: Promise<EndpointProbe>): Promise<EndpointProbe | null> {
    // 超时这一侧。
    let timeoutHandle: number = -1;
    const timeout: Promise<EndpointProbe | null> = new Promise<EndpointProbe | null>(
      (resolve: (value: EndpointProbe | null) => void): void => {
        timeoutHandle = this.timers.schedule(this.probeTimeoutMs, (): void => resolve(null));
        this.pendingTimers.push(timeoutHandle);
      });
    // close 这一侧。
    let closeReject: (reason: string) => void = (reason: string): void => undefined;
    const closed: Promise<EndpointProbe | null> = new Promise<EndpointProbe | null>(
      (resolve: (value: EndpointProbe | null) => void, reject: (error: Error) => void): void => {
        closeReject = (reason: string): void => reject(new Error(reason));
      });
    const waitFn: (reason: string) => void = (reason: string): void => closeReject(reason);
    this.waits.push(waitFn);

    return Promise.race<EndpointProbe | null>([attempt, timeout, closed])
      .then((value: EndpointProbe | null): EndpointProbe | null => {
        if (timeoutHandle >= 0) {
          this.timers.cancel(timeoutHandle);
        }
        const index: number = this.waits.indexOf(waitFn);
        if (index >= 0) {
          this.waits.splice(index, 1);
        }
        return value;
      });
  }
}
