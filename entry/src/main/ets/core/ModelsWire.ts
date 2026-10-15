/**
 * 线上模型 —— **传输层基础**：请求体拼装（`WireBuilder`）、健康检查 / 根 / 设备 / 配对、
 * 旧版单连接存储（`StoredConnection`）、API 异常（`DshApiException`）。
 *
 * 面向服务端线上模型的**三条规矩**（字段一律给默认值 / 请求体省略 null / 判别联合按
 * type 分派）写在 `Models.ts` 的文件头 —— 那是本模块的索引，本文件只是它的一部分。
 * 拆分的来龙去脉见 `Models.ts`。
 */

import { JsonAccess, JsonMap } from './JsonAccess';

/**
 * 请求体 JSON 拼装助手：null 一律省略（见文件头第 2 条）。
 * 只用于「出站」请求体；入站解码一律走 `JsonAccess`。
 * 嵌套数组请传「对象映射数组」（`JsonMap[]`），别传已序列化的字符串 —— 那会被再次转义。
 */
export class WireBuilder {
  private map: JsonMap = {};

  /** 非 null 才写入；null 表示「不指定该字段」。 */
  put(key: string, value: Object | null): WireBuilder {
    if (value !== null) {
      this.map[key] = value;
    }
    return this;
  }

  /** 条件写入：仅在 flag 为 true 时写。 */
  putIf(flag: boolean, key: string, value: Object | null): WireBuilder {
    return flag ? this.put(key, value) : this;
  }

  buildMap(): JsonMap {
    return this.map;
  }

  build(): string {
    return JSON.stringify(this.map);
  }
}

/** 把一组「已序列化的 JSON 片段」拼成数组字符串，空数组返回 `[]`。 */
export function encodeArrayOf(fragments: string[]): string {
  if (fragments.length === 0) {
    return '[]';
  }
  let out: string = '[';
  for (let i = 0; i < fragments.length; i++) {
    if (i > 0) {
      out += ',';
    }
    out += fragments[i];
  }
  return `${out}]`;
}

/** 对象映射数组：嵌入父对象时用它，避免「把已序列化字符串当值」的二次转义。 */
export type JsonMapArray = JsonMap[];

// ---------------------------------------------------------------------------
// 健康检查 / 根 / 设备 / 配对
// ---------------------------------------------------------------------------

export class HealthView {
  ok: boolean = false;
  version: string = '';
  pluginVersion: string | null = null;

  static fromJson(map: JsonMap | null): HealthView {
    const v: HealthView = new HealthView();
    v.ok = JsonAccess.bool(map, 'ok') ?? false;
    v.version = JsonAccess.str(map, 'version') ?? '';
    v.pluginVersion = JsonAccess.str(map, 'pluginVersion');
    return v;
  }
}

export class RootView {
  id: string = '';
  label: string = '';
  createdAt: number = 0;

  static fromJson(map: JsonMap | null): RootView {
    const v: RootView = new RootView();
    v.id = JsonAccess.str(map, 'id') ?? '';
    v.label = JsonAccess.str(map, 'label') ?? '';
    v.createdAt = JsonAccess.num(map, 'createdAt') ?? 0;
    return v;
  }
}

export class DeviceView {
  id: string = '';
  name: string = '';
  scopes: string[] = [];
  rootIds: string[] = [];

  static fromJson(map: JsonMap | null): DeviceView {
    const v: DeviceView = new DeviceView();
    v.id = JsonAccess.str(map, 'id') ?? '';
    v.name = JsonAccess.str(map, 'name') ?? '';
    v.scopes = JsonAccess.strArr(map, 'scopes');
    v.rootIds = JsonAccess.strArr(map, 'rootIds');
    return v;
  }
}

export class PairingResult {
  token: string = '';
  device: DeviceView = new DeviceView();

  static fromJson(map: JsonMap | null): PairingResult {
    const v: PairingResult = new PairingResult();
    v.token = JsonAccess.str(map, 'token') ?? '';
    v.device = DeviceView.fromJson(JsonAccess.obj(map, 'device'));
    return v;
  }
}


// ---------------------------------------------------------------------------
// 旧版单连接存储
// ---------------------------------------------------------------------------

export class StoredConnection {
  endpoint: string = '';
  token: string = '';

  constructor(endpoint: string = '', token: string = '') {
    this.endpoint = endpoint;
    this.token = token;
  }

  isUsable(): boolean {
    return this.endpoint.trim().length > 0;
  }

  static fromJson(map: JsonMap | null): StoredConnection {
    return new StoredConnection(
      JsonAccess.str(map, 'endpoint') ?? '',
      JsonAccess.str(map, 'token') ?? '',
    );
  }
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 非 2xx 且响应体 `{error:{code,message,requestId?}}` 可解析时抛出的异常。 */
export class DshApiException extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
