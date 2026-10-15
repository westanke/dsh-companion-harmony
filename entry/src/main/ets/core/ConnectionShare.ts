/**
 * 「配置导入」的编解码 —— 移植自原工程 `data/ConnectionShare.kt`。
 *
 * 场景是「人已经出门在外，电脑留在家里」：任何要求配对时电脑在旁的方案（扫码）都会卡死，
 * 所以这里把连接信息压成一段能塞进微信的短文本。也正因如此，解码容错要求高于普通解析
 * ——用户粘贴时已经离开电脑，此刻失败就等于整个方案失败。
 *
 * 线格式：`DSH1:<UTF-8 JSON 的 Base64 URL-safe 无填充编码>`，长度预算 ≤ 600 字符。
 *
 * JSON（字段名即 SharePayload 的字段名）：
 *   {"displayName":"家里的电脑","endpoints":[{"label":"家","baseUrl":"http://192.168.1.126:3090"}],
 *    "token":"设备令牌","deviceName":"Pixel 9","scopes":["files.read"]}
 *
 * 刻意取舍：
 * - 不写 Endpoint.id / 探活历史 / kind / enabled（本机状态，换机无意义，白占字符）；
 *   解码端反而不挑剔，多塞了 id/kind 也照读。
 * - token / deviceName 为 null 时不写键；scopes 为空时不写。
 * - baseUrl 统一归一为不含 /api/v1 的基地址。
 *
 * 安全边界：encode 刻意不加密 —— 这段文本本身就是凭据载体（内含设备令牌），Base64 只是编码。
 * 不要发到群聊/公开渠道；一旦怀疑泄露，正确做法是立刻在电脑上吊销该设备令牌。
 */

import { Host, Endpoint, Credential, CredentialKind } from './ConnectionModels';
import { JsonAccess, JsonMap } from './JsonAccess';
import { shareNormalizeBaseUrl, isUsableBaseUrl } from './EndpointUrl';
import { base64Encode, base64DecodeEither, utf8Encode, utf8Decode } from './Codec';

export const SHARE_PREFIX = 'DSH1:';

const FALLBACK_HOST_NAME = '电脑';

/** 零宽字符、BOM 之类「看不见但不是空白」的字符，粘贴链路里很常见。 */
const INVISIBLE_CHARS: string[] = ['\uFEFF', '\u200B', '\u200C', '\u200D', '\u2060'];

/** 分享用地址：只有 label 与 baseUrl（id 用于承载解码端多塞进来的值，可为空）。 */
export class ShareEndpoint {
  id: string = '';
  label: string = '';
  baseUrl: string = '';

  constructor(label: string = '', baseUrl: string = '', id: string = '') {
    this.label = label;
    this.baseUrl = baseUrl;
    this.id = id;
  }

  static fromJson(map: JsonMap | null): ShareEndpoint {
    return new ShareEndpoint(
      JsonAccess.str(map, 'label') ?? '',
      JsonAccess.str(map, 'baseUrl') ?? '',
      JsonAccess.str(map, 'id') ?? '',
    );
  }
}

/** 解码得到的配置（尚未变成 Host）。 */
export class SharePayload {
  displayName: string = '';
  endpoints: ShareEndpoint[] = [];
  token: string | null = null;
  deviceName: string | null = null;
  scopes: string[] = [];

  constructor(displayName: string = '', endpoints: ShareEndpoint[] = [], token: string | null = null,
              deviceName: string | null = null, scopes: string[] = []) {
    this.displayName = displayName;
    this.endpoints = endpoints;
    this.token = token;
    this.deviceName = deviceName;
    this.scopes = scopes;
  }
}

function nonEmptyOrNull(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed: string = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cleanScopes(scopes: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < scopes.length; i++) {
    const t: string = scopes[i].trim();
    if (t.length > 0) {
      out.push(t);
    }
  }
  return out;
}

/** 默认 id 工厂：不依赖平台 API 的伪 UUID，仅在调用方未注入时使用。 */
function defaultIdFactory(): string {
  const a: number = Math.floor(Math.random() * 0x100000000);
  const b: number = Date.now() & 0xFFFFFFFF;
  return `${b.toString(16)}-${a.toString(16)}`;
}

