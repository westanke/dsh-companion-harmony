import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECT_TIMEOUT_MS, READ_TIMEOUT_MS, WRITE_TIMEOUT_MS, DEFAULT_LANGUAGE_TAG, EventsChannel,
  DshClient, HttpRequest, HttpResponse, HttpTransport, UNRESOLVABLE_CODES, isUnresolvableCode,
  TimerBridge, WebSocketCallbacks, WebSocketTransport, EventSocketHandle,
} from '../../entry/src/main/ets/core/DshClient.ts';
import { PromptPart } from '../../entry/src/main/ets/core/Models.ts';
import { utf8Decode, utf8Encode } from '../../entry/src/main/ets/core/Codec.ts';

// --- 假传输（记录每次请求，回放预设响应） -----------------------------------

class FakeTransport implements HttpTransport {
  requests: HttpRequest[] = [];
  private queue: HttpResponse[] = [];

  reply(status: number, body: string, headers?: Record<string, string>): FakeTransport {
    return this.replyBytes(status, utf8Encode(body), headers);
  }

  replyBytes(status: number, bytes: Uint8Array, headers?: Record<string, string>): FakeTransport {
    const map = new Map<string, string>();
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        map.set(k.toLowerCase(), v);
      }
    }
    this.queue.push(new HttpResponse(status, map, bytes));
    return this;
  }

  request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    const next = this.queue.shift();
    if (!next) {
      throw new Error(`FakeTransport: 没有预设响应（${req.method} ${req.url}）`);
    }
    return Promise.resolve(next);
  }

  last(): HttpRequest {
    return this.requests[this.requests.length - 1];
  }

  bodyOf(index = this.requests.length - 1): string {
    const b = this.requests[index].body;
    return b === null ? '' : utf8Decode(b);
  }

  headersOf(index = this.requests.length - 1): Map<string, string> {
    return this.requests[index].headers;
  }
}

class StubTimers implements TimerBridge {
  scheduled: { delayMs: number; action: () => void }[] = [];
  cancelled: number[] = [];

  schedule(delayMs: number, action: () => void): number {
    this.scheduled.push({ delayMs, action });
    return this.scheduled.length;
  }

  cancel(handle: number): void {
    this.cancelled.push(handle);
  }
}

class StubSocket implements WebSocketTransport {
  opened: { url: string; headers: Map<string, string>; callbacks: WebSocketCallbacks }[] = [];
  closedCount = 0;

  open(url: string, headers: Map<string, string>, callbacks: WebSocketCallbacks): EventSocketHandle {
    this.opened.push({ url, headers, callbacks });
    const self = this;
    return {
      close: (): void => {
        self.closedCount += 1;
      },
    };
  }
}

function client(transport: HttpTransport, opts?: { token?: string | null; timers?: TimerBridge; socket?: WebSocketTransport }): DshClient {
  let counter = 0;
  return new DshClient(
    'http://192.168.1.126:3090',
    opts?.token === undefined ? 'device-token' : opts.token,
    transport,
    {
      newId: (): string => `id-${++counter}`,
      timeZoneId: (): string => 'Asia/Shanghai',
      languageTag: (): string => DEFAULT_LANGUAGE_TAG,
      socket: opts?.socket ?? null,
      timers: opts?.timers ?? null,
    },
  );
}

// --- URL 与鉴权头 -----------------------------------------------------------

test('DshClient：端点归一化 —— 自动补 /api/v1，去尾斜杠，不带任何前缀', () => {
  const c = client(new FakeTransport());
  assert.equal(c.endpoint, 'http://192.168.1.126:3090/api/v1');
  assert.equal(c.eventsUrl(), 'http://192.168.1.126:3090/api/v1/events');

  const already = client(new FakeTransport());
  assert.equal(already.endpoint, 'http://192.168.1.126:3090/api/v1');
});

