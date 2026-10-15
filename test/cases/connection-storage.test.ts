import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECTION_PREFERENCES_NAME, GCM_IV_LENGTH, HOSTS_KEY_ALIAS, LEGACY_DEVICE_TOKEN_ALIAS,
  LEGACY_ENDPOINT_KEY, LEGACY_TOKEN_CIPHERTEXT_KEY, LEGACY_TOKEN_IV_KEY, LegacyConnectionMigration,
} from '../../entry/src/main/ets/core/ConnectionStorage.ts';
import { CredentialKind } from '../../entry/src/main/ets/core/ConnectionModels.ts';
import { CryptoBridge, HostStore, KeyValueStore, SecretBox } from '../../entry/src/main/ets/core/HostStore.ts';
import { base64Encode, utf8Encode } from '../../entry/src/main/ets/core/Codec.ts';

/**
 * 旧版「单地址 + 单令牌」迁移的测试。
 *
 * 被测的其实是一段**组合逻辑**：旧版把 IV 与密文分开存，新版把 IV 拼在密文头部，
 * 迁移要手工重组。这里用一个假的 GCM 盒子把这层形状差异显式建模出来
 * （[FakeGcmBox.encrypt] 只吐负载、[FakeGcmBox.decrypt] 认 IV 前缀），
 * 这样「拼错了/忘了拼」会立刻被断言抓住，而不是等真机上去试。
 */

class MemoryStore implements KeyValueStore {
  private map: Map<string, string> = new Map();

  getString(key: string): string | null {
    return this.map.has(key) ? this.map.get(key) as string : null;
  }

  putString(key: string, value: string | null): void {
    if (value === null) {
      this.map.delete(key);
    } else {
      this.map.set(key, value);
    }
  }

