import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  HostStore, KEY_HOSTS, KEY_HOSTS_CORRUPT,
  type KeyValueStore, type SecretBox, type CryptoBridge,
} from '../../entry/src/main/ets/core/HostStore.ts';
import {
  Host, Endpoint, Credential, CredentialKind, EndpointKind,
} from '../../entry/src/main/ets/core/ConnectionModels.ts';

/** 内存键值存储：替代 SharedPreferences，让本模块不需要真机。 */
class MemoryStore implements KeyValueStore {
  private map = new Map<string, string>();

  getString(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
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

/** XOR 可逆变换：证明确实走了加解密路径，且不碰系统密钥库。 */
class XorSecretBox implements SecretBox {
  encrypt(plain: Uint8Array): Uint8Array {
    const out = new Uint8Array(plain.length);
    for (let i = 0; i < plain.length; i++) {
      out[i] = plain[i] ^ 0x5A;
    }
    return out;
  }

  decrypt(cipher: Uint8Array): Uint8Array {
    return this.encrypt(cipher);
  }
}

const nodeCrypto: CryptoBridge = {
  sha256Hex(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  },
};

function makeStore(now = (): number => 1_000) {
  const storage = new MemoryStore();
  const store = new HostStore(storage, new XorSecretBox(), nodeCrypto, now);
  return { storage, store };
}

function sampleHost(id = 'h1'): Host {
  return new Host(
    id,
    '家里的电脑',
    [Endpoint.create('家里局域网', 'http://192.168.1.126:3090', 'e1')],
    'e1',
    new Credential(CredentialKind.DEVICE_TOKEN, 'secret-token-123', 'dev-1', 'Pixel 9', ['files.read'], 500, null),
    0,
    0,
  );
}

test('HostStore：保存后能原样读回，且落盘是密文', () => {
  const { storage, store } = makeStore();
  store.saveHosts([sampleHost()]);

  const loaded = store.loadHosts();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, 'h1');
  assert.equal(loaded[0].displayName, '家里的电脑');
  assert.equal(loaded[0].endpoints.length, 1);
  assert.equal(loaded[0].endpoints[0].baseUrl, 'http://192.168.1.126:3090');
  assert.equal(loaded[0].endpoints[0].kind, EndpointKind.LAN);
  assert.equal(loaded[0].credential?.secret, 'secret-token-123');
  assert.deepEqual(loaded[0].credential?.scopes, ['files.read']);

  const raw = storage.getString(KEY_HOSTS) as string;
  assert.ok(raw.length > 0);
  assert.equal(raw.includes('secret-token-123'), false, '明文凭据绝不能落盘');
  assert.equal(raw.includes('家里'), false, '明文 JSON 绝不能落盘');
});

test('HostStore：空存储与空白值都返回空列表', () => {
  const { storage, store } = makeStore();
  assert.deepEqual(store.loadHosts(), []);
  storage.putString(KEY_HOSTS, '   ');
  assert.deepEqual(store.loadHosts(), []);
});

test('HostStore：坏数据返回空列表、不抛异常，并保留原值 + 隔离副本', () => {
  const { storage, store } = makeStore();
  storage.putString(KEY_HOSTS, '这不是 base64！！！');
  assert.deepEqual(store.loadHosts(), []);
  assert.equal(storage.getString(KEY_HOSTS), '这不是 base64！！！', '原值不得被静默清空');
  assert.equal(storage.getString(KEY_HOSTS_CORRUPT), '这不是 base64！！！');

  // 密文合法但 JSON 损坏（用同一种 XOR + 手写 Base64）也应被隔离。
  const { storage: s2, store: store2 } = makeStore();
  const brokenPlain = '{"not":"an array"}';
  const bytes = new Uint8Array(Buffer.from(brokenPlain, 'utf8').map((b) => b ^ 0x5A));
  s2.putString(KEY_HOSTS, Buffer.from(bytes).toString('base64'));
  assert.deepEqual(store2.loadHosts(), []);
  assert.ok(s2.getString(KEY_HOSTS_CORRUPT) !== null);
});

test('HostStore：upsert 新增时补 createdAt，更新时保留原 createdAt 并刷新 updatedAt', () => {
  let now = 1_000;
  const { store } = makeStore(() => now);
  store.upsert(sampleHost('h1'));
  const first = store.host('h1') as Host;
  assert.equal(first.createdAt, 1_000);
  assert.equal(first.updatedAt, 1_000);

  now = 5_000;
  const edited = sampleHost('h1');
  edited.displayName = '改过的名字';
  edited.createdAt = 7_777; // 故意传入，应被忽略
  store.upsert(edited);
  const second = store.host('h1') as Host;
  assert.equal(store.loadHosts().length, 1, '同 id 不得产生重复主机');
  assert.equal(second.createdAt, 1_000, '创建时间不该被编辑重置');
  assert.equal(second.updatedAt, 5_000);
  assert.equal(second.displayName, '改过的名字');
});

test('HostStore：remove 与 host 的行为', () => {
  const { store } = makeStore();
  store.upsert(sampleHost('h1'));
  store.upsert(sampleHost('h2'));
  assert.equal(store.loadHosts().length, 2);

  const left = store.remove('h1');
  assert.deepEqual(left.map((h) => h.id), ['h2']);
  store.remove('不存在的 id');
  assert.equal(store.loadHosts().length, 1);
  assert.equal(store.host('nope'), null);
});

test('HostStore：markPreferred 只改偏好，不动 updatedAt', () => {
  let now = 1_000;
  const { store } = makeStore(() => now);
  const host = sampleHost('h1');
  host.preferredEndpointId = null;
  store.upsert(host);

  now = 9_999;
  store.markPreferred('h1', 'e9');
  const after = store.host('h1') as Host;
  assert.equal(after.preferredEndpointId, 'e9');
  assert.equal(after.updatedAt, 1_000, '记偏好不该刷新 updatedAt');

  store.markPreferred('不存在的 id', 'e9');
  assert.equal((store.host('h1') as Host).preferredEndpointId, 'e9');
});

test('HostStore：migrateLegacy 空地址返回 null 且不写任何东西', () => {
  const { storage, store } = makeStore();
  assert.equal(store.migrateLegacy(null, 'tok'), null);
  assert.equal(store.migrateLegacy('   ', 'tok'), null);
  assert.equal(storage.getString(KEY_HOSTS), null);
});

test('HostStore：migrateLegacy 派生稳定 id、取主机名、建凭据，且幂等', () => {
  let now = 1_000;
  const { store } = makeStore(() => now);
  const first = store.migrateLegacy('192.168.1.126:3090', 'legacy-token') as Host;
  assert.ok(first !== null);
  assert.ok(first.id.startsWith('legacy-'));
  assert.equal(first.displayName, '192.168.1.126');
  assert.equal(first.endpoints.length, 1);
  assert.equal(first.endpoints[0].baseUrl, 'http://192.168.1.126:3090');
  assert.equal(first.endpoints[0].kind, EndpointKind.LAN);
  assert.equal(first.preferredEndpointId, first.endpoints[0].id);
  assert.equal(first.credential?.secret, 'legacy-token');
  assert.equal(first.credential?.kind, CredentialKind.DEVICE_TOKEN);
  assert.equal(first.credential?.issuedAt, 1_000);

  now = 8_000;
  const again = store.migrateLegacy('http://192.168.1.126:3090/', 'legacy-token') as Host;
  assert.equal(store.loadHosts().length, 1, '幂等：重复迁移不得产生第二台主机');
  assert.equal(again.id, first.id);
  assert.equal(again.createdAt, 1_000);
  assert.equal(again.credential?.issuedAt, 1_000, '复用已有凭据签发时间');
  assert.equal(again.updatedAt, 8_000);
});

test('HostStore：clear 清掉主键与损坏副本', () => {
  const { storage, store } = makeStore();
  store.saveHosts([sampleHost()]);
  storage.putString(KEY_HOSTS_CORRUPT, 'x');
  store.clear();
  assert.equal(storage.getString(KEY_HOSTS), null);
  assert.equal(storage.getString(KEY_HOSTS_CORRUPT), null);
});