test('DshClient：GET 绝不带 body；鉴权请求带 Bearer + Accept + Accept-Language', async () => {
  const t = new FakeTransport().reply(200, '{"ok":true,"version":"1.2.3"}');
  const c = client(t);
  const health = await c.health();

  assert.equal(health.ok, true);
  assert.equal(health.version, '1.2.3');
  const req = t.last();
  assert.equal(req.method, 'GET');
  assert.equal(req.url, 'http://192.168.1.126:3090/api/v1/healthz');
  assert.equal(req.body, null, 'GET 绝不能带 body');
  assert.equal(req.connectTimeoutMs, CONNECT_TIMEOUT_MS);
  assert.equal(req.readTimeoutMs, READ_TIMEOUT_MS);
  assert.equal(req.writeTimeoutMs, WRITE_TIMEOUT_MS);
  assert.equal(req.headers.has('Authorization'), false, 'health 不需要鉴权');

  t.reply(200, '{"id":"d1","name":"Pixel","scopes":[],"rootIds":[]}');
  await c.currentDevice();
  const auth = t.last();
  assert.equal(auth.headers.get('Authorization'), 'Bearer device-token');
  assert.equal(auth.headers.get('Accept'), 'application/json');
  assert.equal(auth.headers.get('Accept-Language'), 'zh-CN', '界面语言随每个请求出海');
});

test('DshClient：接受 getJson 传入自定义 languageTag（给英文留的接口）', async () => {
  const t = new FakeTransport().reply(200, '{"id":"d","name":"n"}');
  const c = new DshClient('http://h:3090', 'tok', t, {
    newId: () => 'x', timeZoneId: () => 'UTC', languageTag: () => 'en', socket: null, timers: null,
  });
  await c.currentDevice();
  assert.equal(t.last().headers.get('Accept-Language'), 'en');
});

test('DshClient：路径段与查询参数都做 URL 编码（attachmentId 的冒号必须转义）', async () => {
  const t = new FakeTransport().reply(200, '{}');
  const c = client(t);
  await c.entries('root/1', 'a b/c.txt', 'cur+sor');
  const url = t.last().url;
  assert.equal(url, 'http://192.168.1.126:3090/api/v1/roots/root%2F1/entries?path=a%20b%2Fc.txt&cursor=cur%2Bsor');
});

test('DshClient：readAttachment 带 sessionId，attachmentId 转义为 %3A', async () => {
  const t = new FakeTransport().replyBytes(200, new Uint8Array([1, 2, 3]));
  const c = client(t);
  const bytes = await c.readAttachment('s1', 'sha256:abc');
  assert.deepEqual([...bytes], [1, 2, 3]);
  assert.equal(t.last().url, 'http://192.168.1.126:3090/api/v1/attachments/sha256%3Aabc?sessionId=s1');
});

// --- 请求体 -----------------------------------------------------------------

test('DshClient：pair 请求体只有 code/deviceName 两个键', async () => {
  const t = new FakeTransport().reply(200, '{"token":"tk","device":{"id":"d"}}');
  const c = client(t);
  const result = await c.pair('  123456  ', ' Pixel 9 ');
  assert.equal(result.token, 'tk');
  assert.equal(result.device.id, 'd');
  assert.deepEqual(JSON.parse(t.bodyOf()), { code: '123456', deviceName: 'Pixel 9' }, '前后空白应被裁掉');
  assert.equal(t.last().headers.get('Content-Type'), 'application/json');
  assert.equal(t.last().headers.has('Authorization'), false, '配对不需要鉴权');
});

test('DshClient：createSession 带 clientRequestId，agentPreset 为空时不写该键', async () => {
  const t = new FakeTransport().reply(200, '{"session":{"id":"s1"}}');
  const c = client(t);
  const created = await c.createSession('ws1');
  assert.equal(created.id, 's1');
  const body = JSON.parse(t.bodyOf());
  assert.deepEqual(Object.keys(body).sort(), ['clientRequestId', 'workspaceId']);
  assert.equal(body.clientRequestId, 'id-1');

  t.reply(200, '{"session":{"id":"s2","agentPreset":"p1"}}');
  const withPreset = await c.createSession('ws1', 'p1');
  assert.equal(withPreset.agentPreset, 'p1');
  assert.deepEqual(JSON.parse(t.bodyOf()), { workspaceId: 'ws1', clientRequestId: 'id-2', agentPreset: 'p1' });
});