export class ConnectionShare {
  /**
   * 把配置编码成可粘贴文本：`DSH1:` + URL-safe 无填充 Base64。
   *
   * 非法输入（地址为空、地址不是 http/https）会抛 Error —— 这是唯一故意抛异常处：
   * 生成端此刻人还在电脑前，能立刻看到并修正；把坏配置生成出来、等用户到外面粘贴才发现
   * 无效，才是真正的灾难。
   */
  static encode(payload: SharePayload): string {
    const displayName: string = payload.displayName.trim();
    const endpoints: ShareEndpoint[] = [];
    for (let i = 0; i < payload.endpoints.length; i++) {
      const e: ShareEndpoint = payload.endpoints[i];
      endpoints.push(new ShareEndpoint(e.label.trim(), shareNormalizeBaseUrl(e.baseUrl)));
    }
    if (endpoints.length === 0) {
      throw new Error('至少需要一个地址才能生成配置文本');
    }
    for (let i = 0; i < endpoints.length; i++) {
      if (!isUsableBaseUrl(endpoints[i].baseUrl)) {
        throw new Error(`地址必须是 http:// 或 https:// 开头（去掉 /api/v1 之后）：${endpoints[i].baseUrl}`);
      }
    }

    // 手工拼 JSON：encodeDefaults=false / explicitNulls=false 的等价效果，省掉空键。
    const parts: string[] = [];
    if (displayName.length > 0) {
      parts.push(`"displayName":${JSON.stringify(displayName)}`);
    }
    const epParts: string[] = [];
    for (let i = 0; i < endpoints.length; i++) {
      const e: ShareEndpoint = endpoints[i];
      const inner: string[] = [];
      if (e.label.length > 0) {
        inner.push(`"label":${JSON.stringify(e.label)}`);
      }
      inner.push(`"baseUrl":${JSON.stringify(e.baseUrl)}`);
      epParts.push(`{${inner.join(',')}}`);
    }
    parts.push(`"endpoints":[${epParts.join(',')}]`);
    const token: string | null = nonEmptyOrNull(payload.token);
    if (token !== null) {
      parts.push(`"token":${JSON.stringify(token)}`);
    }
    const deviceName: string | null = nonEmptyOrNull(payload.deviceName);
    if (deviceName !== null) {
      parts.push(`"deviceName":${JSON.stringify(deviceName)}`);
    }
    const scopes: string[] = cleanScopes(payload.scopes);
    if (scopes.length > 0) {
      parts.push(`"scopes":${JSON.stringify(scopes)}`);
    }

    const body: string = `{${parts.join(',')}}`;
    return SHARE_PREFIX + base64Encode(utf8Encode(body), true, false);
  }

  /**
   * 解析用户粘贴的文本。任何失败都返回 null，绝不抛异常。
   *
   * 接受：首尾与内部的空白换行、零宽字符与 BOM、带或不带前缀（大小写不敏感、可出现在
   * 整段任意位置）、URL-safe 与标准字母表、缺失的 `=` 填充、结尾粘上的标点。
   */
  static decode(text: string): SharePayload | null {
    const body: string = ConnectionShare.stripPrefix(ConnectionShare.clean(text));
    const bytes: Uint8Array | null = base64DecodeEither(body);
    if (bytes === null) {
      return null;
    }
    const raw: string = utf8Decode(bytes);
    const map: JsonMap | null = ConnectionShare.parseWire(raw);
    if (map === null) {
      return null;
    }
    const payload: SharePayload = ConnectionShare.toPayload(map);
    return ConnectionShare.isUsable(payload) ? payload : null;
  }

