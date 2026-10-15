/**
 * 线上模型 —— **事件域**：消息内容（`PromptContentPart` 联合）、附件、会话事件与历史、
 * 工作区事件及其载荷取值助手。
 *
 * 面向服务端线上模型的**三条规矩**（字段一律给默认值 / 请求体省略 null / 判别联合按 type 分派）
 * 写在 `Models.ts` 的文件头 —— 那是本模块的索引。拆分的来龙去脉也见那里。
 */

import { JsonAccess, JsonMap } from './JsonAccess';
import { WireBuilder, JsonMapArray } from './ModelsWire';

// ---------------------------------------------------------------------------
// 消息内容（PromptContentPart 联合）
// ---------------------------------------------------------------------------

/**
 * 一条 prompt 内容 —— DSH 内核的 `PromptContentPart` 联合类型。
 *
 * 三种形态（与内核逐字段对齐，多一个字段就可能让服务端的 union 解析失败）：
 * - `text`：纯文本；
 * - `image`：图片，**base64 直接内联**，一步到位，不需要先上传；
 * - `file`：文件，先经 `chat/sessions/:id/attachments` 换来 `receiptId`，再引用。
 *
 * 判别器是 `type`，序列化结果就是内核要的形状：
 * `{"type":"image","mediaType":"image/png","data":"..."}`。
 * 这里用「单一扁平类 + type 分派」而不是三个子类：编码结果完全一致，且避开 ArkTS 的继承覆盖语法歧义。
 */
export class PromptPart {
  static readonly TYPE_TEXT: string = 'text';
  static readonly TYPE_IMAGE: string = 'image';
  static readonly TYPE_FILE: string = 'file';

  type: string = PromptPart.TYPE_TEXT;
  /** text 形态的正文。 */
  text: string = '';
  /** image 形态：如 `image/png`，内核按它决定怎么解码 `data`。 */
  mediaType: string = 'image/png';
  /** image 形态：标准 base64（非 URL-safe）。 */
  data: string = '';
  /** image 形态：可选原文件名，仅用于展示；为 null 时不发送该键。 */
  name: string | null = null;
  /** file 形态：上传换来的回执 id。 */
  receiptId: string = '';

  static text(text: string): PromptPart {
    const p: PromptPart = new PromptPart();
    p.type = PromptPart.TYPE_TEXT;
    p.text = text;
    return p;
  }

  static image(mediaType: string, data: string, name: string | null = null): PromptPart {
    const p: PromptPart = new PromptPart();
    p.type = PromptPart.TYPE_IMAGE;
    p.mediaType = mediaType;
    p.data = data;
    p.name = name;
    return p;
  }

  static file(receiptId: string): PromptPart {
    const p: PromptPart = new PromptPart();
    p.type = PromptPart.TYPE_FILE;
    p.receiptId = receiptId;
    return p;
  }

  static fromJson(map: JsonMap | null): PromptPart | null {
    const t: string | null = JsonAccess.str(map, 'type');
    if (t === PromptPart.TYPE_IMAGE) {
      return PromptPart.image(
        JsonAccess.str(map, 'mediaType') ?? 'image/png',
        JsonAccess.str(map, 'data') ?? '',
        JsonAccess.str(map, 'name'),
      );
    }
    if (t === PromptPart.TYPE_FILE) {
      return PromptPart.file(JsonAccess.str(map, 'receiptId') ?? '');
    }
    if (t === PromptPart.TYPE_TEXT) {
      return PromptPart.text(JsonAccess.str(map, 'text') ?? '');
    }
    return null;
  }

  /** 按 type **只写该形态的字段**，绝不夹带其它形态的键。 */
  toMap(): JsonMap {
    if (this.type === PromptPart.TYPE_IMAGE) {
      return new WireBuilder()
        .put('type', PromptPart.TYPE_IMAGE)
        .put('mediaType', this.mediaType)
        .put('data', this.data)
        .put('name', this.name)
        .buildMap();
    }
    if (this.type === PromptPart.TYPE_FILE) {
      return new WireBuilder()
        .put('type', PromptPart.TYPE_FILE)
        .put('receiptId', this.receiptId)
        .buildMap();
    }
    return new WireBuilder()
      .put('type', PromptPart.TYPE_TEXT)
      .put('text', this.text)
      .buildMap();
  }

