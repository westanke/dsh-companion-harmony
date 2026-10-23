/**
 * SettingsSchema 纯函数用例 —— 对位 Android 源工程 SettingsSchema 测试。
 *
 * 核心纪律（每条都要有钉住的断言）：
 * 1. 五种控件类型正确解析
 * 2. 密钥位（readOnly / isSecret）永不进 PATCH ops（红线）
 * 3. 草稿值与原值相等时不进 ops（节省请求体）
 * 4. 脏检测：密钥位不算脏、原值相等不算脏
 * 5. 三层降级守卫：404/403 静默、503 照报
 * 6. 未知 key 忽略（schema 里没有的）
 * 7. 类型容错：未知类型回落 string
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SettingsFieldType, SettingsFieldDef, SettingsSchema,
  buildSettingsOps, settingsSchemaIsDirty, isSilentSettingsNamespaceError,
  SETTINGS_NAMESPACES_CAPABILITY,
} from '../../entry/src/main/ets/core/SettingsSchema';
import { JsonAccess } from '../../entry/src/main/ets/core/JsonAccess';

function makeField(key: string, type: string, label?: string, opts: Record<string, unknown> = {}): SettingsFieldDef {
  const raw: Record<string, unknown> = { key, type, ...opts };
  if (label !== undefined) raw.label = label;
  return new SettingsFieldDef(raw);
}

function makeSchema(fields: SettingsFieldDef[], values: Record<string, unknown>): SettingsSchema {
  return new SettingsSchema('test', 1, fields, new Map(Object.entries(values)));
}

describe('SettingsSchema', () => {

  describe('SettingsFieldDef 五种类型解析', () => {

    it('enum + options 正确解析', () => {
      const f: SettingsFieldDef = makeField('theme', 'enum', '主题', {
        options: ['light', 'dark', 'system'],
      });
      assert.equal(f.type, SettingsFieldType.ENUM);
      assert.deepEqual(f.options, ['light', 'dark', 'system']);
      assert.equal(f.readOnly, false);
      assert.equal(f.isSecret, false);
    });

    it('boolean 正确解析', () => {
      const f: SettingsFieldDef = makeField('auto_save', 'boolean');
      assert.equal(f.type, SettingsFieldType.BOOLEAN);
    });

    it('number 正确解析', () => {
      const f: SettingsFieldDef = makeField('timeout', 'number');
      assert.equal(f.type, SettingsFieldType.NUMBER);
    });

    it('string 正确解析', () => {
      const f: SettingsFieldDef = makeField('endpoint', 'string');
      assert.equal(f.type, SettingsFieldType.STRING);
    });

    it('json 正确解析', () => {
      const f: SettingsFieldDef = makeField('config', 'json');
      assert.equal(f.type, SettingsFieldType.JSON);
    });

    it('未知类型回落 string（安全兜底）', () => {
      const f: SettingsFieldDef = makeField('weird', 'binary');
      assert.equal(f.type, SettingsFieldType.STRING);
    });
  });

  describe('buildSettingsOps 红线纪律', () => {

    it('密钥位永不进 ops（isSecret=true）', () => {
      const schema: SettingsSchema = makeSchema(
        [makeField('api_key', 'string', 'API Key', { isSecret: true })],
        { api_key: 'sk-old' },
      );
      const draft: Map<string, unknown> = new Map([['api_key', 'sk-new']]);
      assert.equal(buildSettingsOps(schema, draft), null);
    });

    it('只读位永不进 ops（readOnly=true）', () => {
      const schema: SettingsSchema = makeSchema(
        [makeField('plugin_version', 'string', '版本', { readOnly: true })],
        { plugin_version: '1.0.0' },
      );
      const draft: Map<string, unknown> = new Map([['plugin_version', '2.0.0']]);
      assert.equal(buildSettingsOps(schema, draft), null);
    });

    it('原值相等不进 ops（节省请求体）', () => {
      const schema: SettingsSchema = makeSchema(
        [makeField('auto_save', 'boolean')],
        { auto_save: true },
      );
      const draft: Map<string, unknown> = new Map([['auto_save', true]]);
      assert.equal(buildSettingsOps(schema, draft), null);
    });

    it('未知 key 忽略（schema 里没有的）', () => {
      const schema: SettingsSchema = makeSchema(
        [makeField('auto_save', 'boolean')],
        { auto_save: true },
      );
      const draft: Map<string, unknown> = new Map([
        ['auto_save', false],
        ['bogus_key', 'whatever'],
      ]);
      const ops = buildSettingsOps(schema, draft);
      assert.ok(ops !== null);
      assert.ok(!('bogus_key' in (ops as Record<string, unknown>)));
      assert.equal((ops as Record<string, unknown>).auto_save, false);
    });

    it('正常改动进 ops', () => {
      const schema: SettingsSchema = makeSchema(
        [makeField('timeout', 'number')],
        { timeout: 30 },
      );
      const draft: Map<string, unknown> = new Map([['timeout', 60]]);
      const ops = buildSettingsOps(schema, draft);
      assert.ok(ops !== null);
      assert.equal((ops as Record<string, unknown>).timeout, 60);
    });

    it('草稿里没有这个字段 → 不进 ops（用户没动过）', () => {
      const schema: SettingsSchema = makeSchema(
        [makeField('timeout', 'number'), makeField('retries', 'number')],
        { timeout: 30, retries: 3 },
      );
      // 只改 timeout，没碰 retries → retries 不进 ops
      const draft: Map<string, unknown> = new Map([['timeout', 60]]);
      const ops = buildSettingsOps(schema, draft);
      assert.ok(ops !== null);
      assert.ok(!('retries' in (ops as Record<string, unknown>)));
    });
  });

  describe('settingsSchemaIsDirty 脏检测', () => {

    it('空草稿 → 不脏', () => {
      const schema: SettingsSchema = makeSchema(
        [makeField('timeout', 'number')],
        { timeout: 30 },
      );
      assert.equal(settingsSchemaIsDirty(schema, new Map()), false);
    });

    it('原值相等 → 不脏', () => {
      const schema: SettingsSchema = makeSchema(
        [makeField('timeout', 'number')],
        { timeout: 30 },
      );
      const draft: Map<string, unknown> = new Map([['timeout', 30]]);
      assert.equal(settingsSchemaIsDirty(schema, draft), false);
    });

    it('密钥位改动 → 不算脏（红线纪律）', () => {
      const schema: SettingsSchema = makeSchema(
        [makeField('api_key', 'string', 'API Key', { isSecret: true })],
        { api_key: 'sk-old' },
      );
      const draft: Map<string, unknown> = new Map([['api_key', 'sk-new']]);
      assert.equal(settingsSchemaIsDirty(schema, draft), false);
    });

    it('正常改动 → 脏', () => {
      const schema: SettingsSchema = makeSchema(
        [makeField('timeout', 'number')],
        { timeout: 30 },
      );
      const draft: Map<string, unknown> = new Map([['timeout', 60]]);
      assert.equal(settingsSchemaIsDirty(schema, draft), true);
    });

    it('嵌套对象深比较', () => {
      const schema: SettingsSchema = makeSchema(
        [makeField('config', 'json')],
        { config: { a: 1, b: 2 } },
      );
      // 同值不同引用 → 不算脏
      const draft: Map<string, unknown> = new Map([['config', { b: 2, a: 1 }]]);
      assert.equal(settingsSchemaIsDirty(schema, draft), false);
      // 真不同 → 脏
      const draft2: Map<string, unknown> = new Map([['config', { a: 1, b: 3 }]]);
      assert.equal(settingsSchemaIsDirty(schema, draft2), true);
    });
  });

  describe('三层降级守卫', () => {

    it('404 → 静默（bridge 太旧端点不存在）', () => {
      assert.equal(isSilentSettingsNamespaceError(404), true);
    });

    it('403 → 静默（权限不足）', () => {
      assert.equal(isSilentSettingsNamespaceError(403), true);
    });

    it('503 → 不静默（服务端真挂了照报）', () => {
      assert.equal(isSilentSettingsNamespaceError(503), false);
    });

    it('401 → 不静默（不是降级原因）', () => {
      assert.equal(isSilentSettingsNamespaceError(401), false);
    });

    it('500 → 不静默', () => {
      assert.equal(isSilentSettingsNamespaceError(500), false);
    });
  });

  describe('SETTINGS_NAMESPACES_CAPABILITY 常量', () => {

    it('跨仓契约：能力位名不可动', () => {
      assert.equal(SETTINGS_NAMESPACES_CAPABILITY, 'settings-namespaces-v1');
    });
  });

  describe('SettingsSchema.parse 三层降级第一层', () => {

    it('null fields 返回 empty schema（不是 null）', () => {
      const schema: SettingsSchema | null = SettingsSchema.parse('test', 1, null, null);
      assert.ok(schema !== null);
      assert.equal(schema!.namespace, 'test');
      assert.equal(schema!.fields.length, 0);
    });

    it('空数组 fields → 正常 schema', () => {
      const schema: SettingsSchema | null = SettingsSchema.parse('test', 1, [], null);
      assert.ok(schema !== null);
      assert.equal(schema!.fields.length, 0);
    });
  });
});
