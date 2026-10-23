/**
 * SettingsSchema 纯逻辑 —— 对位 Android 源工程 `data/SettingsSchema.kt`。
 *
 * bridge v2.6.0 新增 `GET /settings/namespaces` 与 `PATCH /settings/namespaces/{ns}`。
 * schema → 控件映射、ops 生成、脏检测全在这里 —— **三层降级**策略（源工程纪律）：
 * 数据层 runCatching 静默不拖垮快照、状态层 null 不画入口（老 bridge 视觉零变化）、
 * 手动刷新 404/403 静默但 503 照报。
 *
 * 核心纪律：**密钥位只读且永不进 PATCH ops**（源工程红线）。
 *
 * 纯函数、无副作用、不碰平台 API —— node 单测全覆盖（见 test/cases/settings-schema.test.ts）。
 */

import { JsonAccess, JsonMap } from './JsonAccess';

/** 五种控件类型 —— 与 bridge schema 定义一一对应。 */
export enum SettingsFieldType {
  ENUM = 'enum',
  BOOLEAN = 'boolean',
  NUMBER = 'number',
  STRING = 'string',
  JSON = 'json',
}

/** schema 里的单个字段定义（来自 bridge 返回）。 */
export class SettingsFieldDef {
  readonly key: string;
  readonly label: string;
  readonly type: SettingsFieldType;
  readonly readOnly: boolean;
  /** ENUM 类型的可选值（type=enum 时有值）。 */
  readonly options: string[];
  /** JSON 类型标记为密钥位时永不进 PATCH ops。 */
  readonly isSecret: boolean;

  constructor(raw: JsonMap) {
    const rawKey: string | null = JsonAccess.str(raw, 'key');
    this.key = rawKey !== null ? rawKey : '';
    const rawLabel: string | null = JsonAccess.str(raw, 'label');
    this.label = rawLabel !== null && rawLabel.length > 0 ? rawLabel : this.key;
    const typeStr: string | null = JsonAccess.str(raw, 'type');
    // 未知类型回落 string（安全兜底）。
    const validTypes: string[] = [
      SettingsFieldType.ENUM, SettingsFieldType.BOOLEAN, SettingsFieldType.NUMBER,
      SettingsFieldType.STRING, SettingsFieldType.JSON,
    ];
    this.type = typeStr !== null && validTypes.includes(typeStr)
      ? typeStr as SettingsFieldType : SettingsFieldType.STRING;
    const readOnly: boolean | null = JsonAccess.bool(raw, 'readOnly');
    this.readOnly = readOnly !== null ? readOnly : false;
    this.options = JsonAccess.strArr(raw, 'options');
    const isSecret: boolean | null = JsonAccess.bool(raw, 'isSecret');
    this.isSecret = isSecret !== null ? isSecret : false;
  }
}

/** schema 定义：一个命名空间下的所有字段 + 当前值 + revision。 */
export class SettingsSchema {
  readonly namespace: string;
  readonly revision: number;
  readonly fields: SettingsFieldDef[];
  /** 字段当前值（来自 bridge 返回的 values）。 */
  readonly values: Map<string, Object>;
  /** 密钥字段的完整 key 列表 —— 永不进 ops。 */
  readonly secretKeys: Set<string>;

  constructor(namespace: string, revision: number, fields: SettingsFieldDef[], values: Map<string, Object>) {
    this.namespace = namespace;
    this.revision = revision;
    this.fields = fields;
    this.values = values;
    this.secretKeys = new Set<string>();
    for (let i = 0; i < fields.length; i++) {
      if (fields[i].readOnly || fields[i].isSecret) {
        this.secretKeys.add(fields[i].key);
      }
    }
  }

  /** schema 解析失败或空时的兜底 —— 不画入口。 */
  static empty(namespace: string): SettingsSchema {
    return new SettingsSchema(namespace, 0, [], new Map());
  }

  /** 从 bridge 返回的 JSON 解析一个 schema —— 失败返回 null（三层降级第一层）。 */
  static parse(namespace: string, revision: number, rawFields: JsonMap[] | null, rawValues: JsonMap | null): SettingsSchema | null {
    try {
      const fields: SettingsFieldDef[] = [];
      if (rawFields !== null) {
        for (let i = 0; i < rawFields.length; i++) {
          fields.push(new SettingsFieldDef(rawFields[i]));
        }
      }
      const values: Map<string, Object> = new Map();
      if (rawValues !== null) {
        const keys: string[] = Object.keys(rawValues);
        for (let i = 0; i < keys.length; i++) {
          values.set(keys[i], rawValues[keys[i]]);
        }
      }
      return new SettingsSchema(namespace, revision, fields, values);
    } catch (_e) {
      // 三层降级第一层：解析失败返回 null，状态层据此不画入口。
      return null;
    }
  }

