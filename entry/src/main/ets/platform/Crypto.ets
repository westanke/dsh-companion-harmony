/**
 * 平台密码学实现 —— SHA-256 摘要与 AES-256-GCM 加解密，落在
 * `@ohos.security.cryptoFramework`（`@kit.CryptoArchitectureKit`）上。
 *
 * ## 为什么能同步实现
 *
 * core 的 `CryptoBridge.sha256Hex` 与 `SecretBox.encrypt/decrypt` 都是**同步契约**
 * （见 `HostStore.ts`）。cryptoFramework 的默认 API 是 Promise 风格，但自 API 12 起
 * 提供了同步族：`Md.updateSync/digestSync`、`SymKeyGenerator.convertKeySync`、
 * `Cipher.initSync/updateSync/doFinalSync`、`Random.generateRandomSync`。
 * **已实测本工程 SDK（API 18）里这些方法都存在**，所以不必改 core，也不必把
 * preferences 的读写全改成异步。
 *
 * ## 密钥管理（**已知的、有意的降级，见 docs/PORT-MAP.md**）
 *
 * 安卓用 Android Keystore（硬件背书、密钥不可导出）。鸿蒙侧更等价的做法是 HUKS，
 * 但 HUKS 只有异步 API（`generateKeyItem` / `initSession` / `finishSession`），
 * 与上面的同步契约冲突。**当前实现**：首次使用时用 `Random.generateRandomSync` 生成
 * 32 字节 AES-256 密钥，Base64 后存进**独立的偏好文件 `dsh_keys`**，之后全程在内存里用。
 *
 * 这意味着「拿到应用沙箱读权限就能解出密钥」，安全性弱于 Keystore。升级路径只有一步：
 * 把 [loadOrCreateKeyBytes] 换成「HUKS 生成 + 启动时 `exportKeyItem` 导出到内存」，
 * 其余代码（`AesGcmSecretBox`）不动。之所以先这么做：HUKS 的导出能力受密钥可导出
 * 标志影响，属于要在真机上验证的点，而当前阶段的目标是**先把核心链路跑通**。
 *
 * ## 密文格式（与 `ConnectionStorage.ts` 的约定对齐）
 *
 * `IV(12) || GCM 密文(含 16 字节 authTag)` —— GCM 的 IV 不复用是硬要求，所以每次加密
 * 都新取一个随机 IV 并前置；解密时前 12 字节即 IV。
 */

import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { CryptoBridge, KeyValueStore, SecretBox } from '../core/HostStore';
import { base64DecodeStrict, base64Encode, utf8Encode } from '../core/Codec';

/** 密钥单独落一个偏好文件，避免与密文同处一份（纵深防御的一小步）。 */
export const KEYS_PREFERENCES_NAME: string = 'dsh_keys';

/** AES-256 密钥长度（字节）。 */
const KEY_LENGTH: number = 32;
/** GCM 推荐 IV 长度（字节）。 */
const IV_LENGTH: number = 12;
/** GCM authTag 长度（字节）。 */
const GCM_TAG_LENGTH: number = 16;
/** 变换串：AES-256 + GCM + 无填充（GCM 自带完整性校验，不需要 PKCS7）。 */
const AES_GCM_TRANSFORMATION: string = 'AES256|GCM|NoPadding';
/** 摘要算法名。 */
const DIGEST_ALG: string = 'SHA256';

/** SHA-256 → 小写十六进制。`HostStore.stableId` 取前 16 位当主机/地址 id，故必须是稳定输出。 */
export class Sha256Bridge implements CryptoBridge {
  sha256Hex(value: string): string {
    const md: cryptoFramework.Md = cryptoFramework.createMd(DIGEST_ALG);
    const input: cryptoFramework.DataBlob = { data: utf8Encode(value) };
    md.updateSync(input);
    const digest: cryptoFramework.DataBlob = md.digestSync();
    return toHex(digest.data);
  }
}

/** AES-256-GCM 的 `SecretBox` 实现；密钥在构造时确定，之后加解密全同步。 */
export class AesGcmSecretBox implements SecretBox {
  private key: cryptoFramework.SymKey;

  constructor(keyBytes: Uint8Array) {
    const generator: cryptoFramework.SymKeyGenerator = cryptoFramework.createSymKeyGenerator('AES256');
    const keyBlob: cryptoFramework.DataBlob = { data: keyBytes };
    this.key = generator.convertKeySync(keyBlob);
  }