  toJsonString(): string {
    return JSON.stringify(this.toMap());
  }

  /** 映射数组：嵌进消息体 `content` 时用它（别用已序列化字符串）。 */
  static toMapArray(parts: PromptPart[]): JsonMapArray {
    const maps: JsonMapArray = [];
    for (let i = 0; i < parts.length; i++) {
      maps.push(parts[i].toMap());
    }
    return maps;
  }

  /** 编码整组 part；空数组返回 `[]`。 */
  static encodeArray(parts: PromptPart[]): string {
    return JSON.stringify(PromptPart.toMapArray(parts));
  }
}

/** 保留任务书里的名字（与 `PromptPart` 是同一个类型）。 */
export type PromptContentPart = PromptPart;

/**
 * `POST chat/sessions/:id/attachments` 的响应。字段全带默认值：服务端将来省略 `name`
 * （或返回 null）时，不能让整个上传流程因为一个可选字段就解码失败。
 */
export class UploadedAttachment {
  receiptId: string = '';
  name: string = '';

  static fromJson(map: JsonMap | null): UploadedAttachment {
    const v: UploadedAttachment = new UploadedAttachment();
    v.receiptId = JsonAccess.str(map, 'receiptId') ?? '';
    v.name = JsonAccess.str(map, 'name') ?? '';
    return v;
  }
}

// ---------------------------------------------------------------------------
// 会话事件 / 历史 / 工作区事件
// ---------------------------------------------------------------------------

/** 事件载荷 / 投影 / surfaceOp 都是「自由形态的 JSON」，这里统一用 `Object | null` 承载。 */
export class SessionEvent {
  type: string = '';
  seq: number = 0;
  time: number = 0;
  data: Object | null = null;
  sourceEventSeqs: number[] = [];
  surfaceOp: Object | null = null;

  static fromJson(map: JsonMap | null): SessionEvent {
    const v: SessionEvent = new SessionEvent();
    v.type = JsonAccess.str(map, 'type') ?? '';
    v.seq = JsonAccess.num(map, 'seq') ?? 0;
    v.time = JsonAccess.num(map, 'time') ?? 0;
    v.data = JsonAccess.raw(map, 'data');
    const rawSeqs: Object[] = JsonAccess.arr(map, 'sourceEventSeqs');
    for (let i = 0; i < rawSeqs.length; i++) {
      const n: Object = rawSeqs[i];
      if (typeof n === 'number') {
        v.sourceEventSeqs.push(n as number);
      }
    }
    v.surfaceOp = JsonAccess.raw(map, 'surfaceOp');
    return v;
  }

  /** 事件载荷对象（非对象载荷返回 null）；供上层零散取值。 */
  dataMap(): JsonMap | null {
    return JsonAccess.asMap(this.data);
  }
}

export class HistoryEntry {
  event: SessionEvent = new SessionEvent();
  /** 已渲染过的视图（服务端可给，也可不给）。 */
  view: Object | null = null;

  static fromJson(map: JsonMap | null): HistoryEntry {
    const v: HistoryEntry = new HistoryEntry();
    v.event = SessionEvent.fromJson(JsonAccess.obj(map, 'event'));
    v.view = JsonAccess.raw(map, 'view');
    return v;
  }
}

export class ChatHistory {
  events: HistoryEntry[] = [];
  hasMore: boolean = false;
  projections: Object | null = null;

  /**
   * 往前补一页之后的副本。
   *
   * 为 `HarnessViewModel.loadOlderHistory` 补：对应 Kotlin
   * `current.copy(events = 合并去重后的, hasMore = older.hasMore, projections = ...)` ——
   * `hasMore` **必须取新拉回来那一页的值**（旧值说的是「还能不能往前翻」，
   * 合并之后这个问题的答案只由更老的那一页决定）。
   */
  withOlder(events: HistoryEntry[], hasMore: boolean, projections: Object | null): ChatHistory {
    const v: ChatHistory = new ChatHistory();
    v.events = events;
    v.hasMore = hasMore;
    v.projections = projections;
    return v;
  }

