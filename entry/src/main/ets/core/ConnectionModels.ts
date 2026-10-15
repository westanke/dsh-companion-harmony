/**
 * 连接层数据模型 —— 移植自原工程 `data/ConnectionModels.kt`。
 *
 * 核心拆分（原工程的设计意图，必须保持）：
 * - Host      = 「一台电脑」（用户视角实体，有名字、有凭据）；
 * - Endpoint  = 「这台电脑的一个可达地址」，一台电脑可有任意多个；
 * - Credential 挂在 Host 上，而不是挂在某个地址上。
 */

import { JsonAccess, JsonMap } from './JsonAccess';
import { normalizeEndpoint, stripApiSuffix } from './EndpointUrl';

/** 地址类型，用于选路加权与界面标注。 */
export enum EndpointKind {
  LAN = 0,
  VIRTUAL_NET = 1,
  WAN = 2,
  UNKNOWN = 3,
}

/** 凭据种类。 */
export enum CredentialKind {
  DEVICE_TOKEN = 0,
  PASSWORD = 1,
  CUSTOM_PASSWORD = 2,
}

export function endpointKindToWire(kind: EndpointKind): string {
  if (kind === EndpointKind.LAN) return 'LAN';
  if (kind === EndpointKind.VIRTUAL_NET) return 'VIRTUAL_NET';
  if (kind === EndpointKind.WAN) return 'WAN';
  return 'UNKNOWN';
}

export function endpointKindFromWire(raw: string | null): EndpointKind {
  if (raw === 'LAN') return EndpointKind.LAN;
  if (raw === 'VIRTUAL_NET') return EndpointKind.VIRTUAL_NET;
  if (raw === 'WAN') return EndpointKind.WAN;
  return EndpointKind.UNKNOWN;
}

export function credentialKindToWire(kind: CredentialKind): string {
  if (kind === CredentialKind.PASSWORD) return 'PASSWORD';
  if (kind === CredentialKind.CUSTOM_PASSWORD) return 'CUSTOM_PASSWORD';
  return 'DEVICE_TOKEN';
}

export function credentialKindFromWire(raw: string | null): CredentialKind {
  if (raw === 'PASSWORD') return CredentialKind.PASSWORD;
  if (raw === 'CUSTOM_PASSWORD') return CredentialKind.CUSTOM_PASSWORD;
  return CredentialKind.DEVICE_TOKEN;
}

/** 按地址猜类型；只做粗判，绝不抛异常（猜错只影响排序加权，真实可用性由探活决定）。 */
export function inferEndpointKind(baseUrl: string): EndpointKind {
  let host: string = baseUrl.trim();
  if (host.startsWith('http://')) host = host.substring(7);
  if (host.startsWith('https://')) host = host.substring(8);
  const slash: number = host.indexOf('/');
  if (slash >= 0) host = host.substring(0, slash);
  const colon: number = host.indexOf(':');
  if (colon >= 0) host = host.substring(0, colon);
  host = host.toLowerCase();
  if (host.length === 0) return EndpointKind.UNKNOWN;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return EndpointKind.LAN;
  if (host.endsWith('.local')) return EndpointKind.LAN;
  const parts: string[] = host.split('.');
  if (parts.length !== 4) return EndpointKind.UNKNOWN;
  const octets: number[] = [];
  for (let i = 0; i < 4; i++) {
    const n: number = parseInt(parts[i], 10);
    if (isNaN(n) || n < 0 || n > 255 || `${n}` !== parts[i]) return EndpointKind.UNKNOWN;
    octets.push(n);
  }
  const a: number = octets[0];
  const b: number = octets[1];
  if (a === 10) return EndpointKind.LAN;
  if (a === 192 && b === 168) return EndpointKind.LAN;
  if (a === 172 && b >= 16 && b <= 31) return EndpointKind.LAN;
  if (a === 100 && b >= 64 && b <= 127) return EndpointKind.VIRTUAL_NET;
  if (a === 169 && b === 254) return EndpointKind.LAN;
  return EndpointKind.WAN;
}

/** 一台电脑的一个可达地址。 */
export class Endpoint {
  id: string = '';
  label: string = '';
  baseUrl: string = '';
  kind: EndpointKind = EndpointKind.UNKNOWN;
  enabled: boolean = true;
  lastLatencyMs: number | null = null;
  lastCheckedAt: number | null = null;
  lastError: string | null = null;