test('DshClient：writeFile 的 If-Match / If-None-Match 与 ETag 回读', async () => {
  const t = new FakeTransport().replyBytes(200, new Uint8Array(0), { ETag: 'v2' });
  const c = client(t);
  const etag = await c.writeFile('r1', 'a.txt', utf8Encode('hi'), 'v1');
  assert.equal(etag, 'v2');
  assert.equal(t.last().method, 'PUT');
  assert.equal(t.last().headers.get('If-Match'), 'v1');
  assert.equal(t.last().headers.get('Content-Type'), 'application/octet-stream');
  assert.equal(t.bodyOf(), 'hi');

  t.replyBytes(200, new Uint8Array(0), { ETag: 'v1' });
  await c.writeFile('r1', 'new.txt', utf8Encode('x'), null);
  assert.equal(t.last().headers.get('If-None-Match'), '*');
  assert.equal(t.last().headers.has('If-Match'), false);
});

test('DshClient：readFile 解出字节与 ETag / Content-Type 头', async () => {
  const t = new FakeTransport().replyBytes(200, utf8Encode('内容'), { etag: 'e1', 'content-type': 'text/plain' });
  const c = client(t);
  const file = await c.readFile('r1', 'a.txt');
  assert.equal(utf8Decode(file.bytes), '内容');
  assert.equal(file.etag, 'e1', '响应头查询应大小写不敏感');
  assert.equal(file.contentType, 'text/plain');
});

// --- 错误映射 ---------------------------------------------------------------

test('DshClient：非 2xx 解析 {error:{code,message}} 抛 DshApiException', async () => {
  const t = new FakeTransport().reply(404, '{"error":{"code":"ROUTE_NOT_FOUND","message":"插件过旧"}}');
  const c = client(t);
  await assert.rejects(() => c.roots(), (err: unknown) => {
    const e = err as { status: number; code: string; message: string };
    assert.equal(e.status, 404);
    assert.equal(e.code, 'ROUTE_NOT_FOUND');
    assert.equal(e.message, '插件过旧');
    return true;
  });
});

test('DshClient：错误体不可解析时按 HTTP_ERROR 兜底，state 用 HTTP <status>', async () => {
  const t = new FakeTransport().reply(500, '不是 JSON');
  const c = client(t);
  await assert.rejects(() => c.roots(), (err: unknown) => {
    const e = err as { status: number; code: string; message: string };
    assert.equal(e.status, 500);
    assert.equal(e.code, 'HTTP_ERROR');
    assert.equal(e.message, 'HTTP 500');
    return true;
  });
});

test('DshClient.resolvePath：UNRESOLVABLE_CODES 返回 null 而不是抛异常', async () => {
  assert.deepEqual(UNRESOLVABLE_CODES, ['PATH_OUTSIDE_ROOTS', 'PATH_NOT_ABSOLUTE', 'PATH_NOT_FILE', 'PATH_NOT_FOUND']);
  for (const code of UNRESOLVABLE_CODES) {
    const t = new FakeTransport().reply(400, `{"error":{"code":"${code}","message":"m"}}`);
    const resolved = await client(t).resolvePath('/etc/passwd');
    assert.equal(resolved, null, `${code} 应视为正常结果`);
  }
  assert.equal(isUnresolvableCode('PATH_NOT_FOUND'), true);
  assert.equal(isUnresolvableCode('ROUTE_NOT_FOUND'), false);
});

test('DshClient.resolvePath：其他 404 必须抛出（提示升级插件，而不是怀疑路径）', async () => {
  const t = new FakeTransport().reply(404, '{"error":{"code":"ROUTE_NOT_FOUND","message":"无此路由"}}');
  await assert.rejects(() => client(t).resolvePath('/home/u/a.txt'), (err: unknown) => {
    assert.equal((err as { code: string }).code, 'ROUTE_NOT_FOUND');
    return true;
  });
});