  remove(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

/** 对称异或盒：供 HostStore 落盘用（encrypt/decrypt 同一变换）。 */
class XorBox implements SecretBox {
  private mask: number = 0x3C;

  encrypt(plain: Uint8Array): Uint8Array {
    const out: Uint8Array = new Uint8Array(plain.length);
    for (let i = 0; i < plain.length; i++) {
      out[i] = plain[i] ^ this.mask;
    }
    return out;
  }

  decrypt(cipher: Uint8Array): Uint8Array {
    return this.encrypt(cipher);
  }
}

/**
 * 假 GCM 盒子：显式建模「IV 前缀 + 负载」的形状。
 * - `encrypt` 只吐负载（对应旧版 `cipher.doFinal(...)` 的输出）；
 * - `decrypt` 跳过头部 12 字节 IV，再解负载（对应新版拼好的密文）。
 */
class FakeGcmBox implements SecretBox {
  private mask: number = 0x5A;

  encrypt(plain: Uint8Array): Uint8Array {
    const out: Uint8Array = new Uint8Array(plain.length);
    for (let i = 0; i < plain.length; i++) {
      out[i] = plain[i] ^ this.mask;
    }
    return out;
  }

  decrypt(cipher: Uint8Array): Uint8Array {
    if (cipher.length <= GCM_IV_LENGTH) {
      throw new Error('ciphertext too short');
    }
    const out: Uint8Array = new Uint8Array(cipher.length - GCM_IV_LENGTH);
    for (let i = GCM_IV_LENGTH; i < cipher.length; i++) {
      out[i - GCM_IV_LENGTH] = cipher[i] ^ this.mask;
    }
    return out;
  }
}

/** 确定性伪摘要：只需稳定，不追求密码学强度（真实实现由平台层注入）。 */
class FakeCrypto implements CryptoBridge {
  sha256Hex(value: string): string {
    let h: number = 2166136261;
    for (let i = 0; i < value.length; i++) {
      h = ((h ^ value.charCodeAt(i)) * 16777619) >>> 0;
    }
    let out: string = '';
    for (let i = 0; i < 8; i++) {
      h = (h * 16777619 + i) >>> 0;
      out += h.toString(16).padStart(8, '0');
    }
    return out;
  }
}

interface Fixture {
  storage: MemoryStore;
  hostStore: HostStore;
  legacyBox: FakeGcmBox;
}

function makeFixture(): Fixture {
  const storage: MemoryStore = new MemoryStore();
  const hostStore: HostStore = new HostStore(storage, new XorBox(), new FakeCrypto(), () => 1000);
  return { storage, hostStore, legacyBox: new FakeGcmBox() };
}

/** 按旧版写法落一套「单地址 + 单令牌」数据。 */
function seedLegacy(fixture: Fixture, endpoint: string, token: string | null, ivSeed: number = 1): void {
  fixture.storage.putString(LEGACY_ENDPOINT_KEY, endpoint);
  if (token === null) {
    return;
  }
  const iv: Uint8Array = new Uint8Array(GCM_IV_LENGTH);
  for (let i = 0; i < GCM_IV_LENGTH; i++) {
    iv[i] = (ivSeed + i) & 0xFF;
  }
  const payload: Uint8Array = fixture.legacyBox.encrypt(utf8Encode(token));
  fixture.storage.putString(LEGACY_TOKEN_IV_KEY, base64Encode(iv, false, true));
  fixture.storage.putString(LEGACY_TOKEN_CIPHERTEXT_KEY, base64Encode(payload, false, true));
}

test('常量：偏好文件名与键名沿用旧版，避免历史数据要跨文件搬运', () => {
  assert.equal(CONNECTION_PREFERENCES_NAME, 'dsh_connection');
  assert.equal(LEGACY_ENDPOINT_KEY, 'endpoint');
  assert.equal(LEGACY_TOKEN_IV_KEY, 'token_iv');
  assert.equal(LEGACY_TOKEN_CIPHERTEXT_KEY, 'token_ciphertext');
  assert.equal(LEGACY_DEVICE_TOKEN_ALIAS, 'deepseek-harness-device-token-v1');
  assert.equal(HOSTS_KEY_ALIAS, 'dsh-companion-hosts-v1');
  assert.equal(GCM_IV_LENGTH, 12);
});

test('无旧数据：返回 null，且不产生任何主机', () => {
  const f = makeFixture();
  const migrated = LegacyConnectionMigration.migrate(f.storage, f.legacyBox, f.hostStore);
  assert.equal(migrated, null);
  assert.deepEqual(f.hostStore.loadHosts(), []);
});

test('旧地址为空白：返回 null', () => {
  const f = makeFixture();
  f.storage.putString(LEGACY_ENDPOINT_KEY, '   ');
  assert.equal(LegacyConnectionMigration.migrate(f.storage, f.legacyBox, f.hostStore), null);
  assert.deepEqual(f.hostStore.loadHosts(), []);
  // 失败路径不清键：留待用户手工处理。
  assert.equal(f.storage.getString(LEGACY_ENDPOINT_KEY), '   ');
});

test('有地址但无 IV/密文：仍建主机，只是没有凭据', () => {
  const f = makeFixture();
  f.storage.putString(LEGACY_ENDPOINT_KEY, '192.168.1.126:3090');
  const migrated = LegacyConnectionMigration.migrate(f.storage, f.legacyBox, f.hostStore);
  assert.notEqual(migrated, null);
  const host = migrated!.host;
  assert.equal(host.credential, null);
  assert.equal(host.displayName, '192.168.1.126');
  assert.equal(host.endpoints.length, 1);
  assert.equal(host.endpoints[0].baseUrl, 'http://192.168.1.126:3090');
  assert.equal(host.preferredEndpointId, host.endpoints[0].id);
  assert.equal(migrated!.deviceName, null);
});

test('完整旧数据：IV 与密文被正确重组，令牌还原成 DEVICE_TOKEN 凭据', () => {
  const f = makeFixture();
  seedLegacy(f, 'http://192.168.1.126:3090', 'tok-abc-123');

  const migrated = LegacyConnectionMigration.migrate(f.storage, f.legacyBox, f.hostStore);
  assert.notEqual(migrated, null);
  const cred = migrated!.host.credential;
  assert.notEqual(cred, null);
  assert.equal(cred!.secret, 'tok-abc-123');
  assert.equal(cred!.kind, CredentialKind.DEVICE_TOKEN);
  assert.deepEqual(cred!.scopes, []);
  assert.equal(migrated!.host.endpoints[0].baseUrl, 'http://192.168.1.126:3090');
});

test('Base64 非法：解密失败不抛异常，令牌退化为空但主机照建', () => {
  const f = makeFixture();
  f.storage.putString(LEGACY_ENDPOINT_KEY, 'http://10.0.0.5:3090');
  f.storage.putString(LEGACY_TOKEN_IV_KEY, '!!!not-base64!!!');
  f.storage.putString(LEGACY_TOKEN_CIPHERTEXT_KEY, '???');

  const migrated = LegacyConnectionMigration.migrate(f.storage, f.legacyBox, f.hostStore);
  assert.notEqual(migrated, null);
  assert.equal(migrated!.host.credential, null);
});

test('成功迁移后清掉三个旧键，避免每次启动重复迁移', () => {
  const f = makeFixture();
  seedLegacy(f, 'http://10.0.0.5:3090', 'tok');

  LegacyConnectionMigration.migrate(f.storage, f.legacyBox, f.hostStore);
  assert.equal(f.storage.getString(LEGACY_ENDPOINT_KEY), null);
  assert.equal(f.storage.getString(LEGACY_TOKEN_IV_KEY), null);
  assert.equal(f.storage.getString(LEGACY_TOKEN_CIPHERTEXT_KEY), null);
});

test('幂等：旧键被清后第二次调用返回 null，主机数量不增加', () => {
  const f = makeFixture();
  seedLegacy(f, 'http://10.0.0.5:3090', 'tok');

  const first = LegacyConnectionMigration.migrate(f.storage, f.legacyBox, f.hostStore);
  const second = LegacyConnectionMigration.migrate(f.storage, f.legacyBox, f.hostStore);
  assert.notEqual(first, null);
  assert.equal(second, null);
  assert.equal(f.hostStore.loadHosts().length, 1);
});

test('重复执行也不会产生重复主机：同一地址派生同一个 host id', () => {
  const f = makeFixture();
  seedLegacy(f, 'http://10.0.0.5:3090', 'tok');
  const first = LegacyConnectionMigration.migrate(f.storage, f.legacyBox, f.hostStore);

  // 再喂一次同样的旧数据（模拟某些设备上旧键没被清干净的极端情况）。
  seedLegacy(f, 'http://10.0.0.5:3090', 'tok');
  const second = LegacyConnectionMigration.migrate(f.storage, f.legacyBox, f.hostStore);

  assert.notEqual(second, null);
  assert.equal(first!.host.id, second!.host.id);
  assert.equal(f.hostStore.loadHosts().length, 1);
  // 迁移不该重置创建时间。
  assert.equal(second!.host.createdAt, first!.host.createdAt);
});

test('地址已带 /api/v1 时按存储口径去掉后缀（不会迁出一台地址带后缀的主机）', () => {
  const f = makeFixture();
  f.storage.putString(LEGACY_ENDPOINT_KEY, 'http://10.0.0.5:3090/api/v1/');
  const migrated = LegacyConnectionMigration.migrate(f.storage, f.legacyBox, f.hostStore);
  assert.notEqual(migrated, null);
  assert.equal(migrated!.host.endpoints[0].baseUrl, 'http://10.0.0.5:3090');
});
