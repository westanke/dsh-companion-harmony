/**
 * 宽容 JSON 取值助手（对应原工程 kotlinx 的「严格解码 + 字段默认值」策略）。
 *
 * 原工程因 `AgentPreset.trust` 缺键、`PluginInventory.profile` 为 null 等三次事故，
 * 所有模型字段都带默认值。ArkTS 严格模式不允许动态对象，因此这里把「JSON 解析 + 宽容取值」
 * 收敛成唯一入口：缺键、显式 null、类型不符 → 一律退化为默认值，绝不抛异常。
 */
export type JsonMap = Record<string, Object>;

export class JsonAccess {
  /** 解析 JSON 文本，失败返回 null。 */
  static parse(text: string): Object | null {
    try {
      const value: Object = JSON.parse(text) as Object;
      return value;
    } catch (e) {
      return null;
    }
  }

  /** 把一个值收敛成可用于索引的键值对象；非对象返回 null。 */
  static asMap(value: Object | null | undefined): JsonMap | null {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value !== 'object') {
      return null;
    }
    return value as JsonMap;
  }

  /** 取字段原始值；键不存在或为 null 时返回 null。 */
  static raw(map: JsonMap | null, key: string): Object | null {
    if (map === null) {
      return null;
    }
    if (!(key in map)) {
      return null;
    }
    const v: Object = map[key];
    if (v === undefined || v === null) {
      return null;
    }
    return v;
  }

  /** 取字符串字段；类型不符返回 null。 */
  static str(map: JsonMap | null, key: string): string | null {
    const v = JsonAccess.raw(map, key);
    return typeof v === 'string' ? v as string : null;
  }

  /** 取数字字段（含整型/浮点）；类型不符返回 null。 */
  static num(map: JsonMap | null, key: string): number | null {
    const v = JsonAccess.raw(map, key);
    return typeof v === 'number' ? v as number : null;
  }

  /** 取布尔字段；类型不符返回 null。 */
  static bool(map: JsonMap | null, key: string): boolean | null {
    const v = JsonAccess.raw(map, key);
    return typeof v === 'boolean' ? v as boolean : null;
  }

  /** 取数组字段；非数组返回空数组。 */
  static arr(map: JsonMap | null, key: string): Object[] {
    const v = JsonAccess.raw(map, key);
    return Array.isArray(v) ? v as Object[] : [];
  }

  /** 取子对象字段；非对象返回 null。 */
  static obj(map: JsonMap | null, key: string): JsonMap | null {
    return JsonAccess.asMap(JsonAccess.raw(map, key));
  }

  /** 取字符串数组字段，过滤非字符串项。 */
  static strArr(map: JsonMap | null, key: string): string[] {
    const out: string[] = [];
    const items = JsonAccess.arr(map, key);
    for (let i = 0; i < items.length; i++) {
      const it: Object = items[i];
      if (typeof it === 'string') {
        out.push(it as string);
      }
    }
    return out;
  }

  /** 取对象数组字段。 */
  static objArr(map: JsonMap | null, key: string): JsonMap[] {
    const out: JsonMap[] = [];
    const items = JsonAccess.arr(map, key);
    for (let i = 0; i < items.length; i++) {
      const m = JsonAccess.asMap(items[i]);
      if (m !== null) {
        out.push(m);
      }
    }
    return out;
  }
}