  static fromJson(map: JsonMap | null): ChatHistory {
    const v: ChatHistory = new ChatHistory();
    const raw: JsonMap[] = JsonAccess.objArr(map, 'events');
    for (let i = 0; i < raw.length; i++) {
      v.events.push(HistoryEntry.fromJson(raw[i]));
    }
    v.hasMore = JsonAccess.bool(map, 'hasMore') ?? false;
    v.projections = JsonAccess.raw(map, 'projections');
    return v;
  }
}

/** WebSocket `events` 推送的一帧。 */
export class WorkspaceEvent {
  id: string = '';
  type: string = '';
  time: number = 0;
  data: Object | null = null;

  static fromJson(map: JsonMap | null): WorkspaceEvent {
    const v: WorkspaceEvent = new WorkspaceEvent();
    v.id = JsonAccess.str(map, 'id') ?? '';
    v.type = JsonAccess.str(map, 'type') ?? '';
    v.time = JsonAccess.num(map, 'time') ?? 0;
    v.data = JsonAccess.raw(map, 'data');
    return v;
  }

  static fromJsonText(text: string): WorkspaceEvent | null {
    const map: JsonMap | null = JsonAccess.asMap(JsonAccess.parse(text));
    return map === null ? null : WorkspaceEvent.fromJson(map);
  }

  dataMap(): JsonMap | null {
    return JsonAccess.asMap(this.data);
  }
}

/**
 * 事件载荷里的字符串字段。
 *
 * 对应原工程那两个扩展函数 `WorkspaceEvent.dataString` —— 取值口径是
 * `JsonPrimitive.contentOrNull`：字符串原样返回，**数字 / 布尔转成文本**（服务端偶尔把
 * `sessionId` 发成数字，照搬 `JsonAccess.str` 会静默丢掉这一帧），其余形态（对象、数组、null）
 * 一律返回 null。
 *
 * 与 `ChatPresentation` 里那份取值助手同口径，但那个只在模块内可见，
 * 所以在这里补一对导出的，供 HarnessViewModel 与单测直接用。
 */
export function eventDataString(event: WorkspaceEvent, key: string): string | null {
  const value: Object | null = JsonAccess.raw(event.dataMap(), key);
  if (typeof value === 'string') {
    return value as string;
  }
  if (typeof value === 'number') {
    return `${value as number}`;
  }
  if (typeof value === 'boolean') {
    return (value as boolean) ? 'true' : 'false';
  }
  return null;
}

/**
 * 事件载荷里的整数字段。
 *
 * 对应 `WorkspaceEvent.dataInt`（`JsonPrimitive.intOrNull`）：数字型只认整数
 * （`turn` / `step` / `seq` 都是整数，小数不是这个协议里出现过的形态），
 * 字符串型按 Kotlin `toIntOrNull` 的口径严格解析 —— `"3"` → 3，
 * **`" 3"`、`"3.5"`、`"0x3"`、`""` 一律 null**（Kotlin 不接受前后空白，也不接受其它进制）。
 */
export function eventDataInt(event: WorkspaceEvent, key: string): number | null {
  const value: Object | null = JsonAccess.raw(event.dataMap(), key);
  if (typeof value === 'number') {
    const n: number = value as number;
    return Number.isInteger(n) ? n : null;
  }
  if (typeof value === 'string') {
    return parseStrictInt(value as string);
  }
  return null;
}

/** 严格十进制解析（不接受空白、小数点、进制前缀），失败返回 null。 */
function parseStrictInt(raw: string): number | null {
  let index: number = 0;
  let negative: boolean = false;
  if (raw.length > 0 && (raw.charAt(0) === '-' || raw.charAt(0) === '+')) {
    negative = raw.charAt(0) === '-';
    index = 1;
  }
  if (index >= raw.length) {
    return null;
  }
  let acc: number = 0;
  while (index < raw.length) {
    const code: number = raw.charCodeAt(index);
    if (code < 48 || code > 57) {
      return null;
    }
    acc = acc * 10 + (code - 48);
    index++;
  }
  return negative ? -acc : acc;
}