  /**
   * 把配置变成一个可入库的 Host。
   *
   * - hostId 由 idFactory 提供（只调用一次）；地址 id 优先沿用 payload 里已有的值，
   *   没有则派生成 `<hostId>-ep1`、`<hostId>-ep2` …，保证同一 Host 内唯一；
   * - 每个地址重新推断 kind，并清空探活历史；
   * - token 非空时建 DEVICE_TOKEN 凭据；
   * - preferredEndpointId 保持 null —— 语义是「上次成功连接的地址」，刚导入时并不存在；
   * - createdAt / updatedAt / issuedAt 取当前时间。
   */
  static buildHost(payload: SharePayload, idFactory: (() => string) | null = null,
                   clock: (() => number) | null = null): Host {
    const makeId: () => string = idFactory === null ? defaultIdFactory : idFactory;
    const now: number = clock === null ? Date.now() : clock();
    const hostId: string = makeId();

    const endpoints: Endpoint[] = [];
    for (let i = 0; i < payload.endpoints.length; i++) {
      const src: ShareEndpoint = payload.endpoints[i];
      const baseUrl: string = shareNormalizeBaseUrl(src.baseUrl);
      const id: string = src.id.trim().length > 0 ? src.id.trim() : `${hostId}-ep${i + 1}`;
      const label: string = src.label.trim().length > 0 ? src.label.trim() : baseUrl;
      endpoints.push(Endpoint.create(label, baseUrl, id));
    }

    const token: string | null = nonEmptyOrNull(payload.token);
    let credential: Credential | null = null;
    if (token !== null) {
      credential = new Credential(CredentialKind.DEVICE_TOKEN, token, null,
        nonEmptyOrNull(payload.deviceName), cleanScopes(payload.scopes), now, null);
    }

    const displayName: string = payload.displayName.trim().length > 0
      ? payload.displayName.trim()
      : FALLBACK_HOST_NAME;

    return new Host(hostId, displayName, endpoints, null, credential, now, now);
  }

  /** 基础校验：至少一个地址，且每个地址去掉 /api/v1 后都是 http/https 且有主机名。 */
  private static isUsable(payload: SharePayload): boolean {
    if (payload.endpoints.length === 0) {
      return false;
    }
    for (let i = 0; i < payload.endpoints.length; i++) {
      if (!isUsableBaseUrl(payload.endpoints[i].baseUrl)) {
        return false;
      }
    }
    return true;
  }

  /** 去掉所有空白（含微信插入的换行、邮件折行、全角空格、nbsp）与零宽字符。 */
  private static clean(text: string): string {
    let out: string = '';
    for (let i = 0; i < text.length; i++) {
      const ch: string = text.charAt(i);
      if (ch.trim().length === 0) {
        continue;
      }
      let invisible: boolean = false;
      for (let k = 0; k < INVISIBLE_CHARS.length; k++) {
        if (ch === INVISIBLE_CHARS[k]) {
          invisible = true;
          break;
        }
      }
      if (!invisible) {
        out += ch;
      }
    }
    return out;
  }

  /**
   * 前缀可选、大小写不敏感，且允许它出现在整段文本的任意位置。
   * 因为空白已被清掉，「DS\nH1:」这种被拆开的写法也能命中；于是「Pixel 9 Pro 的配置：DSH1:xxx」
   * 这种带标签的粘贴也能救回来。找不到哨兵就把整段当作纯 Base64。
   */
  private static stripPrefix(text: string): string {
    const at: number = text.toUpperCase().indexOf(SHARE_PREFIX);
    return at >= 0 ? text.substring(at + SHARE_PREFIX.length) : text;
  }

  /** 先按原样解析；失败则截出最外层 `{ ... }` 再试（解码结果里混了前后缀文字的情况）。 */
  private static parseWire(raw: string): JsonMap | null {
    const direct: JsonMap | null = JsonAccess.asMap(JsonAccess.parse(raw));
    if (direct !== null) {
      return direct;
    }
    const start: number = raw.indexOf('{');
    const end: number = raw.lastIndexOf('}');
    if (start < 0 || end <= start) {
      return null;
    }
    return JsonAccess.asMap(JsonAccess.parse(raw.substring(start, end + 1)));
  }

  private static toPayload(map: JsonMap | null): SharePayload {
    const endpoints: ShareEndpoint[] = [];
    const rawEndpoints: JsonMap[] = JsonAccess.objArr(map, 'endpoints');
    for (let i = 0; i < rawEndpoints.length; i++) {
      const src: ShareEndpoint = ShareEndpoint.fromJson(rawEndpoints[i]);
      endpoints.push(new ShareEndpoint(src.label, shareNormalizeBaseUrl(src.baseUrl), src.id.trim()));
    }
    return new SharePayload(
      (JsonAccess.str(map, 'displayName') ?? '').trim(),
      endpoints,
      nonEmptyOrNull(JsonAccess.str(map, 'token')),
      nonEmptyOrNull(JsonAccess.str(map, 'deviceName')),
      cleanScopes(JsonAccess.strArr(map, 'scopes')),
    );
  }
}