  encrypt(plain: Uint8Array): Uint8Array {
    const iv: Uint8Array = cryptoFramework.createRandom().generateRandomSync(IV_LENGTH).data;
    // 加密方向 authTag 传空（由 doFinalSync 生成并拼在输出尾部）。
    const spec: cryptoFramework.GcmParamsSpec = makeGcmSpec(iv, new Uint8Array(0), new Uint8Array(0));
    const cipher: cryptoFramework.Cipher = cryptoFramework.createCipher(AES_GCM_TRANSFORMATION);
    cipher.initSync(cryptoFramework.CryptoMode.ENCRYPT_MODE, this.key, spec);
    // GCM 的 doFinalSync 输出是「密文 || 16 字节 authTag」，正好整段前置 IV 即可落盘。
    const sealed: Uint8Array = cipher.doFinalSync({ data: plain }).data;
    return concat(iv, sealed);
  }

  decrypt(cipherBytes: Uint8Array): Uint8Array {
    if (cipherBytes.length < IV_LENGTH + GCM_TAG_LENGTH) {
      // 前缀都不够长，连 IV 与 tag 都放不下 —— 当坏数据处理（HostStore 会容错成空列表）。
      throw new Error('密文长度不足，无法取出 IV 与认证标签');
    }
    const iv: Uint8Array = cipherBytes.slice(0, IV_LENGTH);
    const sealed: Uint8Array = cipherBytes.slice(IV_LENGTH);
    // GCM 解密的 authTag **必须显式传入** GcmParamsSpec（见 makeGcmSpec 注释）：
    // 真机实测传空会在 initSync 直接报 401 "failed to cipher init"（见 PORT-MAP 坑 16）。
    // 加密时 doFinalSync 输出「密文 || 16 字节 tag」，这里按同一格式把尾部 16 字节切出来，
    // doFinal 只吃密文本体。
    const tag: Uint8Array = sealed.slice(sealed.length - GCM_TAG_LENGTH);
    const body: Uint8Array = sealed.slice(0, sealed.length - GCM_TAG_LENGTH);
    const spec: cryptoFramework.GcmParamsSpec = makeGcmSpec(iv, new Uint8Array(0), tag);
    const cipher: cryptoFramework.Cipher = cryptoFramework.createCipher(AES_GCM_TRANSFORMATION);
    cipher.initSync(cryptoFramework.CryptoMode.DECRYPT_MODE, this.key, spec);
    return cipher.doFinalSync({ data: body }).data;
  }
}

/** GCM 参数。本工程不使用 AAD；`tag` 在**加密**方向传空（由 doFinal 生成输出），
 *  在**解密**方向必须传入从密文尾部切出的 16 字节 —— 传空在 initSync 就报 401。 */
function makeGcmSpec(iv: Uint8Array, aad: Uint8Array, tag: Uint8Array): cryptoFramework.GcmParamsSpec {
  const ivBlob: cryptoFramework.DataBlob = { data: iv };
  const aadBlob: cryptoFramework.DataBlob = { data: aad };
  const tagBlob: cryptoFramework.DataBlob = { data: tag };
  const spec: cryptoFramework.GcmParamsSpec = {
    algName: 'GcmParamsSpec',
    iv: ivBlob,
    aad: aadBlob,
    authTag: tagBlob,
  };
  return spec;
}

/**
 * 取别名对应的密钥：已存在则解密用；不存在则生成 32 字节随机密钥并落盘。
 *
 * 落盘用的偏好库由调用方注入（生产是 `dsh_keys` 这份独立文件）。读到坏数据
 * （Base64 非法 / 长度不对）时**当作没有**，重新生成 —— 与 `HostStore` 的容错口径一致：
 * 偏好损坏不该让 App 起不来（代价是那批旧密文解不开，`HostStore` 会把原文隔离到
 * `hosts_v1_corrupt`，用户重连一次即可）。
 */
export function loadOrCreateKeyBytes(store: KeyValueStore, alias: string): Uint8Array {
  const stored: string | null = store.getString(alias);
  if (stored !== null) {
    const decoded: Uint8Array | null = base64DecodeStrict(stored, false);
    if (decoded !== null && decoded.length === KEY_LENGTH) {
      return decoded;
    }
  }
  const fresh: Uint8Array = cryptoFramework.createRandom().generateRandomSync(KEY_LENGTH).data;
  store.putString(alias, base64Encode(fresh, false, true));
  return fresh;
}

/** 便捷构造：从偏好里取（或建）同名密钥，包一个 `SecretBox`。 */
export function makeSecretBox(store: KeyValueStore, alias: string): SecretBox {
  return new AesGcmSecretBox(loadOrCreateKeyBytes(store, alias));
}

/** 字节数组 → 小写十六进制（`0` 补齐两位）。 */
function toHex(bytes: Uint8Array): string {
  let out: string = '';
  for (let i = 0; i < bytes.length; i++) {
    const b: number = bytes[i];
    out += (b < 16 ? '0' : '') + b.toString(16);
  }
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out: Uint8Array = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
