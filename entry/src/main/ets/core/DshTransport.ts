/**
 * DSH 客户端的**传输注入点与长连接通道** —— 从 `core/DshClient.ts` 拆出
 * （见该文件头的「拆分说明」）。
 *
 * ## 为什么单独一层
 *
 * 这些声明描述的是「**平台能给我什么**」，与「**业务怎么用**」是两件事：
 *
 * | 本文件 | `core/DshClient.ts` |
 * |---|---|
 * | `HttpTransport` / `WebSocketTransport` / `TimerBridge` 接口 | URL 拼装、鉴权头、错误映射 |
 * | `HttpRequest` / `HttpResponse` 数据类 | JSON → `Models.ts` 类型的解码 |
 * | `EventsChannel`（WS 退避重连） | 各业务端点的调用 |
 *
 * 平台层（`platform/HttpTransport.ets`、`platform/Timers.ets`、`platform/WebSocketTransport.ets`）
 * 实现本文件的接口；业务逻辑永远只依赖接口。**拆开的直接动因**是行数预算：
 * `DshClient.ts` 加进后台任务三个端点后越过 900 行，而这块与业务无关、搬走零风险
 * （纯声明 + 一个自洽的 `EventsChannel`，不共享任何私有状态）。
 *
 * 对外接口不变：`DshClient.ts` 用 `export { … } from './DshTransport'` 把全部名字
 * 原样转发，所以 `import { HttpTransport } from '../core/DshClient'` 这类写法**一个字都不用改**。
 */

import { WorkspaceEvent } from './Models';
import { utf8Decode } from './Codec';

/** 连接超时（与上游 OkHttp 一致）。 */
export const CONNECT_TIMEOUT_MS: number = 15000;
/** 读超时。 */
export const READ_TIMEOUT_MS: number = 45000;
/** 写超时。 */
export const WRITE_TIMEOUT_MS: number = 45000;
/** WebSocket 心跳间隔。 */
export const WS_PING_INTERVAL_MS: number = 20000;
/** WS 退避上限。 */
export const WS_MAX_BACKOFF_SECONDS: number = 30;
/** 界面语言兜底（从未设置过时按中文，那是插件原本的口径）。 */
export const DEFAULT_LANGUAGE_TAG: string = 'zh-CN';

// ---------------------------------------------------------------------------
// 注入点
// ---------------------------------------------------------------------------

/** 一次 HTTP 请求的描述（平台无关）。 */
export class HttpRequest {
  method: string = 'GET';
  url: string = '';
  headers: Map<string, string> = new Map();
  /** GET/HEAD 必须为 null；其余方法零长度体按调用方约定给 `{}` 的字节。 */
  body: Uint8Array | null = null;
  connectTimeoutMs: number = CONNECT_TIMEOUT_MS;
  readTimeoutMs: number = READ_TIMEOUT_MS;
  writeTimeoutMs: number = WRITE_TIMEOUT_MS;

  constructor(method: string, url: string, headers: Map<string, string>, body: Uint8Array | null) {
    this.method = method;
    this.url = url;
    this.headers = headers;
    this.body = body;
  }
}

/**
 * 一次 HTTP 响应。
 *
 * **约定：`headers` 的键必须是小写**（平台层负责转小写）。这样 `header('ETag')` 这类
 * 大小写不敏感查询就不需要在逻辑层遍历 Map —— ArkTS 的 Map 迭代语法比 `get` 更容易踩坑。
 */
export class HttpResponse {
  status: number = 0;
  headers: Map<string, string> = new Map();
  body: Uint8Array = new Uint8Array(0);

  constructor(status: number, headers: Map<string, string>, body: Uint8Array) {
    this.status = status;
    this.headers = headers;
    this.body = body;
  }

  isSuccessful(): boolean {
    return this.status >= 200 && this.status < 300;
  }

  /** 大小写不敏感地取响应头；键由平台层保证为小写。 */
  header(name: string): string | null {
    const key: string = name.toLowerCase();
    return this.headers.has(key) ? this.headers.get(key) as string : null;
  }

  text(): string {
    return utf8Decode(this.body);
  }
}

/** 平台传输实现：`@ohos.net.http`（或 rcp）达成。 */
export interface HttpTransport {
  request(req: HttpRequest): Promise<HttpResponse>;
}

/** WS 事件回调；`onDown` 在关闭或失败时**恰好调用一次**。 */
export interface WebSocketCallbacks {
  onOpen(): void;

  onMessage(text: string): void;

  onDown(reason: string): void;
}

