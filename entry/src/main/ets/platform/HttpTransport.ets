/**
 * HttpTransport 的鸿蒙实现 —— `@ohos.net.http`（NetStack）。
 *
 * ## 分工
 *
 * core 的 `DshClient` 只负责「拼 URL、加鉴权头、解 JSON」；真正的网络调用在这里。
 * 这一层要做三件事，每一件都必须做对：
 *
 * 1. **错误码 → `NetworkFailureKind` 再抛 `NetworkException`**。core 与 UI 只认
 *    `NetworkException`（见 `ErrorMessages.ts` 头注释与 `HarnessViewModel` 的异常收敛），
 *    查表在 [classifyNetStackCode]（那张表在 core 里，可离线单测）。
 * 2. **响应体一律要字节**。显式 `expectDataType = ARRAY_BUFFER`，这样文本响应与
 *    二进制下载（文件预览）走同一条路，`HttpResponse.body` 语义统一为 `Uint8Array`；
 *    文本由 core 的 `utf8Decode` 还原（与安卓 OkHttp 的 `body.bytes()` 口径一致）。
 * 3. **响应头键统一小写**。`HttpResponse.header(name)` 约定键是小写（见 `DshClient.ts`），
 *    这样 `header('ETag')` 这类大小写不敏感查询在 core 不必遍历 Map。
 *
 * ## 超时口径
 *
 * 连接 15s / 读 45s 与 core 的常量一致（`CONNECT_TIMEOUT_MS` / `READ_TIMEOUT_MS`）。
 * NetStack 的 `HttpRequestOptions` **没有独立的写超时**（只有 `connectTimeout` 与
 * `readTimeout`），所以 `writeTimeoutMs` 在这里被忽略 —— 这是平台能力差异，不是遗漏。
 *
 * ## 每次请求新建一个 `HttpRequest` 对象
 *
 * 超时是**对象级**配置，复用同一个对象会让后一次调用沿用前一次的设置；
 * 且复用不保证并发安全。所以每次调用 `createHttp()`，结束（含异常路径）后 `destroy()`。
 */

import { http } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { HttpRequest, HttpResponse, HttpTransport } from '../core/DshClient';
import { NetworkException } from '../core/ErrorMessages';
import { classifyNetStackCode } from '../core/NetworkFailureMapping';
import { utf8Encode } from '../core/Codec';

/**
 * PATCH 的取法 —— **平台能力缺口，已记入 docs/PORT-MAP.md**。
 *
 * 本工程 SDK（API 18）的 `http.RequestMethod` 枚举只有
 * OPTIONS / GET / HEAD / POST / PUT / DELETE / TRACE / CONNECT，**没有 PATCH**。
 * 而 DSH 服务端把「重命名会话」「移动文件」「开关插件」全放在 PATCH 上，
 * 绕不过去。这里用断言把字符串塞进枚举：枚举值是字符串，NetStack 对非标准方法
 * 走 `CURLOPT_CUSTOMREQUEST`，所以运行期确实能发出 PATCH。
 * 若日后升级 SDK 且枚举补上了 PATCH，这里应改回 `http.RequestMethod.PATCH`。
 */
const REQUEST_METHOD_PATCH: http.RequestMethod = 'PATCH' as http.RequestMethod;

export class OhHttpTransport implements HttpTransport {
  async request(req: HttpRequest): Promise<HttpResponse> {
    const client: http.HttpRequest = http.createHttp();
    try {
      const options: http.HttpRequestOptions = {};
      options.method = methodOf(req.method);
      options.header = headerRecord(req.headers);
      options.expectDataType = http.HttpDataType.ARRAY_BUFFER;
      options.connectTimeout = req.connectTimeoutMs;
      options.readTimeout = req.readTimeoutMs;
      if (req.body !== null) {
        // GET/HEAD 的 body 在 core 里恒为 null（见 DshClient 的空体约定），所以这里不必再判方法。
        options.extraData = toArrayBuffer(req.body);
      }
      const res: http.HttpResponse = await client.request(req.url, options);
      return new HttpResponse(res.responseCode as number, lowerCasedHeaders(res.header), toBytes(res.result));
    } catch (e) {
      const err: BusinessError = e as BusinessError;
      const detail: string = `NetStack code=${err.code} ${err.message}`;
      throw new NetworkException(classifyNetStackCode(err.code), detail);
    } finally {
      client.destroy();
    }
  }
}

/** 方法名（core 里是大写字符串）→ NetStack 枚举。认不出的按 GET（core 只会给这五种）。 */
function methodOf(method: string): http.RequestMethod {
  if (method === 'POST') {
    return http.RequestMethod.POST;
  }
  if (method === 'PUT') {
    return http.RequestMethod.PUT;
  }
  if (method === 'DELETE') {
    return http.RequestMethod.DELETE;
  }
  if (method === 'PATCH') {
    return REQUEST_METHOD_PATCH;
  }
  return http.RequestMethod.GET;
}

/** 请求头 Map → 普通对象（NetStack 的 `header` 字段要的是对象，不是 Map）。 */
function headerRecord(headers: Map<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value: string, key: string): void => {
    out[key] = value;
  });
  return out;
}

/** 响应头对象 → 小写键 Map（key 里可能有 `Set-Cookie` 这类数组值，非字符串一律丢）。 */
function lowerCasedHeaders(raw: Object): Map<string, string> {
  const out: Map<string, string> = new Map();
  const rec: Record<string, string> = raw as Record<string, string>;
  const keys: string[] = Object.keys(rec);
  for (let i = 0; i < keys.length; i++) {
    const key: string = keys[i];
    const value: string = rec[key];
    if (typeof value === 'string') {
      out.set(key.toLowerCase(), value);
    }
  }
  return out;
}

/** 响应体 → 字节。已显式请求 ARRAY_BUFFER，故正常情况下必是 ArrayBuffer；其余分支是防御。 */
function toBytes(result: string | Object | ArrayBuffer): Uint8Array {
  if (result instanceof ArrayBuffer) {
    return new Uint8Array(result);
  }
  if (typeof result === 'string') {
    return utf8Encode(result);
  }
  return new Uint8Array(0);
}

/**
 * `Uint8Array` → `ArrayBuffer`。
 *
 * 只在视图**正好覆盖整个 buffer** 时才直接复用，否则必须拷贝：core 用
 * `slice` / `readAtMost` 造出来的数组常常是某个大 buffer 的片段，
 * 直接交 `buffer` 会把多余字节也发出去（附件上传时尤其致命）。
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer;
  }
  const copy: ArrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}
