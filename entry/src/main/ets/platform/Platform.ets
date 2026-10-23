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

import { common, ConfigurationConstant } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { deviceInfo } from '@kit.BasicServicesKit';
import { i18n } from '@kit.LocalizationKit';
import { hilog } from '@kit.PerformanceAnalysisKit';
import { CryptoBridge, HostStore, KeyValueStore, SecretBox } from '../core/HostStore';
import { utf8Decode, utf8Encode } from '../core/Codec';
import { AppPreferences, SETTINGS_PREFERENCES_NAME } from '../core/AppPreferences';
import { THEME_MODE_DARK, THEME_MODE_LIGHT } from '../core/ThemeMode';
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

/** 日志域与标签：与 `EntryAbility` 保持一致，便于一次 `hilog` 过滤看全一条链。 */
const DOMAIN: number = 0x0000;
const TAG: string = 'DSH';

/**
 * 上报设备型号的最大长度 —— 与桥的截断口径一致（桥会把 `model` 截到 60 字符）。
 * 客户端先截一次，免得把一个超长的头交给网络层。
 */
const DEVICE_MODEL_MAX: number = 60;

/**
 * 机型名 —— 对位安卓的 `Build.MODEL`。
 *
 * `marketName` 是系统设置里显示的机型（如 `ICL-AL10`），个别设备为空，退到 `productModel`；
 * 两者都空（模拟器 / 异常 ROM）才用 `'HarmonyOS'` 兜底 —— 宁可给一个泛称，
 * 也不让设备身份彻底缺失。
 *
 * 两处消费方（配对时的默认设备名、每个鉴权请求的 `X-Dsh-Device`）共用本函数：
 * 它们是同一件事「这台机器叫什么」，各写一份判空迟早会漂移。
 */
export function deviceModelName(): string {
  const market: string = deviceInfo.marketName;
  if (market.length > 0) {
    return market;
  }
  const product: string = deviceInfo.productModel;
  return product.length > 0 ? product : 'HarmonyOS';
}

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

  /**
   * 设备身份标签 `harmonyos/<model>`（见 `DshClientDeps.deviceTag`）。
   *
   * 控制字符**在这里就清掉**：HTTP 头里混进 CR/LF 会把一条请求劈成两条（头注入）。
   * 桥那边虽然也会清洗，但脏值不该先离开客户端 —— 安全边界要留在自己这一侧。
   * 型号可能含空格（如营销名），桥允许，不做替换。
   */
  deviceTag(): string {
    const model: string = deviceModelName().replace(/[\r\n]+/g, ' ').trim().slice(0, DEVICE_MODEL_MAX);
    return `harmonyos/${model.length > 0 ? model : 'HarmonyOS'}`;
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

/**
 * 把「应用内字号倍数」真正交给平台。
 *
 * ## 为什么勾了「跟随系统」不是简单地把倍数设成 1.0
 *
 * `setFontSizeScale` 设的是**应用自己的**倍数，它会覆盖系统那一档。所以「跟随系统」的正确
 * 实现是把这个值设成**当前系统那一档**（`context.config.fontSizeScale`），而不是 1.0 ——
 * 设 1.0 等于把用户在系统设置里调大的字号**缩回去**，用户看到的是「这个 App 不认我的设置」。
 *
 * ## 失败一律吞掉，只写日志
 *
 * 字号缩放是**锦上添花**的能力：`setFontSizeScale` 是 API 13 起的接口，低版本设备上不存在。
 * 在这里抛出去会随调用栈冒到 `initHarness` / 设置页的点击回调里，把整个界面一起带走 ——
 * 一个可选的显示偏好，绝不能有能力让应用起不来。
 */
export function applyAppFontScale(context: common.Context, scale: number, followsSystem: boolean): void {
  const target: number = followsSystem ? systemFontScale(context) : scale;
  const application: common.ApplicationContext = context.getApplicationContext();
  // 运行时探测：低版本设备上这个方法不存在（编译期有声明 ≠ 真机一定有，见 PORT-MAP 坑 28）。
  // 探到之后必须走**方法调用**去调它 —— 不能写成 `probe.call(application, target)`：
  // ArkTS 的 `arkts-no-func-apply-call` 禁止 `Function.apply` / `Function.call`，
  // 那种写法会直接编译不过（`as object` 取出函数再调用还会丢掉 `this`）。
  if (typeof (application as object)['setFontSizeScale'] !== 'function') {
    return;
  }
  try {
    application.setFontSizeScale(target);
  } catch (e) {
    hilog.warn(DOMAIN, TAG, 'setFontSizeScale failed: %{public}s', JSON.stringify(e));
  }
}

/**
 * 当前系统字号档位；读不到时回落 1.0。
 *
 * `Configuration.fontSizeScale` 在 API 12 起才存在（本工程 compatibleSdkVersion 是 18，
 * 但真机上仍可能读到 `undefined` —— 该字段在 SDK 里本来就叫 `fontSizeScale?: number`），
 * 所以要显式判空，不能直接当数字用。
 *
 * ## 为什么要收窄到 `UIAbilityContext`
 *
 * `config` 只声明在 `UIAbilityContext` 上，基类 `common.Context` **没有**这个属性 ——
 * 不收窄写成 `context.config.fontSizeScale` 会编译不过（`Property 'config' does not exist
 * on type 'Context'`）。收窄是安全的：装配时传进来的本来就是页面宿主上下文，
 * 见 `ui/AppRuntime.ets` 的 `initHarness` 说明与 `appContext` 的类型。
 */
function systemFontScale(context: common.Context): number {
  const uiContext: common.UIAbilityContext = context as common.UIAbilityContext;
  const raw: number | undefined = uiContext.config.fontSizeScale;
  if (raw === undefined || !(raw > 0)) {
    return 1.0;
  }
  return raw;
}

/**
 * 把「主题档位」交给平台：跟随系统 / 强制浅色 / 强制深色。
 *
 * `COLOR_MODE_NOT_SET` 对位「跟随系统」—— 与 `EntryAbility` 启动时写的是同一个值，
 * 两处口径必须一致（那里是「不锁定、跟系统走」，这里只是同一条链上的后一次写入）。
 *
 * 取值**在三处都做了归一化**（`ThemeMode` / 偏好 / 这里）：一个认不出的档位若原样传给
 * `setColorMode`，平台会抛参数错误，而它抛在点击回调里 —— 表现为「点一下就闪退」。
 */
export function applyAppThemeMode(context: common.Context, mode: string): void {
  const application: common.ApplicationContext = context.getApplicationContext();
  let colorMode: ConfigurationConstant.ColorMode = ConfigurationConstant.ColorMode.COLOR_MODE_NOT_SET;
  if (mode === THEME_MODE_LIGHT) {
    colorMode = ConfigurationConstant.ColorMode.COLOR_MODE_LIGHT;
  } else if (mode === THEME_MODE_DARK) {
    colorMode = ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
  }
  try {
    application.setColorMode(colorMode);
  } catch (e) {
    hilog.warn(DOMAIN, TAG, 'setColorMode failed: %{public}s', JSON.stringify(e));
  }
}