  /** 取某个字段的当前值（供草稿初始化）。 */
  get(key: string): Object | null {
    const value: Object | undefined = this.values.get(key);
    return value === undefined ? null : value;
  }
}

/**
 * 草稿 → PATCH ops 生成器。
 *
 * 规则：
 * - 草稿值与 schema 原值**完全相等**的 key 不进 ops
 * - 密钥位（readOnly 或 isSecret）的 key **永不**进 ops（红线纪律）
 * - 未知 key（schema 里没有的）忽略 —— 服务端自己也不认
 *
 * @returns 可安全发给 bridge 的 ops 对象（null 表示没东西需要 PATCH）。
 */
export function buildSettingsOps(schema: SettingsSchema, draft: Map<string, Object>): JsonMap | null {
  const ops: JsonMap = {};
  let changed: boolean = false;
  const fieldKeys: Set<string> = new Set();
  for (let i = 0; i < schema.fields.length; i++) {
    fieldKeys.add(schema.fields[i].key);
  }
  // 按 schema 字段顺序遍历（而不是 draft 的顺序）—— 跳过未知 key。
  const keys: string[] = Array.from(fieldKeys);
  for (let i = 0; i < keys.length; i++) {
    const key: string = keys[i];
    if (schema.secretKeys.has(key)) {
      // 密钥位 / 只读位：永不进 ops（红线纪律）。
      continue;
    }
    if (!draft.has(key)) {
      // 草稿里没有这个字段 —— 用户没动过它，也不去 PATCH。
      continue;
    }
    const original: Object | null = schema.get(key);
    const draftValue: Object | null = draft.get(key) ?? null;
    if (deepEqual(original, draftValue)) {
      // 值没变 —— 不进 ops。
      continue;
    }
    ops[key] = draftValue as Object;
    changed = true;
  }
  return changed ? ops : null;
}

/**
 * 脏检测：草稿是否与 schema 原值有差异。
 *
 * 与 buildSettingsOps 同规则：密钥位不算脏。
 */
export function settingsSchemaIsDirty(schema: SettingsSchema, draft: Map<string, Object>): boolean {
  if (draft.size === 0) {
    return false;
  }
  const fieldKeys: Set<string> = new Set();
  for (let i = 0; i < schema.fields.length; i++) {
    fieldKeys.add(schema.fields[i].key);
  }
  const keys: string[] = Array.from(fieldKeys);
  for (let i = 0; i < keys.length; i++) {
    const key: string = keys[i];
    if (schema.secretKeys.has(key)) {
      continue;
    }
    if (!draft.has(key)) {
      continue;
    }
    const original: Object | null = schema.get(key);
    const draftValue: Object | null = draft.get(key) ?? null;
    if (!deepEqual(original, draftValue)) {
      return true;
    }
  }
  return false;
}

/** 三层降级守卫：老 bridge 返回 404/403 时静默（不画入口），503 照报（服务端真的挂了）。 */
export function isSilentSettingsNamespaceError(statusCode: number): boolean {
  // 404 = 端点不存在（bridge 太旧）、403 = 权限不足 —— 静默降级
  return statusCode === 404 || statusCode === 403;
}

// ——— 内部工具 ———

/**
 * 深比较 —— 处理 primitive + 对象（按 key 排序后比）+ 数组。
 *
 * 够 settings 场景用，不搞环形引用那些花活。
 */
function deepEqual(a: Object | null, b: Object | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (!Array.isArray(a) && !Array.isArray(b)) {
    const keysA: string[] = Object.keys(a as JsonMap).sort();
    const keysB: string[] = Object.keys(b as JsonMap).sort();
    if (keysA.length !== keysB.length) return false;
    for (let i = 0; i < keysA.length; i++) {
      if (keysA[i] !== keysB[i]) return false;
      if (!deepEqual((a as JsonMap)[keysA[i]], (b as JsonMap)[keysB[i]])) return false;
    }
    return true;
  }
  return false;
}

/** bridge 版本守卫常量 —— 设置命名空间功能需要 bridge ≥ 2.6.0。 */
export const SETTINGS_NAMESPACES_CAPABILITY: string = 'settings-namespaces-v1';
export const MIN_BRIDGE_VERSION_FOR_SETTINGS_NAMESPACES: string = '2.6.0';
