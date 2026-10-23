import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ActiveConnection, CLOSED_MESSAGE, ConnectionCoordinator, DEFAULT_PROBE_TIMEOUT_MS,
  DshClientFactory, DshConnectionException, defaultClock,
} from '../../entry/src/main/ets/core/ConnectionCoordinator.ts';
import { Endpoint, EndpointKind, Host, Credential, CredentialKind } from '../../entry/src/main/ets/core/ConnectionModels.ts';
import {
  DshClient, DshClientDeps, EventSocketHandle, HttpRequest, HttpResponse, HttpTransport,
  TimerBridge, WebSocketCallbacks, WebSocketTransport,
} from '../../entry/src/main/ets/core/DshClient.ts';
import { utf8Encode } from '../../entry/src/main/ets/core/Codec.ts';

const HEALTH_BODY = '{"ok":true,"version":"v1"}';

/** 让出事件循环，把微任务全部冲干净（用真实 setTimeout，与协调器的假定时器互不干扰）。 */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * 手动放行的传输：请求挂在那里，测试决定什么时候、以什么结果放行。
 * 这样「并发」与「延迟」都能被精确控制，不依赖真实时间。
 */
class ManualTransport implements HttpTransport {
  calls: HttpRequest[] = [];
  private resolvers: ((res: HttpResponse) => void)[] = [];

  request(req: HttpRequest): Promise<HttpResponse> {
    this.calls.push(req);
    return new Promise<HttpResponse>((resolve: (res: HttpResponse) => void): void => {
      this.resolvers.push(resolve);
    });
  }

  get pending(): number {
    return this.resolvers.length;
  }

  respond(status = 200, body = HEALTH_BODY): void {
    const resolve = this.resolvers.shift();
    assert.ok(resolve, 'ManualTransport: 没有在途请求可放行');
    resolve(new HttpResponse(status, new Map([['content-type', 'application/json']]), utf8Encode(body)));
  }

  fail(status: number, body: string): void {
    this.respond(status, body);
  }
}

/** 永不返回的传输：模拟「这个网段现在不可达、卡在 TCP 上」。 */
class NeverTransport implements HttpTransport {
  calls = 0;

  request(): Promise<HttpResponse> {
    this.calls += 1;
    return new Promise<HttpResponse>((): void => undefined);
  }
}

/** 假定时器：测试自己决定何时触发超时，因此「超时」用例是确定性的、亚毫秒级跑完。 */
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

class HarnessFactory implements DshClientFactory {
  transports = new Map<string, HttpTransport>();
  created: { baseUrl: string; token: string | null }[] = [];
  /** 命中这些 baseUrl 时构造直接抛错（模拟地址非法）。 */
  factoryThrows = new Set<string>();

  create(baseUrl: string, token: string | null): DshClient {
    this.created.push({ baseUrl, token });
    if (this.factoryThrows.has(baseUrl)) {
      throw new Error('EndpointUrl: 地址必须以 http(s):// 开头');
    }
    const transport = this.transports.get(baseUrl);
    assert.ok(transport, `HarnessFactory: 未注册的地址 ${baseUrl}`);
    return new DshClient(baseUrl, token, transport, DEPS);
  }
}

const DEPS: DshClientDeps = {
  newId: (): string => 'probe-id',
  timeZoneId: (): string => 'UTC',
  languageTag: (): string => 'zh-CN',
  deviceTag: (): string => 'harmonyos/ICL-AL10',
  socket: null,
  timers: null,
};

function endpoint(id: string, url: string, kind?: EndpointKind): Endpoint {
  const e = Endpoint.create(id, url, id);
  if (kind !== undefined) {
    e.kind = kind;
  }
  return e;
}

function host(endpoints: Endpoint[], credential: Credential | null = null,
              preferredEndpointId: string | null = null): Host {
  return new Host('host-1', '家里的电脑', endpoints, preferredEndpointId, credential, 0, 0);
}

interface Rig {
  coordinator: ConnectionCoordinator;
  factory: HarnessFactory;
  timers: FakeTimers;
  register(url: string, transport: HttpTransport): void;
  clock: { now: number; read: () => number };
}

