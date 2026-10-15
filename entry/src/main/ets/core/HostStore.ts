/**
 * 多主机持久化 —— 移植自原工程 `data/HostStore.kt`。
 *
 * 存储格式：整份 Host 列表（含凭据明文）JSON → SecretBox 加密 → 标准 Base64 落盘。
 * **明文绝不落盘**，SharedPreferences（鸿蒙为 @ohos.data.preferences）里永远是密文。
 *
 * 损坏容错：读到的值「Base64 不合法 / 解密失败 / JSON 损坏」一律返回空列表，**绝不抛异常**
 * ——一条坏数据不该把用户永久锁进启动崩溃循环。原值保留在 hosts_v1，并另存副本到
 * hosts_v1_corrupt（不静默清空），方便日后排查。
 *
 * 平台依赖全部经 KeyValueStore / SecretBox / CryptoBridge 注入；本文件不 import 任何 @ohos。
 */

import { Host, Endpoint, Credential, CredentialKind } from './ConnectionModels';
import { JsonAccess } from './JsonAccess';
import { storeNormalizeBaseUrl, hostNameOf } from './EndpointUrl';
import { base64Encode, base64DecodeStrict, utf8Encode, utf8Decode } from './Codec';

/** 新版多主机列表的落盘键。 */
export const KEY_HOSTS = 'hosts_v1';

/** 解密 / 解析失败时保留的原始值副本，仅用于排查。 */
export const KEY_HOSTS_CORRUPT = 'hosts_v1_corrupt';

const HOST_ID_PREFIX = 'legacy-';
const ENDPOINT_ID_PREFIX = 'legacy-ep-';

/**
 * 极小的键值存储抽象。抽象存在的唯一理由是可测试：生产实现是 preferences，
 * 单测里换成内存 Map，于是本模块不需要真机。
 */
export interface KeyValueStore {
  getString(key: string): string | null;

  putString(key: string, value: string | null): void;

  remove(key: string): void;

  clear(): void;
}

/**
 * 对称加解密抽象。生产实现是鸿蒙 HUKS / Asset Store，单测里换成任意可逆变换（例如 XOR），
 * 从而不碰系统密钥库。
 */
export interface SecretBox {
  encrypt(plain: Uint8Array): Uint8Array;

  decrypt(cipher: Uint8Array): Uint8Array;
}

/**
 * 摘要能力抽象。ArkTS 侧需注入 `@ohos.security.cryptoFramework` 的 SHA-256，
 * node 侧注入 `node:crypto`。
 */
export interface CryptoBridge {
  sha256Hex(value: string): string;
}

export class HostStore {
  private storage: KeyValueStore;
  private secretBox: SecretBox;
  private crypto: CryptoBridge;
  private clock: () => number;

  constructor(storage: KeyValueStore, secretBox: SecretBox, crypto: CryptoBridge, clock: () => number) {
    this.storage = storage;
    this.secretBox = secretBox;
    this.crypto = crypto;
    this.clock = clock;
  }

  /** 读取全部主机。空存储、损坏数据、非法 Base64 都返回空列表而不是抛异常。 */
  loadHosts(): Host[] {
    const encoded: string | null = this.storage.getString(KEY_HOSTS);
    if (encoded === null || encoded.trim().length === 0) {
      return [];
    }
    try {
      const cipher: Uint8Array | null = base64DecodeStrict(encoded, false);
      if (cipher === null) {
        throw new Error('invalid base64');
      }
      const plain: string = utf8Decode(this.secretBox.decrypt(cipher));
      const parsed: Object | null = JsonAccess.parse(plain);
      if (parsed === null || !Array.isArray(parsed)) {
        throw new Error('invalid json');
      }
      const items: Object[] = parsed as Object[];
      const out: Host[] = [];
      for (let i = 0; i < items.length; i++) {
        out.push(Host.fromJson(JsonAccess.asMap(items[i])));
      }
      return out;
    } catch (e) {
      // 保留原值（不 remove、不清空），并额外留一份副本。
      this.quarantineCorrupt(encoded);
      return [];
    }
  }

  /** 覆盖式写入整个列表（加密后 Base64）。 */
  saveHosts(hosts: Host[]): void {
    const wires: string[] = [];
    for (let i = 0; i < hosts.length; i++) {
      wires.push(hosts[i].toJsonString());
    }
    const plain: string = `[${wires.join(',')}]`;
    const encrypted: Uint8Array = this.secretBox.encrypt(utf8Encode(plain));
    this.storage.putString(KEY_HOSTS, base64Encode(encrypted, false, true));
  }