  constructor(id: string, label: string, baseUrl: string, kind: EndpointKind = EndpointKind.UNKNOWN,
              enabled: boolean = true, lastLatencyMs: number | null = null,
              lastCheckedAt: number | null = null, lastError: string | null = null) {
    this.id = id;
    this.label = label;
    this.baseUrl = baseUrl;
    this.kind = kind;
    this.enabled = enabled;
    this.lastLatencyMs = lastLatencyMs;
    this.lastCheckedAt = lastCheckedAt;
    this.lastError = lastError;
  }

  /** 由 label + baseUrl 构造：baseUrl 归一为不含 `/api/v1` 的基地址，kind 自动推断。 */
  static create(label: string, baseUrl: string, id: string): Endpoint {
    const normalized: string = stripApiSuffix(normalizeEndpoint(baseUrl));
    const finalLabel: string = label.trim().length > 0 ? label : normalized;
    return new Endpoint(id, finalLabel, normalized, inferEndpointKind(normalized));
  }

  /** 探活后更新延迟/错误/时间，其余字段不变。 */
  withProbe(latencyMs: number | null, error: string | null, checkedAt: number): Endpoint {
    return new Endpoint(this.id, this.label, this.baseUrl, this.kind, this.enabled,
      latencyMs, checkedAt, error);
  }

  copy(): Endpoint {
    return new Endpoint(this.id, this.label, this.baseUrl, this.kind, this.enabled,
      this.lastLatencyMs, this.lastCheckedAt, this.lastError);
  }

  toJsonString(): string {
    const obj: EndpointWire = {
      id: this.id,
      label: this.label,
      baseUrl: this.baseUrl,
      kind: endpointKindToWire(this.kind),
      enabled: this.enabled,
      lastLatencyMs: this.lastLatencyMs,
      lastCheckedAt: this.lastCheckedAt,
      lastError: this.lastError,
    };
    return JSON.stringify(obj);
  }

  static fromJson(map: JsonMap | null): Endpoint {
    return new Endpoint(
      JsonAccess.str(map, 'id') ?? '',
      JsonAccess.str(map, 'label') ?? '',
      JsonAccess.str(map, 'baseUrl') ?? '',
      endpointKindFromWire(JsonAccess.str(map, 'kind')),
      JsonAccess.bool(map, 'enabled') ?? true,
      JsonAccess.num(map, 'lastLatencyMs'),
      JsonAccess.num(map, 'lastCheckedAt'),
      JsonAccess.str(map, 'lastError'),
    );
  }
}

export interface EndpointWire {
  id: string;
  label: string;
  baseUrl: string;
  kind: string;
  enabled: boolean;
  lastLatencyMs: number | null;
  lastCheckedAt: number | null;
  lastError: string | null;
}

/** 主机凭据。明文 JSON 一律不得落盘/写日志（落盘前必须经加密）。 */
export class Credential {
  kind: CredentialKind = CredentialKind.DEVICE_TOKEN;
  secret: string = '';
  deviceId: string | null = null;
  deviceName: string | null = null;
  scopes: string[] = [];
  issuedAt: number = 0;
  expiresAt: number | null = null;

  constructor(kind: CredentialKind = CredentialKind.DEVICE_TOKEN, secret: string = '',
              deviceId: string | null = null, deviceName: string | null = null,
              scopes: string[] = [], issuedAt: number = 0, expiresAt: number | null = null) {
    this.kind = kind;
    this.secret = secret;
    this.deviceId = deviceId;
    this.deviceName = deviceName;
    this.scopes = scopes;
    this.issuedAt = issuedAt;
    this.expiresAt = expiresAt;
  }

  isExpired(now: number): boolean {
    return this.expiresAt !== null && this.expiresAt <= now;
  }

  toJsonString(): string {
    const obj: CredentialWire = {
      kind: credentialKindToWire(this.kind),
      secret: this.secret,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      scopes: this.scopes,
      issuedAt: this.issuedAt,
      expiresAt: this.expiresAt,
    };
    return JSON.stringify(obj);
  }

  static fromJson(map: JsonMap | null): Credential {
    return new Credential(
      credentialKindFromWire(JsonAccess.str(map, 'kind')),
      JsonAccess.str(map, 'secret') ?? '',
      JsonAccess.str(map, 'deviceId'),
      JsonAccess.str(map, 'deviceName'),
      JsonAccess.strArr(map, 'scopes'),
      JsonAccess.num(map, 'issuedAt') ?? 0,
      JsonAccess.num(map, 'expiresAt'),
    );
  }
}