/** 已打开的 WS 句柄。 */
export interface EventSocketHandle {
  close(): void;
}

/**
 * 平台 WS 实现：给定 URL 与握手头，打开长连接。
 * 传入的 URL 是**同源 http(s)**；平台层负责协议升级（`@ohos.net.webSocket` 接受 http(s) URL）。
 */
export interface WebSocketTransport {
  open(url: string, headers: Map<string, string>, callbacks: WebSocketCallbacks): EventSocketHandle;
}

/** 延迟执行能力（替代协程调度器），供 WS 退避使用。 */
export interface TimerBridge {
  schedule(delayMs: number, action: () => void): number;

  cancel(handle: number): void;
}

/** 可关闭的事件订阅（对应上游返回的 `Closeable`）。 */
export interface EventsSubscription {
  close(): void;
}

/** 客户端的外部依赖（全部可注入，便于单测与平台替换）。 */
export interface DshClientDeps {
  /** 生成客户端请求 id（UUID v4）。 */
  newId(): string;

  /** 本机时区 id（如 `Asia/Shanghai`）。 */
  timeZoneId(): string;

  /** 当前界面语言（BCP-47，如 `zh-CN` / `en`）。 */
  languageTag(): string;

  /**
   * 设备身份标签，形如 `harmonyos/ICL-AL10`（`platform/model`）。
   *
   * 由平台层拼好再注入：机型名要读 `@ohos.deviceInfo`，而本文件的规矩是
   * 「core 不碰任何 @ohos」（见 `DshClient.ts` 文件头）。它随每个**鉴权**请求出海，
   * 桥据此把设备表里的占位名换成「平台 · 型号」（`docs/inbox/2026-10-23-device-identity-header.md`）。
   */
  deviceTag(): string;

  /** 平台 WS 实现；不用事件推送时为 null。 */
  socket: WebSocketTransport | null;

  /** 平台定时器；不用事件推送时为 null。 */
  timers: TimerBridge | null;
}

// ---------------------------------------------------------------------------
// 事件通道（WS + 退避重连）
// ---------------------------------------------------------------------------

/**
 * 长连接事件通道。**重连后状态恢复始终靠 REST** —— 这里只负责「把帧送出去」与「掉线了告诉
 * 上层」，绝不假设补发能拼回完整状态。
 */
export class EventsChannel implements EventsSubscription {
  private url: string;
  private headers: Map<string, string>;
  private socket: WebSocketTransport;
  private timers: TimerBridge;
  private listener: (event: WorkspaceEvent) => void;
  private connectionListener: (open: boolean) => void;
  private closed: boolean = false;
  private retries: number = 0;
  private handle: EventSocketHandle | null = null;
  private timerHandle: number = -1;

  constructor(url: string, headers: Map<string, string>, socket: WebSocketTransport, timers: TimerBridge,
              listener: (event: WorkspaceEvent) => void, connectionListener: (open: boolean) => void) {
    this.url = url;
    this.headers = headers;
    this.socket = socket;
    this.timers = timers;
    this.listener = listener;
    this.connectionListener = connectionListener;
  }

  start(): void {
    this.connect();
  }

  private connect(): void {
    if (this.closed) {
      return;
    }
    // 每次连接尝试独立一个终态标记：同一次尝试里 onDown 只处理一次
    // （平台层可能先报 onError 再报 onClose）。
    let terminal: boolean = false;
    const self: EventsChannel = this;
    this.handle = this.socket.open(this.url, this.headers, {
      onOpen: (): void => {
        self.retries = 0;
        self.connectionListener(true);
      },
      onMessage: (text: string): void => {
        const event: WorkspaceEvent | null = WorkspaceEvent.fromJsonText(text);
        if (event !== null) {
          self.listener(event);
        }
      },
      onDown: (): void => {
        if (terminal) {
          return;
        }
        terminal = true;
        if (self.closed) {
          return;
        }
        self.connectionListener(false);
        const delaySeconds: number = Math.min(1 << Math.min(self.retries, 5), WS_MAX_BACKOFF_SECONDS);
        self.retries += 1;
        self.timerHandle = self.timers.schedule(delaySeconds * 1000, (): void => self.connect());
      },
    });
  }

  close(): void {
    this.closed = true;
    this.connectionListener(false);
    if (this.timerHandle >= 0) {
      this.timers.cancel(this.timerHandle);
      this.timerHandle = -1;
    }
    if (this.handle !== null) {
      this.handle.close();
      this.handle = null;
    }
  }
}