  /**
   * 插入或替换单台主机，返回写入后的完整列表。
   *
   * 已存在同 id 时保留原有 createdAt（创建时间不该被一次编辑重置），并把 updatedAt 刷新为
   * clock()；不存在时若传入 createdAt 为 0，则用当前时间补齐。
   */
  upsert(host: Host): Host[] {
    const now: number = this.clock();
    const current: Host[] = this.loadHosts();
    const existing: Host | null = HostStore.findById(current, host.id);
    const createdAt: number = existing !== null
      ? existing.createdAt
      : (host.createdAt > 0 ? host.createdAt : now);
    const merged: Host = host.copy();
    merged.createdAt = createdAt;
    merged.updatedAt = now;

    const next: Host[] = [];
    if (existing === null) {
      for (let i = 0; i < current.length; i++) {
        next.push(current[i]);
      }
      next.push(merged);
    } else {
      for (let i = 0; i < current.length; i++) {
        next.push(current[i].id === merged.id ? merged : current[i]);
      }
    }
    this.saveHosts(next);
    return next;
  }

  /** 删除指定主机，返回删除后的完整列表。id 不存在时不报错。 */
  remove(hostId: string): Host[] {
    const current: Host[] = this.loadHosts();
    const next: Host[] = [];
    for (let i = 0; i < current.length; i++) {
      if (current[i].id !== hostId) {
        next.push(current[i]);
      }
    }
    this.saveHosts(next);
    return next;
  }

  /** 按 id 取单台主机。 */
  host(id: string): Host | null {
    return HostStore.findById(this.loadHosts(), id);
  }

  /**
   * 记住某主机上次成功使用的地址。传入 null 表示清空。
   * 只改选路偏好，不改 updatedAt —— 与 Host.withPreferred 的契约保持一致。
   */
  markPreferred(hostId: string, endpointId: string | null): void {
    const current: Host[] = this.loadHosts();
    if (HostStore.findById(current, hostId) === null) {
      return;
    }
    const next: Host[] = [];
    for (let i = 0; i < current.length; i++) {
      const h: Host = current[i];
      next.push(h.id === hostId ? h.withPreferred(endpointId) : h);
    }
    this.saveHosts(next);
  }

  /**
   * 把旧版「单地址 + 单令牌」迁移成一台 Host。
   *
   * - 无旧数据（legacyEndpoint 为 null/空白）返回 null，且不写任何东西；
   * - hostId / endpoint id 由地址的 SHA-256 派生，重复调用不会产生重复主机；
   * - displayName 取地址主机名（如 192.168.1.126）；
   * - 只建一个 Endpoint，kind 由地址推断；
   * - legacyToken 非空时建 DEVICE_TOKEN 凭据，scopes 留空。
   */
  migrateLegacy(legacyEndpoint: string | null, legacyToken: string | null): Host | null {
    const rawEndpoint: string = legacyEndpoint === null ? '' : legacyEndpoint.trim();
    if (rawEndpoint.length === 0) {
      return null;
    }
    const baseUrl: string = storeNormalizeBaseUrl(rawEndpoint);
    if (baseUrl.length === 0) {
      return null;
    }

    const now: number = this.clock();
    const hostId: string = this.stableId(HOST_ID_PREFIX, baseUrl);
    const endpointId: string = this.stableId(ENDPOINT_ID_PREFIX, baseUrl);
    const displayName: string = hostNameOf(baseUrl);
    const token: string | null = legacyToken !== null && legacyToken.trim().length > 0 ? legacyToken : null;

    // 复用已有凭据的签发时间，避免迁移重复执行时把 issuedAt 刷新掉。
    const existing: Host | null = this.host(hostId);
    let existingIssuedAt: number | null = null;
    if (existing !== null && existing.credential !== null && existing.credential.issuedAt > 0) {
      existingIssuedAt = existing.credential.issuedAt;
    }

    let credential: Credential | null = null;
    if (token !== null) {
      credential = new Credential(CredentialKind.DEVICE_TOKEN, token, null, null, [],
        existingIssuedAt !== null ? existingIssuedAt : now, null);
    }

    const host: Host = new Host(
      hostId,
      displayName,
      [Endpoint.create(displayName, baseUrl, endpointId)],
      endpointId,
      credential,
      existing !== null ? existing.createdAt : now,
      now,
    );

    const saved: Host[] = this.upsert(host);
    return HostStore.findById(saved, hostId);
  }

  /** 清空本存储拥有的全部键（含损坏数据副本）。 */
  clear(): void {
    this.storage.remove(KEY_HOSTS);
    this.storage.remove(KEY_HOSTS_CORRUPT);
  }

  private quarantineCorrupt(raw: string): void {
    // 任何异常都不能从 loadHosts 里漏出去；副本写失败也不影响返回空列表。
    try {
      if (this.storage.getString(KEY_HOSTS_CORRUPT) !== raw) {
        this.storage.putString(KEY_HOSTS_CORRUPT, raw);
      }
    } catch (e) {
      // 忽略：隔离失败不得影响主流程。
    }
  }

  private stableId(prefix: string, seed: string): string {
    return prefix + this.crypto.sha256Hex(seed).substring(0, 16);
  }

  private static findById(hosts: Host[], id: string): Host | null {
    for (let i = 0; i < hosts.length; i++) {
      if (hosts[i].id === id) {
        return hosts[i];
      }
    }
    return null;
  }
}
