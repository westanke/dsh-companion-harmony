/**
 * 线上模型 —— **配置域**：权限选择、模型选择、供应商设置（含自定义供应商）、插件清单。
 *
 * 面向服务端线上模型的**三条规矩**（字段一律给默认值 / 请求体省略 null / 判别联合按 type 分派）
 * 写在 `Models.ts` 的文件头 —— 那是本模块的索引。拆分的来龙去脉也见那里。
 */

import { JsonAccess, JsonMap } from './JsonAccess';
import { WireBuilder, JsonMapArray } from './ModelsWire';

// ---------------------------------------------------------------------------
// 权限选择
// ---------------------------------------------------------------------------

export class PermissionOption {
  value: string = '';
  name: string = '';
  description: string | null = null;

  constructor(value: string = '', name: string = '', description: string | null = null) {
    this.value = value;
    this.name = name;
    this.description = description;
  }

  static fromJson(map: JsonMap | null): PermissionOption {
    const v: PermissionOption = new PermissionOption();
    v.value = JsonAccess.str(map, 'value') ?? '';
    v.name = JsonAccess.str(map, 'name') ?? '';
    v.description = JsonAccess.str(map, 'description');
    return v;
  }
}

export class PermissionSelect {
  options: PermissionOption[] = [];
  currentValue: string = '';

  constructor(options: PermissionOption[] = [], currentValue: string = '') {
    this.options = options;
    this.currentValue = currentValue;
  }

  static fromJson(map: JsonMap | null): PermissionSelect {
    const v: PermissionSelect = new PermissionSelect();
    const raw: JsonMap[] = JsonAccess.objArr(map, 'options');
    for (let i = 0; i < raw.length; i++) {
      v.options.push(PermissionOption.fromJson(raw[i]));
    }
    v.currentValue = JsonAccess.str(map, 'currentValue') ?? '';
    return v;
  }
}

// ---------------------------------------------------------------------------
// 模型选择
// ---------------------------------------------------------------------------

export class ModelSelection {
  provider: string = '';
  model: string = '';
  reasoningEffort: string | null = null;

  constructor(provider: string = '', model: string = '', reasoningEffort: string | null = null) {
    this.provider = provider;
    this.model = model;
    this.reasoningEffort = reasoningEffort;
  }

  toJsonString(): string {
    return new WireBuilder()
      .put('provider', this.provider)
      .put('model', this.model)
      .put('reasoningEffort', this.reasoningEffort)
      .build();
  }

  static fromJson(map: JsonMap | null): ModelSelection {
    return new ModelSelection(
      JsonAccess.str(map, 'provider') ?? '',
      JsonAccess.str(map, 'model') ?? '',
      JsonAccess.str(map, 'reasoningEffort'),
    );
  }
}

export class ModelReasoningEffort {
  id: string = '';
  name: string = '';
  description: string | null = null;

  static fromJson(map: JsonMap | null): ModelReasoningEffort {
    const v: ModelReasoningEffort = new ModelReasoningEffort();
    v.id = JsonAccess.str(map, 'id') ?? '';
    v.name = JsonAccess.str(map, 'name') ?? '';
    v.description = JsonAccess.str(map, 'description');
    return v;
  }
}

export class ModelReasoning {
  efforts: ModelReasoningEffort[] = [];
  defaultEffort: string | null = null;

  static fromJson(map: JsonMap | null): ModelReasoning {
    const v: ModelReasoning = new ModelReasoning();
    const raw: JsonMap[] = JsonAccess.objArr(map, 'efforts');
    for (let i = 0; i < raw.length; i++) {
      v.efforts.push(ModelReasoningEffort.fromJson(raw[i]));
    }
    v.defaultEffort = JsonAccess.str(map, 'defaultEffort');
    return v;
  }
}

export class ModelView {
  id: string = '';
  name: string = '';
  description: string | null = null;
  contextWindow: number | null = null;
  maxTokens: number | null = null;
  reasoning: ModelReasoning | null = null;

