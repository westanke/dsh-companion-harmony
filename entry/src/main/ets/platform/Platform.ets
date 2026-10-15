/**
 * 平台层的总装 —— 把 [HarnessDeps] 需要的十几项能力从系统里取出来，一次性注入 core。
 *
 * 这里是「core 不碰任何 @ohos」这条规矩的另一端：所有平台 API 只在本目录出现，
 * core 只看见接口。想验证装配是否正确，跑 [platformSelfCheckText]（连接页启动时调一次，
 * 结果打在页面上）—— 它把偏好读写与 AES-GCM 往返都真跑一遍，是**在真机上才有效**的冒烟测试。
 *
 * 装配清单（对应 `HarnessViewModel.ts` 的 `HarnessDeps` 字段）：
 *
 * | core 侧 | 平台实现 |
 * |---|---|
 * | `hostStore` | `HostStore` + `PrefsStore('dsh_connection')` + AES-GCM `SecretBox` + SHA-256 |
 * | `preferences` | `AppPreferences` + `PrefsStore('dsh_settings')` |
 * | `coordinator` / `clientFactory` | `ConnectionCoordinator` + 各传输实现 |
 * | `legacyKeyValueStore` / `legacySecretBox` | 同一份连接偏好 + 旧别名密钥（迁移用） |
 * | `now` / `newId` / `languageTag` / `timers` | `Date.now` / UUID / 系统区域 / `setTimeout` |
 */

import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { i18n } from '@kit.LocalizationKit';
import { CryptoBridge, HostStore, KeyValueStore, SecretBox } from '../core/HostStore';
import { utf8Decode, utf8Encode } from '../core/Codec';
import { AppPreferences, SETTINGS_PREFERENCES_NAME } from '../core/AppPreferences';
import {
  CONNECTION_PREFERENCES_NAME, HOSTS_KEY_ALIAS, LEGACY_DEVICE_TOKEN_ALIAS,
} from '../core/ConnectionStorage';
import {
  DEFAULT_LANGUAGE_TAG, DshClient, DshClientDeps, HttpTransport, TimerBridge, WebSocketTransport,
} from '../core/DshClient';
import { ConnectionCoordinator, DshClientFactory, DEFAULT_PROBE_TIMEOUT_MS } from '../core/ConnectionCoordinator';
import { HarnessDeps } from '../core/HarnessViewModel';
import { PrefsStore } from './PrefsStore';
import { SystemTimers } from './Timers';
import { KEYS_PREFERENCES_NAME, Sha256Bridge, makeSecretBox } from './Crypto';
import { OhHttpTransport } from './HttpTransport';
import { OhWebSocketTransport } from './WebSocketTransport';

/** 自检用的一次性密钥别名（跑完即删，不污染真实密钥）。 */
const SELF_CHECK_KEY_ALIAS: string = 'dsh-selfcheck-v1';
/** 自检用的一次性偏好键（跑完即删）。 */
const SELF_CHECK_PREF_KEY: string = 'dsh-selfcheck-probe';
/** 自检专用的偏好文件名 —— **绝不与真实存储共用**（原因见 platformSelfCheckText 第 3 步）。 */
const SELF_CHECK_PREFERENCES_NAME: string = 'dsh_selfcheck';
/** 自检明文，用来验证 AES-GCM 往返。 */
const SELF_CHECK_PLAIN: string = 'DSH 平台自检';

/**
 * 客户端的外部依赖（时区 / 语言 / id / WS / 定时器）。
 *
 * 抽成类而不是对象字面量：`DshClientDeps` 里既有方法签名又有属性，类实现是最不容易
 * 在 ArkTS 严格模式下踩坑的写法。
 */
class PlatformClientDeps implements DshClientDeps {
  socket: WebSocketTransport | null;
  timers: TimerBridge | null;

  constructor(socket: WebSocketTransport, timers: TimerBridge) {
    this.socket = socket;
    this.timers = timers;
  }

  newId(): string {
    return util.generateRandomUUID(true);
  }

  timeZoneId(): string {
    return systemTimeZoneId();
  }

  languageTag(): string {
    return systemLanguageTag();
  }
}

/** 每次建客户端都复用同一套传输实例（HTTP 客户端在每次请求内部新建，见 `HttpTransport.ets`）。 */
class PlatformClientFactory implements DshClientFactory {
  private http: HttpTransport;
  private clientDeps: PlatformClientDeps;

  constructor(http: HttpTransport, socket: WebSocketTransport, timers: TimerBridge) {
    this.http = http;
    this.clientDeps = new PlatformClientDeps(socket, timers);
  }

  create(baseUrl: string, token: string | null): DshClient {
    return new DshClient(baseUrl, token, this.http, this.clientDeps);
  }
}