export interface CredentialWire {
  kind: string;
  secret: string;
  deviceId: string | null;
  deviceName: string | null;
  scopes: string[];
  issuedAt: number;
  expiresAt: number | null;
}

/** 一台电脑。 */
export class Host {
  id: string = '';
  displayName: string = '';
  endpoints: Endpoint[] = [];
  preferredEndpointId: string | null = null;
  credential: Credential | null = null;
  createdAt: number = 0;
  updatedAt: number = 0;

  constructor(id: string, displayName: string, endpoints: Endpoint[] = [],
              preferredEndpointId: string | null = null, credential: Credential | null = null,
              createdAt: number = 0, updatedAt: number = 0) {
    this.id = id;
    this.displayName = displayName;
    this.endpoints = endpoints;
    this.preferredEndpointId = preferredEndpointId;
    this.credential = credential;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }

  endpoint(id: string | null): Endpoint | null {
    if (id === null) return null;
    for (let i = 0; i < this.endpoints.length; i++) {
      if (this.endpoints[i].id === id) return this.endpoints[i];
    }
    return null;
  }

  /** 参与探活的地址：启用中且地址非空。 */
  activeEndpoints(): Endpoint[] {
    const out: Endpoint[] = [];
    for (let i = 0; i < this.endpoints.length; i++) {
      const e: Endpoint = this.endpoints[i];
      if (e.enabled && e.baseUrl.trim().length > 0) out.push(e);
    }
    return out;
  }

  /** 更新某个地址的探活结果，并刷新 updatedAt。 */
  withEndpointProbe(endpointId: string, latencyMs: number | null, error: string | null, checkedAt: number): Host {
    const next: Endpoint[] = [];
    for (let i = 0; i < this.endpoints.length; i++) {
      const e: Endpoint = this.endpoints[i];
      next.push(e.id === endpointId ? e.withProbe(latencyMs, error, checkedAt) : e);
    }
    const h: Host = this.copy();
    h.endpoints = next;
    h.updatedAt = checkedAt;
    return h;
  }

  withPreferred(endpointId: string | null): Host {
    const h: Host = this.copy();
    h.preferredEndpointId = endpointId;
    return h;
  }

  copy(): Host {
    const eps: Endpoint[] = [];
    for (let i = 0; i < this.endpoints.length; i++) eps.push(this.endpoints[i].copy());
    const cred: Credential | null = this.credential === null ? null : Credential.fromJson(
      JsonAccess.asMap(JsonAccess.parse(this.credential.toJsonString())));
    return new Host(this.id, this.displayName, eps, this.preferredEndpointId, cred, this.createdAt, this.updatedAt);
  }

  toJsonString(): string {
    const obj: HostWire = {
      id: this.id,
      displayName: this.displayName,
      endpoints: this.endpointWires(),
      preferredEndpointId: this.preferredEndpointId,
      credential: this.credentialWire(),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
    return JSON.stringify(obj);
  }

  private endpointWires(): EndpointWire[] {
    const out: EndpointWire[] = [];
    for (let i = 0; i < this.endpoints.length; i++) {
      const e: Endpoint = this.endpoints[i];
      out.push({
        id: e.id,
        label: e.label,
        baseUrl: e.baseUrl,
        kind: endpointKindToWire(e.kind),
        enabled: e.enabled,
        lastLatencyMs: e.lastLatencyMs,
        lastCheckedAt: e.lastCheckedAt,
        lastError: e.lastError,
      });
    }
    return out;
  }

  private credentialWire(): CredentialWire | null {
    if (this.credential === null) return null;
    const c: Credential = this.credential;
    return {
      kind: credentialKindToWire(c.kind),
      secret: c.secret,
      deviceId: c.deviceId,
      deviceName: c.deviceName,
      scopes: c.scopes,
      issuedAt: c.issuedAt,
      expiresAt: c.expiresAt,
    };
  }

  static fromJson(map: JsonMap | null): Host {
    const eps: Endpoint[] = [];
    const rawEps: JsonMap[] = JsonAccess.objArr(map, 'endpoints');
    for (let i = 0; i < rawEps.length; i++) eps.push(Endpoint.fromJson(rawEps[i]));
    const credMap: JsonMap | null = JsonAccess.obj(map, 'credential');
    const cred: Credential | null = credMap === null ? null : Credential.fromJson(credMap);
    return new Host(
      JsonAccess.str(map, 'id') ?? '',
      JsonAccess.str(map, 'displayName') ?? '',
      eps,
      JsonAccess.str(map, 'preferredEndpointId'),
      cred,
      JsonAccess.num(map, 'createdAt') ?? 0,
      JsonAccess.num(map, 'updatedAt') ?? 0,
    );
  }
}

export interface HostWire {
  id: string;
  displayName: string;
  endpoints: EndpointWire[];
  preferredEndpointId: string | null;
  credential: CredentialWire | null;
  createdAt: number;
  updatedAt: number;
}

/** 一次探活的结果。 */
export class EndpointProbe {
  endpointId: string = '';
  ok: boolean = false;
  latencyMs: number | null = null;
  error: string | null = null;