  static fromJson(map: JsonMap | null): ModelView {
    const v: ModelView = new ModelView();
    v.id = JsonAccess.str(map, 'id') ?? '';
    v.name = JsonAccess.str(map, 'name') ?? '';
    v.description = JsonAccess.str(map, 'description');
    v.contextWindow = JsonAccess.num(map, 'contextWindow');
    v.maxTokens = JsonAccess.num(map, 'maxTokens');
    const reasoning: JsonMap | null = JsonAccess.obj(map, 'reasoning');
    v.reasoning = reasoning === null ? null : ModelReasoning.fromJson(reasoning);
    return v;
  }
}

export class ModelProviderGroup {
  id: string = '';
  name: string = '';
  models: ModelView[] = [];

  static fromJson(map: JsonMap | null): ModelProviderGroup {
    const v: ModelProviderGroup = new ModelProviderGroup();
    v.id = JsonAccess.str(map, 'id') ?? '';
    v.name = JsonAccess.str(map, 'name') ?? '';
    const raw: JsonMap[] = JsonAccess.objArr(map, 'models');
    for (let i = 0; i < raw.length; i++) {
      v.models.push(ModelView.fromJson(raw[i]));
    }
    return v;
  }
}

export class ModelFailure {
  provider: string = '';
  message: string = '';

  static fromJson(map: JsonMap | null): ModelFailure {
    const v: ModelFailure = new ModelFailure();
    v.provider = JsonAccess.str(map, 'provider') ?? '';
    v.message = JsonAccess.str(map, 'message') ?? '';
    return v;
  }
}

export class SessionModels {
  current: ModelSelection = new ModelSelection();
  routable: boolean = false;
  groups: ModelProviderGroup[] = [];
  failures: ModelFailure[] = [];

  static fromJson(map: JsonMap | null): SessionModels {
    const v: SessionModels = new SessionModels();
    v.current = ModelSelection.fromJson(JsonAccess.obj(map, 'current'));
    v.routable = JsonAccess.bool(map, 'routable') ?? false;
    const rawGroups: JsonMap[] = JsonAccess.objArr(map, 'groups');
    for (let i = 0; i < rawGroups.length; i++) {
      v.groups.push(ModelProviderGroup.fromJson(rawGroups[i]));
    }
    const rawFailures: JsonMap[] = JsonAccess.objArr(map, 'failures');
    for (let i = 0; i < rawFailures.length; i++) {
      v.failures.push(ModelFailure.fromJson(rawFailures[i]));
    }
    return v;
  }
}

// ---------------------------------------------------------------------------
// 供应商设置
// ---------------------------------------------------------------------------

export class ProviderModel {
  id: string = '';
  name: string | null = null;
  contextWindow: number | null = null;
  maxTokens: number | null = null;

  /** JSON 映射（null 字段省略），供嵌进父请求体。 */
  toMap(): JsonMap {
    return new WireBuilder()
      .put('id', this.id)
      .put('name', this.name)
      .put('contextWindow', this.contextWindow)
      .put('maxTokens', this.maxTokens)
      .buildMap();
  }

  toJsonString(): string {
    return JSON.stringify(this.toMap());
  }

  static fromJson(map: JsonMap | null): ProviderModel {
    const v: ProviderModel = new ProviderModel();
    v.id = JsonAccess.str(map, 'id') ?? '';
    v.name = JsonAccess.str(map, 'name');
    v.contextWindow = JsonAccess.num(map, 'contextWindow');
    v.maxTokens = JsonAccess.num(map, 'maxTokens');
    return v;
  }
}

export class ProviderConfig {
  baseURL: string | null = null;
  api: string | null = null;
  displayName: string | null = null;
  thinking: string | null = null;
  reasoningEffort: string | null = null;
  models: ProviderModel[] = [];
  modelsInherited: boolean = false;