test('DshClient.resolvePath：成功时解出 rootId/相对路径，且 size/contentType 可为 null', async () => {
  const t = new FakeTransport().reply(200, '{"rootId":"r1","path":"sub/a","kind":"directory","size":null,"modifiedAt":7,"contentType":null}');
  const resolved = await client(t).resolvePath('/home/u/sub/a');
  assert.equal(resolved?.rootId, 'r1');
  assert.equal(resolved?.path, 'sub/a');
  assert.equal(resolved?.kind, 'directory');
  assert.equal(resolved?.size, null);
  assert.equal(resolved?.contentType, null);
  assert.equal(t.last().url, 'http://192.168.1.126:3090/api/v1/roots/resolve?path=%2Fhome%2Fu%2Fsub%2Fa');
});

// --- 发消息 -----------------------------------------------------------------

test('DshClient：纯文本走旧格式 {"text":...}，带附件走 content 数组', async () => {
  const t = new FakeTransport().replyBytes(200, new Uint8Array(0));
  const c = client(t);
  await c.sendText('s1', '你好', false);
  assert.deepEqual(JSON.parse(t.bodyOf()), {
    text: '你好', mode: 'queue', clientTimeZone: 'Asia/Shanghai', clientRequestId: 'id-1',
  });

  t.replyBytes(200, new Uint8Array(0));
  await c.sendMessage('s1', [PromptPart.text('看图'), PromptPart.file('rc1')], true);
  const body = JSON.parse(t.bodyOf());
  assert.equal(body.mode, 'steer');
  assert.deepEqual(body.content, [{ type: 'text', text: '看图' }, { type: 'file', receiptId: 'rc1' }]);
});

test('DshClient：uploadAttachment 请求体为 {data:base64, name}', async () => {
  const t = new FakeTransport().reply(200, '{"receiptId":"rc","name":"a.bin"}');
  const c = client(t);
  const up = await c.uploadAttachment('s1', new Uint8Array([104, 105]), 'a.bin');
  assert.equal(up.receiptId, 'rc');
  assert.deepEqual(JSON.parse(t.bodyOf()), { data: 'aGk=', name: 'a.bin' });
});

test('DshClient：history 的 beforeSeq/maxMessages 是可选查询参数', async () => {
  const t = new FakeTransport().reply(200, '{"events":[],"hasMore":false}');
  const c = client(t);
  await c.history('s1');
  assert.equal(t.last().url.endsWith('/chat/sessions/s1/messages'), true, '无参数时不带 ?');

  t.reply(200, '{"events":[],"hasMore":true}');
  await c.history('s1', 40, 50);
  assert.equal(t.last().url.endsWith('/chat/sessions/s1/messages?beforeSeq=40&maxMessages=50'), true);
});

test('DshClient：answerQuestions 请求体来自 QuestionAnswerRequest', async () => {
  const t = new FakeTransport().replyBytes(200, new Uint8Array(0));
  const c = client(t);
  const { QuestionAnswer } = await import('../../entry/src/main/ets/core/Models.ts');
  await c.answerQuestions('s1', 'call-1', [QuestionAnswer.create('q1', ['A'])]);
  assert.equal(t.last().url, 'http://192.168.1.126:3090/api/v1/chat/sessions/s1/questions/call-1/answer');
  assert.deepEqual(JSON.parse(t.bodyOf()), { answers: [{ id: 'q1', selected: ['A'] }] });
});

test('DshClient：零长度 POST/PUT 体补 {}（空体不能真的空）', async () => {
  const t = new FakeTransport().replyBytes(200, new Uint8Array(0));
  const c = client(t);
  await c.archiveSession('s1');
  assert.equal(t.bodyOf(), '{}');
  assert.equal(t.last().method, 'POST');

  t.replyBytes(200, new Uint8Array(0));
  await c.cancel('s1');
  assert.equal(t.bodyOf(), '{}');
  assert.equal(t.last().url, 'http://192.168.1.126:3090/api/v1/chat/runs/s1/cancel');
});