  constructor(endpointId: string, ok: boolean, latencyMs: number | null = null, error: string | null = null) {
    this.endpointId = endpointId;
    this.ok = ok;
    this.latencyMs = latencyMs;
    this.error = error;
  }

  static success(endpointId: string, latencyMs: number): EndpointProbe {
    return new EndpointProbe(endpointId, true, latencyMs, null);
  }

  static failure(endpointId: string, error: string): EndpointProbe {
    return new EndpointProbe(endpointId, false, null, error);
  }
}

/**
 * 选路规则（与 [ConnectionCoordinator] 及测试必须一致）：
 * 1. 只有探活成功且有延迟的地址参与排序；全失败返回空。
 * 2. 主排序键：延迟升序。
 * 3. 局域网「近似即优先」：LAN 地址延迟 ≤ 最快 × LAN_LATENCY_TOLERANCE 时并入第 0 档。
 * 4. 并列：preferredEndpointId 优先，其次 lastCheckedAt（null 视为最旧）。
 */
export class EndpointSelection {
  static readonly LAN_LATENCY_TOLERANCE: number = 1.5;

  static rank(probes: EndpointProbe[], endpoints: Endpoint[], preferredId: string | null): EndpointProbe[] {
    const ok: EndpointProbe[] = [];
    for (let i = 0; i < probes.length; i++) {
      const p: EndpointProbe = probes[i];
      if (p.ok && p.latencyMs !== null) ok.push(p);
    }
    if (ok.length === 0) return [];

    let fastest: number = Number.MAX_SAFE_INTEGER;
    for (let i = 0; i < ok.length; i++) {
      const lat: number = ok[i].latencyMs as number;
      if (lat < fastest) fastest = lat;
    }

    const kindById: Map<string, EndpointKind> = new Map();
    const checkedById: Map<string, number> = new Map();
    for (let i = 0; i < endpoints.length; i++) {
      const e: Endpoint = endpoints[i];
      kindById.set(e.id, e.kind);
      checkedById.set(e.id, e.lastCheckedAt === null ? Number.MIN_SAFE_INTEGER : e.lastCheckedAt);
    }

    const tierOf = (p: EndpointProbe): number => {
      const kind: EndpointKind | undefined = kindById.get(p.endpointId);
      if (kind === EndpointKind.LAN && (p.latencyMs as number) <= fastest * EndpointSelection.LAN_LATENCY_TOLERANCE) {
        return 0;
      }
      return 1;
    };
    const checkedOf = (p: EndpointProbe): number => checkedById.get(p.endpointId) ?? Number.MIN_SAFE_INTEGER;

    const sorted: EndpointProbe[] = ok.slice();
    sorted.sort((x: EndpointProbe, y: EndpointProbe): number => {
      const t: number = tierOf(x) - tierOf(y);
      if (t !== 0) return t;
      const l: number = (x.latencyMs as number) - (y.latencyMs as number);
      if (l !== 0) return l;
      const px: number = x.endpointId === preferredId ? 0 : 1;
      const py: number = y.endpointId === preferredId ? 0 : 1;
      if (px !== py) return px - py;
      return checkedOf(x) - checkedOf(y);
    });
    return sorted;
  }
}

/** 选路结果：选中的地址 + 可用于请求的客户端（client 在 entry 层注入，此处仅占位类型）。 */
export class ConnectionTarget {
  host: Host;
  endpoint: Endpoint;
  probes: EndpointProbe[];

  constructor(host: Host, endpoint: Endpoint, probes: EndpointProbe[] = []) {
    this.host = host;
    this.endpoint = endpoint;
    this.probes = probes;
  }
}