  static fromJson(map: JsonMap | null): ProviderConfig {
    const v: ProviderConfig = new ProviderConfig();
    v.baseURL = JsonAccess.str(map, 'baseURL');
    v.api = JsonAccess.str(map, 'api');
    v.displayName = JsonAccess.str(map, 'displayName');
    v.thinking = JsonAccess.str(map, 'thinking');
    v.reasoningEffort = JsonAccess.str(map, 'reasoningEffort');
    const raw: JsonMap[] = JsonAccess.objArr(map, 'models');
    for (let i = 0; i < raw.length; i++) {
      v.models.push(ProviderModel.fromJson(raw[i]));
    }
    v.modelsInherited = JsonAccess.bool(map, 'modelsInherited') ?? false;
    return v;
  }
}

export class CredentialState {
  ref: string = '';
  configured: boolean = false;
  source: string | null = null;
  writable: boolean = false;

  static fromJson(map: JsonMap | null): CredentialState {
    const v: CredentialState = new CredentialState();
    v.ref = JsonAccess.str(map, 'ref') ?? '';
    v.configured = JsonAccess.bool(map, 'configured') ?? false;
    v.source = JsonAccess.str(map, 'source');
    v.writable = JsonAccess.bool(map, 'writable') ?? false;
    return v;
  }
}

export class ProviderView {
  id: string = '';
  displayName: string = '';
  active: boolean = false;
  declared: boolean | null = null;
  configurable: boolean = false;
  configured: boolean = false;
  removable: boolean = false;
  credential: CredentialState = new CredentialState();
  config: ProviderConfig = new ProviderConfig();

  static fromJson(map: JsonMap | null): ProviderView {
    const v: ProviderView = new ProviderView();
    v.id = JsonAccess.str(map, 'id') ?? '';
    v.displayName = JsonAccess.str(map, 'displayName') ?? '';
    v.active = JsonAccess.bool(map, 'active') ?? false;
    v.declared = JsonAccess.bool(map, 'declared');
    v.configurable = JsonAccess.bool(map, 'configurable') ?? false;
    v.configured = JsonAccess.bool(map, 'configured') ?? false;
    v.removable = JsonAccess.bool(map, 'removable') ?? false;
    v.credential = CredentialState.fromJson(JsonAccess.obj(map, 'credential'));
    v.config = ProviderConfig.fromJson(JsonAccess.obj(map, 'config'));
    return v;
  }
}

export class CustomProviderCapability {
  available: boolean = false;
  protocols: string[] = [];
  revision: number | null = null;

  static fromJson(map: JsonMap | null): CustomProviderCapability {
    const v: CustomProviderCapability = new CustomProviderCapability();
    v.available = JsonAccess.bool(map, 'available') ?? false;
    v.protocols = JsonAccess.strArr(map, 'protocols');
    v.revision = JsonAccess.num(map, 'revision');
    return v;
  }
}

export class ProviderSettings {
  writable: boolean = false;
  /** 命名空间 → 修订号。JSON 是普通对象，这里收敛成 Map 便于取值。 */
  revisionByNamespace: Map<string, number> = new Map();
  customProvider: CustomProviderCapability = new CustomProviderCapability();
  providers: ProviderView[] = [];

  revision(namespace: string): number | null {
    const v: number | undefined = this.revisionByNamespace.get(namespace);
    return v === undefined ? null : v;
  }

  static fromJson(map: JsonMap | null): ProviderSettings {
    const v: ProviderSettings = new ProviderSettings();
    v.writable = JsonAccess.bool(map, 'writable') ?? false;
    const revisions: JsonMap | null = JsonAccess.obj(map, 'revisionByNamespace');
    if (revisions !== null) {
      const keys: string[] = Object.keys(revisions);
      for (let i = 0; i < keys.length; i++) {
        const key: string = keys[i];
        const num: number | null = JsonAccess.num(revisions, key);
        if (num !== null) {
          v.revisionByNamespace.set(key, num);
        }
      }
    }
    v.customProvider = CustomProviderCapability.fromJson(JsonAccess.obj(map, 'customProvider'));
    const raw: JsonMap[] = JsonAccess.objArr(map, 'providers');
    for (let i = 0; i < raw.length; i++) {
      v.providers.push(ProviderView.fromJson(raw[i]));
    }
    return v;
  }
}