test('DshClient：列表信封 {items:[...]} 统一解包，缺 items 时为空数组', async () => {
  const t = new FakeTransport().reply(200, '{"items":[{"id":"r1","label":"家","createdAt":1}]}');
  const c = client(t);
  const roots = await c.roots();
  assert.equal(roots.length, 1);
  assert.equal(roots[0].label, '家');

  t.reply(200, '{}');
  assert.deepEqual(await c.trash(), []);
});

test('DshClient：setPluginLoaded 走 PATCH settings/plugins', async () => {
  const t = new FakeTransport().reply(200, '{"name":"p","loaded":true,"bundleCount":18}');
  const c = client(t);
  const result = await c.setPluginLoaded('p', true);
  assert.equal(result.restartRequired, true, 'profile 只在启动时读一次，恒需重启');
  assert.equal(result.bundleCount, 18);
  assert.equal(t.last().method, 'PATCH');
  assert.equal(t.last().url, 'http://192.168.1.126:3090/api/v1/settings/plugins');
  assert.deepEqual(JSON.parse(t.bodyOf()), { name: 'p', loaded: true });
});

test('DshClient：pluginInventoryWithUpdates 带 checkUpdates=1（与轻量版分开）', async () => {
  const t = new FakeTransport().reply(200, '{"available":true,"items":[]}');
  const c = client(t);
  await c.pluginInventory();
  assert.equal(t.last().url, 'http://192.168.1.126:3090/api/v1/settings/plugins');
  t.reply(200, '{"available":true,"items":[]}');
  await c.pluginInventoryWithUpdates();
  assert.equal(t.last().url, 'http://192.168.1.126:3090/api/v1/settings/plugins?checkUpdates=1');
});

test('DshClient：updateProvider 的 PATCH 体沿用 ProviderPatch 的省略语义', async () => {
  const t = new FakeTransport().reply(200, '{"writable":true,"providers":[]}');
  const c = client(t);
  const { ProviderPatch } = await import('../../entry/src/main/ets/core/Models.ts');
  const patch = new ProviderPatch();
  patch.displayName = '新的';
  await c.updateProvider('openai', patch);
  assert.equal(t.last().method, 'PATCH');
  assert.deepEqual(JSON.parse(t.bodyOf()), { displayName: '新的' });
});

test('DshClient：discoverModels 省略未提供的参数键', async () => {
  const t = new FakeTransport().reply(200, '{"models":[{"id":"m1"}]}');
  const c = client(t);
  const models = await c.discoverModels('p1', null, 'openai', null);
  assert.equal(models.length, 1);
  assert.deepEqual(JSON.parse(t.bodyOf()), { api: 'openai' });
});

test('DshClient.selectModel 请求体复用 ModelSelection 的序列化', async () => {
  const t = new FakeTransport().reply(200, '{"selected":{"provider":"p","model":"m"}}');
  const c = client(t);
  const { ModelSelection } = await import('../../entry/src/main/ets/core/Models.ts');
  const selected = await c.selectModel('s1', new ModelSelection('p', 'm', 'high'));
  assert.equal(selected.provider, 'p');
  assert.deepEqual(JSON.parse(t.bodyOf()), { provider: 'p', model: 'm', reasoningEffort: 'high' });
});

// --- 事件流 -----------------------------------------------------------------

test('DshClient.events：URL 同源 http(s)，不提前改写 ws://', () => {
  const socket = new StubSocket();
  const timers = new StubTimers();
  const c = client(new FakeTransport(), { socket, timers });
  const sub = c.events(() => undefined, () => undefined);
  assert.equal(socket.opened.length, 1);
  assert.equal(socket.opened[0].url, 'http://192.168.1.126:3090/api/v1/events', '必须是 http(s)，由底层升级协议');
  assert.equal(socket.opened[0].headers.get('Authorization'), 'Bearer device-token');
  sub.close();
  assert.equal(socket.closedCount, 1);
});