function rig(probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Rig {
  const factory = new HarnessFactory();
  const timers = new FakeTimers();
  const clock = { now: 0, read: (): number => clock.now };
  const coordinator = new ConnectionCoordinator(factory, probeTimeoutMs, timers, clock.read);
  return {
    coordinator,
    factory,
    timers,
    clock,
    register: (url: string, transport: HttpTransport): void => {
      factory.transports.set(url, transport);
    },
  };
}

// --- 并发与失败隔离 ---------------------------------------------------------

test('probeAll：整批并发发起，不等任何地址返回就开始下一个', () => {
  const r = rig();
  const a = new ManualTransport();
  const b = new ManualTransport();
  const c = new ManualTransport();
  r.register('http://10.0.0.1:3090', a);
  r.register('http://10.0.0.2:3090', b);
  r.register('http://10.0.0.3:3090', c);

  const pending = r.coordinator.probeAll(host([
    endpoint('e0', 'http://10.0.0.1:3090'),
    endpoint('e1', 'http://10.0.0.2:3090'),
    endpoint('e2', 'http://10.0.0.3:3090'),
  ]));

  // 这是「并发」的硬证据：三个请求在任何响应之前就已经全部发出。
  assert.equal(a.calls.length, 1);
  assert.equal(b.calls.length, 1);
  assert.equal(c.calls.length, 1);
  assert.equal(r.factory.created.length, 3);

  a.respond();
  b.respond();
  c.respond();
  return pending.then((probes) => {
    assert.deepEqual(probes.map((p) => p.endpointId), ['e0', 'e1', 'e2']);
    assert.equal(probes.every((p) => p.ok), true);
    assert.equal(r.timers.pendingCount, 0, '成功后应把各自的超时定时器全部取消');
  });
});

test('probeAll：单地址失败不拖垮整批，原因写进各自的 error', async () => {
  const r = rig();
  const ok = new ManualTransport();
  const gateway = new ManualTransport();
  const refused = new NeverTransport();
  r.register('http://10.0.0.1:3090', ok);
  r.register('http://10.0.0.2:3090', gateway);
  r.register('http://10.0.0.3:3090', refused);

  const pending = r.coordinator.probeAll(host([
    endpoint('up', 'http://10.0.0.1:3090'),
    endpoint('gateway', 'http://10.0.0.2:3090'),
    endpoint('refused', 'http://10.0.0.3:3090'),
  ]));

  ok.respond();
  // 上游就是这么测的：响应体不是 JSON → 取不到 message → DshClient 回落到 `HTTP <status>`，
  // 于是「503」这个关键信息不会丢。这也正是诊断面板要的粒度。
  gateway.fail(503, 'nope');
  await flush();
  r.timers.firePending(); // 只对「拒绝连不上」那个地址触发超时
  const probes = await pending;

  const byId = new Map(probes.map((p) => [p.endpointId, p]));
  assert.equal(byId.get('up')!.ok, true);
  assert.ok((byId.get('up')!.latencyMs ?? -1) >= 0);
  assert.equal(byId.get('gateway')!.ok, false);
  assert.match(byId.get('gateway')!.error ?? '', /503/, 'HTTP 失败原因要能读出来');
  assert.equal(byId.get('refused')!.ok, false);
  assert.match(byId.get('refused')!.error ?? '', /timeout/);
  assert.equal(probes.length, 3, '顺序与数量都与 activeEndpoints 一致');
});

test('probeAll：HTTP 失败带 JSON 错误体时，error 里保留服务端给的原因', async () => {
  const r = rig();
  const gateway = new ManualTransport();
  r.register('http://10.0.0.2:3090', gateway);

  const pending = r.coordinator.probeAll(host([endpoint('gateway', 'http://10.0.0.2:3090')]));
  gateway.fail(502, '{"error":{"code":"BAD_GATEWAY","message":"上游不可用"}}');
  const probes = await pending;

  assert.equal(probes[0].ok, false);
  assert.match(probes[0].error ?? '', /上游不可用/);
});

test('probeAll：主机没有可用地址时返回空数组，且不构造任何客户端', async () => {
  const r = rig();
  const disabled = endpoint('off', 'http://192.168.1.126:3090');
  disabled.enabled = false;
  // 空地址只能直接构造（Endpoint.create 会因地址非法而抛错）。
  const blank = new Endpoint('blank', 'blank', '   ', EndpointKind.UNKNOWN, true);

  assert.deepEqual(await r.coordinator.probeAll(host([disabled, blank])), []);
  assert.equal(r.factory.created.length, 0);
});

test('probeAll：地址非法（构造抛错）只让该地址失败，不影响其他', async () => {
  const r = rig();
  const ok = new ManualTransport();
  r.register('http://10.0.0.1:3090', ok);
  r.factory.factoryThrows.add('http://10.0.0.2:3090');

  const pending = r.coordinator.probeAll(host([
    endpoint('bad', 'http://10.0.0.2:3090'),
    endpoint('good', 'http://10.0.0.1:3090'),
  ]));
  ok.respond();
  const probes = await pending;

  assert.equal(probes[0].endpointId, 'bad');
  assert.equal(probes[0].ok, false);
  assert.match(probes[0].error ?? '', /地址必须以 http\(s\)/);
  assert.equal(probes[1].ok, true);
});

// --- 全部失败：携带每一个原因 -----------------------------------------------

test('connect：全部不可达时抛 DshConnectionException，携带全部原因且顺序一致', async () => {
  const r = rig();
  const lan = new ManualTransport();
  const vnet = new NeverTransport();
  r.register('http://192.168.1.5:3090', lan);
  r.register('http://100.64.1.5:3090', vnet);

  const pending = r.coordinator.connect(host([
    endpoint('lan', 'http://192.168.1.5:3090'),
    endpoint('vnet', 'http://100.64.1.5:3090'),
  ]));
  lan.fail(502, '{"error":{"code":"BAD_GATEWAY","message":"bad"}}');
  await flush();
  r.timers.firePending();

  await assert.rejects(() => pending, (err: unknown) => {
    assert.ok(err instanceof DshConnectionException);
    const e = err as DshConnectionException;
    assert.deepEqual(e.probes.map((p) => p.endpointId), ['lan', 'vnet']);
    assert.equal(e.probes.every((p) => !p.ok), true);
    assert.equal(e.probes.every((p) => (p.error ?? '').length > 0), true);
    assert.match(e.message, /lan/);
    assert.match(e.message, /vnet/);
    return true;
  });
});

test('connect：主机没有可用地址时也抛 DshConnectionException（probes 为空）', async () => {
  const r = rig();
  const disabled = endpoint('off', 'http://192.168.1.126:3090');
  disabled.enabled = false;
  await assert.rejects(() => r.coordinator.connect(host([disabled])), (err: unknown) => {
    assert.ok(err instanceof DshConnectionException);
    assert.deepEqual((err as DshConnectionException).probes, []);
    assert.match((err as DshConnectionException).message, /no enabled endpoint/);
    return true;
  });
});

// --- 选路：完全复用 EndpointSelection.rank ---------------------------------

test('connect：无 LAN 时取延迟最低的地址', async () => {
  const r = rig();
  const slow = new ManualTransport();
  const fast = new ManualTransport();
  r.register('http://8.8.8.8:3090', slow);
  r.register('http://8.8.4.4:3090', fast);

  const pending = r.coordinator.connect(host([
    endpoint('slow', 'http://8.8.8.8:3090', EndpointKind.WAN),
    endpoint('fast', 'http://8.8.4.4:3090', EndpointKind.WAN),
  ]));

  // startedAt 都是 0；先让 slow 在时钟走到 300 时收尾，再让 fast 在 120 时收尾。
  r.clock.now = 300;
  slow.respond();
  await flush();
  r.clock.now = 120;
  fast.respond();
  await flush();

  const connection: ActiveConnection = await pending;
  assert.equal(connection.endpoint.id, 'fast');
  assert.equal(connection.probes.length, 2);
});

test('connect：局域网在容差内时优先于稍快的虚拟网（同网段更稳、不耗虚拟网流量）', async () => {
  const r = rig();
  const lan = new ManualTransport();
  const vnet = new ManualTransport();
  r.register('http://192.168.1.5:3090', lan);
  r.register('http://100.64.1.5:3090', vnet);

  const pending = r.coordinator.connect(host([
    endpoint('lan', 'http://192.168.1.5:3090', EndpointKind.LAN),
    endpoint('vnet', 'http://100.64.1.5:3090', EndpointKind.VIRTUAL_NET),
  ]));

  // 局域网 300ms，虚拟网 220ms：300 <= 220 * 1.5，容差覆盖，局域网胜出。
  r.clock.now = 220;
  vnet.respond();
  await flush();
  r.clock.now = 300;
  lan.respond();
  await flush();

  const connection = await pending;
  assert.equal(connection.endpoint.id, 'lan');
});

test('connect：局域网超出容差时回退到更快的虚拟网', async () => {
  const r = rig();
  const lan = new ManualTransport();
  const vnet = new ManualTransport();
  r.register('http://192.168.1.5:3090', lan);
  r.register('http://100.64.1.5:3090', vnet);

  const pending = r.coordinator.connect(host([
    endpoint('lan', 'http://192.168.1.5:3090', EndpointKind.LAN),
    endpoint('vnet', 'http://100.64.1.5:3090', EndpointKind.VIRTUAL_NET),
  ]));

  // 局域网 500ms，虚拟网 200ms：500 > 200 * 1.5 = 300，快的胜出。
  r.clock.now = 200;
  vnet.respond();
  await flush();
  r.clock.now = 500;
  lan.respond();
  await flush();

  const connection = await pending;
  assert.equal(connection.endpoint.id, 'vnet');
});

test('connect：并列时 preferredEndpointId 优先', async () => {
  const r = rig();
  const e0 = new ManualTransport();
  const e1 = new ManualTransport();
  r.register('http://8.8.8.8:3090', e0);
  r.register('http://8.8.4.4:3090', e1);

  // 两个地址延迟都是 0（时钟不推进）→ 并列 → preferred 决定。
  const pending = r.coordinator.connect(host([
    endpoint('e0', 'http://8.8.8.8:3090', EndpointKind.WAN),
    endpoint('e1', 'http://8.8.4.4:3090', EndpointKind.WAN),
  ], null, 'e1'));
  e0.respond();
  e1.respond();

  const connection = await pending;
  assert.equal(connection.endpoint.id, 'e1', '上次成功的地址在并列时优先');
});

// --- 挂死地址不拖累整批 ----------------------------------------------------

test('probeAll：挂死地址到点即超时，整批立刻返回，不占满它自己的超时', async () => {
  const r = rig(1500);
  const reachable = new ManualTransport();
  const hung = new NeverTransport();
  r.register('http://100.64.1.5:3090', reachable);
  r.register('http://192.168.1.5:3090', hung);

  const startedAt = Date.now();
  const pending = r.coordinator.probeAll(host([
    endpoint('hung', 'http://192.168.1.5:3090'),
    endpoint('reachable', 'http://100.64.1.5:3090'),
  ]));
  reachable.respond();
  await flush();
  r.timers.firePending(); // 只对挂死那一个触发 deadline
  const probes = await pending;
  const elapsedMs = Date.now() - startedAt;

  const byId = new Map(probes.map((p) => [p.endpointId, p]));
  assert.equal(byId.get('reachable')!.ok, true, '可用地址必须照常成功');
  assert.equal(byId.get('hung')!.ok, false);
  assert.match(byId.get('hung')!.error ?? '', /timeout after 1500ms/, '超时原因要可读');
  assert.ok(elapsedMs < 500, `整批不该等满挂死地址自己的超时，实测 ${elapsedMs}ms`);
});

test('connect：首选地址挂死时自动回退到可用地址', async () => {
  const r = rig();
  const hung = new NeverTransport();
  const reachable = new ManualTransport();
  r.register('http://192.168.1.5:3090', hung);
  r.register('http://100.64.1.5:3090', reachable);

  const pending = r.coordinator.connect(host([
    endpoint('lan', 'http://192.168.1.5:3090', EndpointKind.LAN),
    endpoint('vnet', 'http://100.64.1.5:3090', EndpointKind.VIRTUAL_NET),
  ], null, 'lan'));
  reachable.respond();
  await flush();
  r.timers.firePending();

  const connection = await pending;
  assert.equal(connection.endpoint.id, 'vnet');
  assert.equal(connection.probes.length, 2);
});

// --- 凭据接线 ---------------------------------------------------------------

test('connect：主机令牌注入返回的客户端；构造每次都要带令牌', async () => {
  const r = rig();
  const t = new ManualTransport();
  r.register('http://192.168.1.5:3090', t);
  const credential = new Credential(CredentialKind.DEVICE_TOKEN, 'device-token');

  const pending = r.coordinator.connect(host([endpoint('e0', 'http://192.168.1.5:3090')], credential));
  t.respond();
  const connection = await pending;

  assert.equal(connection.endpoint.baseUrl, 'http://192.168.1.5:3090');
  assert.equal(r.factory.created.length, 2, '探活用一次 + 返回的客户端一次');
  assert.equal(r.factory.created.every((c) => c.token === 'device-token'), true);
  assert.equal(connection.client.endpoint, 'http://192.168.1.5:3090/api/v1');

  // healthz 按契约是匿名端点，探活不该带令牌；真正该带的是后续的认证请求。
  assert.equal(t.calls[0].url, 'http://192.168.1.5:3090/api/v1/healthz');
  assert.equal(t.calls[0].headers.has('Authorization'), false, 'healthz 不需要鉴权');

  // 拿返回的客户端真发一次认证请求，确认它带着主机级设备令牌（多地址共用一个令牌）。
  const devicePending = connection.client.currentDevice();
  t.respond(200, '{"id":"device-1","name":"Pixel","scopes":[],"rootIds":[]}');
  const device = await devicePending;
  assert.equal(device.id, 'device-1');
  assert.equal(t.calls[1].headers.get('Authorization'), 'Bearer device-token');
});

test('connect：无凭据时构造不带令牌的客户端', async () => {
  const r = rig();
  const t = new ManualTransport();
  r.register('http://192.168.1.5:3090', t);

  const pending = r.coordinator.connect(host([endpoint('e0', 'http://192.168.1.5:3090')]));
  t.respond();
  const connection = await pending;

  assert.equal(r.factory.created.every((c) => c.token === null), true);
  assert.equal(t.calls[0].headers.has('Authorization'), false);
  assert.equal(connection.probes.length, 1);
});

test('ActiveConnection：host 原样返回，不改写主机的探活记录', async () => {
  const r = rig();
  const t = new ManualTransport();
  r.register('http://192.168.1.5:3090', t);
  const h = host([endpoint('e0', 'http://192.168.1.5:3090')]);

  const pending = r.coordinator.connect(h);
  t.respond();
  const connection = await pending;

  assert.equal(connection.host, h, '落盘由 HostStore 负责，协调器不该改写主机');
  assert.equal(h.endpoints[0].lastLatencyMs, null);
});

// --- 生命周期：close() ------------------------------------------------------

test('close：立刻叫醒在途探活（不必等它自己的超时），并拒绝新调用', async () => {
  const r = rig(5000);
  const hung = new NeverTransport();
  r.register('http://192.168.1.5:3090', hung);
  const h = host([endpoint('hung', 'http://192.168.1.5:3090')]);

  const startedAt = Date.now();
  const inFlight = r.coordinator.probeAll(h);
  assert.equal(hung.calls, 1, '请求确实已在途');

  r.coordinator.close();
  await assert.rejects(() => inFlight, (err: unknown) => {
    assert.equal((err as Error).message, CLOSED_MESSAGE);
    return true;
  });
  assert.ok(Date.now() - startedAt < 500, 'close() 后应立即收尾，而不是等满 5000ms');

  const createdBefore = r.factory.created.length;
  await assert.rejects(() => r.coordinator.probeAll(h), new RegExp(CLOSED_MESSAGE));
  await assert.rejects(() => r.coordinator.connect(h), new RegExp(CLOSED_MESSAGE));
  assert.equal(r.factory.created.length, createdBefore, '关闭后不得再新建客户端');
  assert.equal(r.coordinator.isClosed(), true);
  assert.equal(r.timers.pendingCount, 0, '关闭时挂着的超时定时器应被取消');
});

test('close：幂等，重复调用不出错', () => {
  const r = rig();
  r.coordinator.close();
  r.coordinator.close();
  assert.equal(r.coordinator.isClosed(), true);
});

test('close：成功收尾的探活不会残留在唤醒列表里', async () => {
  const r = rig();
  const t = new ManualTransport();
  r.register('http://192.168.1.5:3090', t);
  const pending = r.coordinator.probeAll(host([endpoint('e0', 'http://192.168.1.5:3090')]));
  t.respond();
  await pending;
  // 此刻再 close 不应有任何东西被唤醒（若残留会抛错）。
  r.coordinator.close();
});

// --- 常量 -------------------------------------------------------------------

test('常量与默认值：探活上限 1.5s、默认时钟可用', () => {
  assert.equal(DEFAULT_PROBE_TIMEOUT_MS, 1500);
  assert.equal(typeof defaultClock(), 'number');
  assert.equal(CLOSED_MESSAGE, 'ConnectionCoordinator was closed');
});