/** `PATCH settings/providers/{id}` 请求体：未指定的字段**不出现**（不是发 null）。 */
export class ProviderPatch {
  displayName: string | null = null;
  baseURL: string | null = null;
  api: string | null = null;
  apiKey: string | null = null;
  thinking: string | null = null;
  reasoningEffort: string | null = null;
  models: ProviderModel[] | null = null;
  expectedRevision: number | null = null;

  toJsonString(): string {
    const b: WireBuilder = new WireBuilder()
      .put('displayName', this.displayName)
      .put('baseURL', this.baseURL)
      .put('api', this.api)
      .put('apiKey', this.apiKey)
      .put('thinking', this.thinking)
      .put('reasoningEffort', this.reasoningEffort)
      .put('expectedRevision', this.expectedRevision);
    if (this.models !== null) {
      const maps: JsonMapArray = [];
      for (let i = 0; i < this.models.length; i++) {
        maps.push(this.models[i].toMap());
      }
      b.put('models', maps);
    }
    return b.build();
  }
}

/** `POST settings/providers` 请求体：自定义供应商。 */
export class CustomProviderCreate {
  id: string = '';
  displayName: string | null = null;
  baseURL: string = '';
  api: string = '';
  apiKey: string | null = null;
  models: ProviderModel[] = [];
  expectedRevision: number | null = null;

  toJsonString(): string {
    const maps: JsonMapArray = [];
    for (let i = 0; i < this.models.length; i++) {
      maps.push(this.models[i].toMap());
    }
    return new WireBuilder()
      .put('id', this.id)
      .put('displayName', this.displayName)
      .put('baseURL', this.baseURL)
      .put('api', this.api)
      .put('apiKey', this.apiKey)
      .put('expectedRevision', this.expectedRevision)
      .put('models', maps)
      .build();
  }
}

// ---------------------------------------------------------------------------
// 插件
// ---------------------------------------------------------------------------

/**
 * 已安装插件清单里的一条记录。字段全带默认值，理由同 `AgentPreset.trust` 那次事故。
 *
 * `state` 取服务端约定的四种值：`loaded` / `installed-not-loaded` / `declared-missing` /
 * `runtime-provided`（官方包随 DSH 运行时自带，属正常状态）；未知取值由 UI 兜底显示。
 */
export class PluginEntry {
  name: string = '';
  /** package.json 里的版本声明，如 `^0.4.5`；可能为 null。 */
  declared: string | null = null;
  /** node_modules 里实际装上的版本；可能为 null。 */
  installed: string | null = null;
  loaded: boolean = false;
  /** 是否 DSH 官方包（`@deepseek-ai/` 前缀）。 */
  official: boolean = false;
  state: string = '';
  description: string | null = null;
  /** 包的主页 / 仓库地址（服务器已剥掉 `git+` 与 `.git`）。 */
  homepage: string | null = null;
  /**
   * 有没有新版本可装。**三态，别当布尔用**：`null` 表示「没查 / 查不到」，
   * 与 `false`（「已是最新」）不是一回事 —— 不查的时候把 null 显示成「已是最新」就是撒谎。
   */
  updateAvailable: boolean | null = null;
  /** npm 上的最新版本号；没查或查不到时为 null。 */
  latestVersion: string | null = null;
  /**
   * 能否在 App 里启停。官方包与没装进 profile 的包都为 false —— 界面对它们不该画开关：
   * 画了就是骗用户去点一个必然失败的按钮。
   */
  toggleable: boolean = false;