test('EventsChannel：退避序列为 1、2、4、8、16、30、30…（封顶 30s）', () => {
  const socket = new StubSocket();
  const timers = new StubTimers();
  const channel = new EventsChannel('http://h/api/v1/events', new Map(), socket, timers, () => undefined, () => undefined);
  channel.start();

  const delays: number[] = [];
  for (let i = 0; i < 8; i++) {
    socket.opened[socket.opened.length - 1].callbacks.onDown('断开');
    const last = timers.scheduled[timers.scheduled.length - 1];
    delays.push(last.delayMs);
    last.action(); // 触发下一次连接尝试
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  channel.close();
});

test('EventsChannel：连上后重试计数清零（下次断开从 1s 重新开始）', () => {
  const socket = new StubSocket();
  const timers = new StubTimers();
  const states: boolean[] = [];
  const channel = new EventsChannel('http://h/e', new Map(), socket, timers, () => undefined, (open) => states.push(open));
  channel.start();

  socket.opened[0].callbacks.onDown('x');
  assert.equal(timers.scheduled[0].delayMs, 1000);
  timers.scheduled[0].action();
  socket.opened[1].callbacks.onOpen();
  socket.opened[1].callbacks.onDown('x');
  assert.equal(timers.scheduled[1].delayMs, 1000, '连上过就该清零');
  assert.deepEqual(states, [false, true, false], 'onOpen 报 true，两次 onDown 各报一次 false');
  channel.close();
});

test('EventsChannel：onDown 的同次尝试只处理一次（先 onError 再 onClose）', () => {
  const socket = new StubSocket();
  const timers = new StubTimers();
  const channel = new EventsChannel('http://h/e', new Map(), socket, timers, () => undefined, () => undefined);
  channel.start();
  const cb = socket.opened[0].callbacks;
  cb.onDown('error');
  cb.onDown('close');
  assert.equal(timers.scheduled.length, 1, '同一次尝试里掉线只排一次重连');
  channel.close();
});

test('EventsChannel：解析事件帧并推给监听者；坏帧静默丢弃', () => {
  const socket = new StubSocket();
  const timers = new StubTimers();
  const got: string[] = [];
  const channel = new EventsChannel('http://h/e', new Map(), socket, timers,
    (e) => got.push(e.type), () => undefined);
  channel.start();
  const cb = socket.opened[0].callbacks;
  cb.onMessage('{"id":"1","type":"session.status","time":1,"data":{"s":"running"}}');
  cb.onMessage('{坏 JSON');
  cb.onMessage('123');
  assert.deepEqual(got, ['session.status']);
  channel.close();
});

test('EventsChannel.close：幂等，且关闭后 onDown 不再排重连', () => {
  const socket = new StubSocket();
  const timers = new StubTimers();
  const channel = new EventsChannel('http://h/e', new Map(), socket, timers, () => undefined, () => undefined);
  channel.start();
  const cb = socket.opened[0].callbacks;
  channel.close();
  channel.close();
  cb.onDown('late');
  assert.equal(timers.scheduled.length, 0, '主动关闭后不得再重连');
  assert.equal(socket.closedCount, 1);
});

test('DshClient.events：未注入 WS/Timer 时抛错（调用方应改为轮询）', () => {
  const c = client(new FakeTransport());
  assert.throws(() => c.events(() => undefined, () => undefined), /未注入/);
});

test('DshClient：需要鉴权但无令牌时抛错（且不会发出请求）', async () => {
  const t = new FakeTransport();
  const c = client(t, { token: null });
  await assert.rejects(() => c.roots(), /未提供设备令牌/);
  assert.equal(t.requests.length, 0, '本地就该拦下，不该发出去');
});

test('DshClient：health 无令牌也能发（配对前就要能探活）', async () => {
  const t = new FakeTransport().reply(200, '{"ok":true,"version":"v"}');
  const c = client(t, { token: null });
  assert.equal((await c.health()).ok, true);
  assert.equal(t.requests.length, 1);
});
