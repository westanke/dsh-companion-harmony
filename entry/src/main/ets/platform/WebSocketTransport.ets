/**
 * WebSocketTransport 的鸿蒙实现 —— `@ohos.net.webSocket`（NetStack）。
 *
 * ## 关键约定
 *
 * - **传入的 URL 是同源 `http://` / `https://`**（见 `DshClient.ts`）。本层负责改写成
 *   `ws://` / `wss://` —— **必须改**：NetStack 的 `webSocket.connect` 只认 ws(s) scheme，
 *   直接喂 `http://` 会在 native 层报 `ParseUrl failed`（真机 NETSTACK 日志实证，
 *   见 PORT-MAP 坑 17；早先「NetStack 会自行完成协议升级」的假设是错的）。
 * - 握手头由 core 的 `authHeaders()` 给出（`Authorization` / `Accept` / `Accept-Language`），
 *   这里只做 Map → 普通对象的搬运。
 * - `onDown` **恰好一次**：NetStack 可能先报 `error` 再报 `close`，因此本层自带
 *   `terminal` 闸；同时「我们主动 `close()`」之后的所有回调一律丢弃 —— 那是用户
 *   （或 `EventsChannel.close()`）的选择，不该再被报成一次「掉线」。
 *   重连由 `EventsChannel` 负责（退避 1/2/4/8/16/30s），每次重连都会重新 `open()`，
 *   所以这里不持有跨次状态。
 * - 心跳 20s 由 core 的 `WS_PING_INTERVAL_MS` 约定，NetStack 底层自行保活，
 *   本层不需要显式发 ping。
 */

import { webSocket } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { EventSocketHandle, WebSocketCallbacks, WebSocketTransport } from '../core/DshClient';
import { utf8Decode } from '../core/Codec';

/** http(s) → ws(s)。NetStack 的 webSocket.connect 只认 ws / wss scheme（坑 17）。 */
function toWsUrl(url: string): string {
  if (url.startsWith('https://')) {
    return `wss://${url.substring('https://'.length)}`;
  }
  if (url.startsWith('http://')) {
    return `ws://${url.substring('http://'.length)}`;
  }
  return url;
}

export class OhWebSocketTransport implements WebSocketTransport {
  open(url: string, headers: Map<string, string>, callbacks: WebSocketCallbacks): EventSocketHandle {
    const socket: webSocket.WebSocket = webSocket.createWebSocket();
    /** 本次连接尝试是否已报过终态（成功/失败/关闭都算）。 */
    let terminal: boolean = false;
    /** 是否由我们主动关闭 —— 主动关闭后不再上报任何回调。 */
    let closedByUs: boolean = false;

    const down = (reason: string): void => {
      if (terminal || closedByUs) {
        return;
      }
      terminal = true;
      callbacks.onDown(reason);
    };

    socket.on('open', (err: BusinessError, value: Object): void => {
      if (closedByUs) {
        return;
      }
      if (err) {
        down(`open code=${err.code}`);
        return;
      }
      callbacks.onOpen();
    });

    socket.on('message', (err: BusinessError, value: string | ArrayBuffer): void => {
      if (closedByUs) {
        return;
      }
      if (err) {
        down(`message code=${err.code}`);
        return;
      }
      if (typeof value === 'string') {
        callbacks.onMessage(value as string);
      } else {
        // 二进制帧：服务端事件都是 UTF-8 JSON 文本，按文本解出来交给 core。
        callbacks.onMessage(utf8Decode(new Uint8Array(value as ArrayBuffer)));
      }
    });

    socket.on('close', (err: BusinessError, value: webSocket.CloseResult): void => {
      down(err ? `close code=${err.code}` : 'close');
    });

    socket.on('error', (err: BusinessError): void => {
      down(`error code=${err.code}`);
    });

    const options: webSocket.WebSocketRequestOptions = {};
    options.header = headerRecord(headers);
    socket.connect(toWsUrl(url), options).catch((e: BusinessError): void => {
      down(`connect code=${e.code}`);
    });

    return {
      close: (): void => {
        closedByUs = true;
        socket.off('open');
        socket.off('message');
        socket.off('close');
        socket.off('error');
        socket.close().catch((e: BusinessError): void => {
          // 主动关闭失败无需上报（EventsChannel 已自行作废这条连接）。
        });
      },
    };
  }
}

/** 请求头 Map → 普通对象（NetStack 的 `header` 字段要的是对象，不是 Map）。 */
function headerRecord(headers: Map<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value: string, key: string): void => {
    out[key] = value;
  });
  return out;
}