  static fromJson(map: JsonMap | null): PluginEntry {
    const v: PluginEntry = new PluginEntry();
    v.name = JsonAccess.str(map, 'name') ?? '';
    v.declared = JsonAccess.str(map, 'declared');
    v.installed = JsonAccess.str(map, 'installed');
    v.loaded = JsonAccess.bool(map, 'loaded') ?? false;
    v.official = JsonAccess.bool(map, 'official') ?? false;
    v.state = JsonAccess.str(map, 'state') ?? '';
    v.description = JsonAccess.str(map, 'description');
    v.homepage = JsonAccess.str(map, 'homepage');
    v.updateAvailable = JsonAccess.bool(map, 'updateAvailable');
    v.latestVersion = JsonAccess.str(map, 'latestVersion');
    v.toggleable = JsonAccess.bool(map, 'toggleable') ?? false;
    return v;
  }
}

/**
 * `PATCH settings/plugins` 的响应。
 *
 * `restartRequired` 目前**恒为 true**：服务端改写的是 profile 的 `dsh.profile.bundles`，
 * 而那份清单**只在 DSH 启动时读一次** —— 运行中的进程仍旧用着旧集合。界面必须把这句话
 * 明说，否则用户点完开关看到插件照旧在跑，只会以为「这个功能是坏的」。
 */
export class PluginToggleResult {
  name: string = '';
  loaded: boolean = false;
  /** 改动前写的备份文件名（幂等时为空串）。 */
  backupName: string = '';
  /** 改动后 bundles 数组的长度，便于界面显示「17 → 18」。 */
  bundleCount: number = 0;
  restartRequired: boolean = true;

  static fromJson(map: JsonMap | null): PluginToggleResult {
    const v: PluginToggleResult = new PluginToggleResult();
    v.name = JsonAccess.str(map, 'name') ?? '';
    v.loaded = JsonAccess.bool(map, 'loaded') ?? false;
    v.backupName = JsonAccess.str(map, 'backupName') ?? '';
    v.bundleCount = JsonAccess.num(map, 'bundleCount') ?? 0;
    v.restartRequired = JsonAccess.bool(map, 'restartRequired') ?? true;
    return v;
  }
}

/** `PATCH settings/plugins` 的请求体。 */
export class PluginToggleRequest {
  name: string = '';
  loaded: boolean = false;

  constructor(name: string = '', loaded: boolean = false) {
    this.name = name;
    this.loaded = loaded;
  }

  toJsonString(): string {
    return new WireBuilder().put('name', this.name).put('loaded', this.loaded).build();
  }
}

/**
 * `GET settings/plugins` 的响应。
 *
 * `available` 为 false 时 `items` 为空，`reason` 给出人可读的失败原因
 * （`PROFILE_UNKNOWN` / `MANIFEST_UNREADABLE`），界面必须显示解释而不是空白。
 *
 * `profile` 与 `profilePath` 在服务端是 `string | null`（判定不出时会**显式发送 null**），
 * 所以必须声明为可空。
 */
export class PluginInventory {
  profile: string | null = null;
  profilePath: string | null = null;
  available: boolean = false;
  reason: string | null = null;
  loadedCount: number = 0;
  problemCount: number = 0;
  items: PluginEntry[] = [];

  static fromJson(map: JsonMap | null): PluginInventory {
    const v: PluginInventory = new PluginInventory();
    v.profile = JsonAccess.str(map, 'profile');
    v.profilePath = JsonAccess.str(map, 'profilePath');
    v.available = JsonAccess.bool(map, 'available') ?? false;
    v.reason = JsonAccess.str(map, 'reason');
    v.loadedCount = JsonAccess.num(map, 'loadedCount') ?? 0;
    v.problemCount = JsonAccess.num(map, 'problemCount') ?? 0;
    const raw: JsonMap[] = JsonAccess.objArr(map, 'items');
    for (let i = 0; i < raw.length; i++) {
      v.items.push(PluginEntry.fromJson(raw[i]));
    }
    return v;
  }
}