/** 一次性装配全部平台依赖。**同一个 context 下应只调用一次**（HTTP/WS 实例在里面）。 */
export function createHarnessDeps(context: common.Context): HarnessDeps {
  const connectionStore: KeyValueStore = new PrefsStore(context, CONNECTION_PREFERENCES_NAME);
  const settingsStore: KeyValueStore = new PrefsStore(context, SETTINGS_PREFERENCES_NAME);
  const keysStore: KeyValueStore = new PrefsStore(context, KEYS_PREFERENCES_NAME);

  const crypto: CryptoBridge = new Sha256Bridge();
  const secretBox: SecretBox = makeSecretBox(keysStore, HOSTS_KEY_ALIAS);
  const legacySecretBox: SecretBox = makeSecretBox(keysStore, LEGACY_DEVICE_TOKEN_ALIAS);
  const hostStore: HostStore = new HostStore(connectionStore, secretBox, crypto, (): number => Date.now());
  const preferences: AppPreferences = new AppPreferences(settingsStore);

  const timers: TimerBridge = new SystemTimers();
  const http: HttpTransport = new OhHttpTransport();
  const socket: WebSocketTransport = new OhWebSocketTransport();
  const clientFactory: DshClientFactory = new PlatformClientFactory(http, socket, timers);
  const coordinator: ConnectionCoordinator =
    new ConnectionCoordinator(clientFactory, DEFAULT_PROBE_TIMEOUT_MS, timers, (): number => Date.now());

  const deps: HarnessDeps = {
    hostStore: hostStore,
    preferences: preferences,
    coordinator: coordinator,
    clientFactory: clientFactory,
    legacyKeyValueStore: connectionStore,
    legacySecretBox: legacySecretBox,
    now: (): number => Date.now(),
    newId: (): string => util.generateRandomUUID(true),
    languageTag: (): string => systemLanguageTag(),
    timers: timers,
  };
  return deps;
}

/**
 * 真机冒烟自检：跑一遍偏好读写 + AES-GCM 往返，返回一行能直接显示的中文结论。
 *
 * 为什么值得存在：平台层是唯一无法离线单测的一层（core 有 427 个用例，这里一个都没有），
 * 「编过了」不等于「跑起来正常」—— 密钥生成、GCM 装填、preferences 同步 API 都只有
 * 真机才能证伪。把结论打在连接页上，用户截图即现场。
 */
export function platformSelfCheckText(context: common.Context): string {
  const parts: string[] = [];

  // 1. 偏好读写（走的是 @ohos.data.preferences 同步族）。
  try {
    const store: KeyValueStore = new PrefsStore(context, CONNECTION_PREFERENCES_NAME);
    store.putString(SELF_CHECK_PREF_KEY, SELF_CHECK_PLAIN);
    const back: string | null = store.getString(SELF_CHECK_PREF_KEY);
    store.remove(SELF_CHECK_PREF_KEY);
    parts.push(back === SELF_CHECK_PLAIN ? 'prefs:ok' : 'prefs:mis');
  } catch (e) {
    parts.push('prefs:fail');
  }

  // 2. AES-GCM 往返（真生成密钥、真加密、真解密）。
  try {
    const keysStore: KeyValueStore = new PrefsStore(context, KEYS_PREFERENCES_NAME);
    const box: SecretBox = makeSecretBox(keysStore, SELF_CHECK_KEY_ALIAS);
    const back: string = utf8Decode(box.decrypt(box.encrypt(utf8Encode(SELF_CHECK_PLAIN))));
    parts.push(back === SELF_CHECK_PLAIN ? 'aesgcm:ok' : 'aesgcm:mis');
    keysStore.remove(SELF_CHECK_KEY_ALIAS);
  } catch (e) {
    parts.push('aesgcm:fail');
  }

  // 3. 主机库往返（整份列表 → 加密 → Base64 → 解密）。
  // **必须用独立的偏好文件，绝不碰真实的 dsh_connection**：HostStore 的往返验证会写
  // KEY_HOSTS（`hosts_v1`）—— 早期版本在这里直接对真实存储 `saveHosts([])`，
  // 后果是「进一次设置页 = 已保存的电脑被整个清空」（真机踩坑，见 PORT-MAP 坑 15）：
  // 配对成功写入的主机在下一次进设置页时被覆盖成空列表，重启后 restoreConnection
  // 读到空，用户看到的就是「设备端已保存的电脑为空、连接不持久」。
  try {
    const selfStore: KeyValueStore = new PrefsStore(context, SELF_CHECK_PREFERENCES_NAME);
    const box: SecretBox = makeSecretBox(selfStore, SELF_CHECK_KEY_ALIAS);
    const probe: HostStore = new HostStore(selfStore, box, new Sha256Bridge(), (): number => Date.now());
    probe.saveHosts([]);
    const loaded: number = probe.loadHosts().length;
    parts.push(`hosts:${loaded}`);
    // busySendMode 只在独立存储上读默认值，与用户真实设置互不相干。
    const probePrefs: AppPreferences = new AppPreferences(selfStore);
    parts.push(`send:${probePrefs.busySendMode}`);
    parts.push(`lang:${systemLanguageTag()}`);
    parts.push(`tz:${systemTimeZoneId()}`);
    // 跑完清掉整个自检文件：不留残留，也不给下一次自检留下旧密文。
    selfStore.clear();
  } catch (e) {
    parts.push('hosts:fail');
  }

  return `平台层自检 · ${parts.join(' · ')}`;
}

/** 系统区域（BCP-47，如 `zh-CN`）；拿不到就按中文兜底（与 core 的 `DEFAULT_LANGUAGE_TAG` 一致）。 */
export function systemLanguageTag(): string {
  try {
    const locale: string = i18n.System.getSystemLocale();
    if (locale.length > 0) {
      return locale;
    }
  } catch (e) {
    // 落到兜底。
  }
  return DEFAULT_LANGUAGE_TAG;
}

/** 系统时区 id（如 `Asia/Shanghai`）—— 服务端要用它渲染时间戳。 */
export function systemTimeZoneId(): string {
  try {
    const id: string = i18n.getTimeZone().getID();
    if (id.length > 0) {
      return id;
    }
  } catch (e) {
    // 落到兜底。
  }
  return 'UTC';
}
