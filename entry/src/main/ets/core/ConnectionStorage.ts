/**
 * 连接持久化的「落盘约定」与旧版数据迁移 —— 移植自原工程
 * `data/SecureConnectionStore.kt` 与 `data/AndroidConnectionStorage.kt`。
 *
 * ## 哪些留在了 platform、哪些搬进了 core
 *
 * 原文件里其实是三种东西混在一起，本移植按「能不能脱离系统跑」拆开：
 *
 * 1. `SharedPreferencesKeyValueStore` —— 只是把 `KeyValueStore` 落到偏好上，
 *    鸿蒙侧的平台层会直接实现 `KeyValueStore`（`@ohos.data.preferences`），
 *    所以 core 里**不需要**这个类，只有它的偏好文件名要保下来（见
 *    [CONNECTION_PREFERENCES_NAME]，沿用旧名以免旧数据要跨文件搬运）。
 * 2. `KeystoreSecretBox` —— Android Keystore 的 AES-GCM，纯平台能力。鸿蒙侧换成
 *    HUKS（或 Asset Store）实现 `SecretBox`，core 里只保留别名与 IV 长度这类**格式约定**。
 * 3. `LegacyConnectionMigration` —— 纯编排逻辑：读键、拼 IV、解密、交给 HostStore，
 *    全程只依赖注入进来的 `KeyValueStore` / `SecretBox` / `HostStore`。**这部分搬进 core**。
 *
 * ## `SecureConnectionStore` 为什么不搬
 *
 * 那个类是「单地址 + 单令牌」时代的产物，在原工程里已经**没有任何调用点**（grep 全仓库
 * 只有定义处）。它的历史数据由 [LegacyConnectionMigration] 负责读取，所以这里只保留
 * 它写过的三个偏好键名，不重建这个类。
 */

import { isNotBlank } from './TextPredicates';
import { base64DecodeStrict, utf8Decode } from './Codec';
import { Host } from './ConnectionModels';
import { HostStore, KeyValueStore, SecretBox } from './HostStore';

/** 偏好文件名，沿用旧版（与 HarnessViewModel 里的 `keyValueStore` 同一个文件）。 */
export const CONNECTION_PREFERENCES_NAME: string = 'dsh_connection';

/** 新版：加密整份 Host 列表所用的密钥别名。 */
export const HOSTS_KEY_ALIAS: string = 'dsh-companion-hosts-v1';

/** 旧版：单连接时代用来加密设备令牌，仅为迁移而保留。 */
export const LEGACY_DEVICE_TOKEN_ALIAS: string = 'deepseek-harness-device-token-v1';

/** 旧版存放地址明文的偏好键。 */
export const LEGACY_ENDPOINT_KEY: string = 'endpoint';

/** 旧版存放 GCM IV 的偏好键。 */
export const LEGACY_TOKEN_IV_KEY: string = 'token_iv';

/** 旧版存放密文的偏好键。 */
export const LEGACY_TOKEN_CIPHERTEXT_KEY: string = 'token_ciphertext';

/** GCM 的 IV 长度（字节）。迁移时要手工把 IV 拼回密文头部，所以这个数得钉住。 */
export const GCM_IV_LENGTH: number = 12;

/** 迁移结果：新建的主机（deviceName 目前恒为 null，保留字段是为了与上游签名一致）。 */
export class MigratedConnection {
  readonly host: Host;
  readonly deviceName: string | null;

  constructor(host: Host, deviceName: string | null) {
    this.host = host;
    this.deviceName = deviceName;
  }
}

/**
 * 一次性把旧版「单地址 + 单令牌」迁移成新版的一台 [Host]。
 *
 * 旧版把 IV 与密文分开存（`token_iv` / `token_ciphertext`），新版把 IV 拼在密文头部，
 * 所以这里要手工重组后再解密。
 *
 * **幂等**：只有在旧键仍然存在、且解密链走通时才会动作；成功后旧键被清掉，
 * 因此重复调用第二次就会因「旧键已无」而返回 null。
 *
 * **绝不抛异常**：任何一步失败（Base64 非法、解密失败、HostStore 拒绝）都只返回 null，
 * 让调用方继续走「未连接」流程 —— 迁移失败不该让 App 起不来，用户仍可手工添加地址。
 *
 * 注：上游的 `migrate` 还带一个 `idFactory` 参数，但它从未被使用（HostStore
 * 用地址的摘要派生 id，与 idFactory 无关），移植时直接丢掉，不留死参数。
 */
export class LegacyConnectionMigration {
  static migrate(
    storage: KeyValueStore,
    legacySecretBox: SecretBox,
    hostStore: HostStore,
  ): MigratedConnection | null {
    const endpointValue: string | null = storage.getString(LEGACY_ENDPOINT_KEY);
    if (endpointValue === null || !isNotBlank(endpointValue)) {
      return null;
    }

    const iv: Uint8Array | null = LegacyConnectionMigration.decodeBase64(storage.getString(LEGACY_TOKEN_IV_KEY));
    const cipherText: Uint8Array | null =
      LegacyConnectionMigration.decodeBase64(storage.getString(LEGACY_TOKEN_CIPHERTEXT_KEY));

    let token: string | null = null;
    if (iv !== null && cipherText !== null) {
      try {
        token = utf8Decode(legacySecretBox.decrypt(
          LegacyConnectionMigration.concat(iv, cipherText)));
      } catch (e) {
        token = null;
      }
    }

    let host: Host | null = null;
    try {
      host = hostStore.migrateLegacy(endpointValue, token);
    } catch (e) {
      host = null;
    }
    if (host === null) {
      return null;
    }

    // 迁移成功后清掉旧键：既避免每次启动重复迁移，也避免旧密文长期滞留在偏好里。
    storage.remove(LEGACY_TOKEN_IV_KEY);
    storage.remove(LEGACY_TOKEN_CIPHERTEXT_KEY);
    // 旧版把地址明文存在 endpoint 键；新库已持有该地址，这里一并清理。
    storage.remove(LEGACY_ENDPOINT_KEY);

    return new MigratedConnection(host, null);
  }

  /** 对应 `android.util.Base64.decode(value, NO_WRAP)`：标准字母表，不认就返回 null。 */
  private static decodeBase64(value: string | null): Uint8Array | null {
    if (value === null) {
      return null;
    }
    return base64DecodeStrict(value, false);
  }

  private static concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out: Uint8Array = new Uint8Array(a.length + b.length);
    for (let i = 0; i < a.length; i++) {
      out[i] = a[i];
    }
    for (let i = 0; i < b.length; i++) {
      out[a.length + i] = b[i];
    }
    return out;
  }
}
