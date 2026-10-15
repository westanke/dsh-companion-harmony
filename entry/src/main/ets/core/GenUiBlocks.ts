/**
 * dsh-ui 交互卡片与正文切分 —— 移植自原工程 `data/GenUiBlocks.kt`（341 行）。
 *
 * 现状：网页版把 ```` ```dsh-ui ```` 围栏交给渲染器画成真组件；App 原来把它当普通
 * 代码块，于是用户看到的是一坨裸 JSON —— **网页版有的东西，手机上没有**。
 *
 * 三段式：**切分（splitMessageBody）→ 解析（parseGenUi）→ 分发（UI 层按 type 画）**。
 * 每一步都刻意留了「失败了也能读」的退路，因为这条链路上三种失败在屏幕上长得几乎
 * 一模一样 —— 都是一段看着别扭但读得懂的文本，所以 diagnoseGenUi 把每一步的结果都
 * 变成一行可读文字，用户截图发回来就是完整现场。
 */

import { JsonAccess, JsonMap } from './JsonAccess';
import { isBlank, isNotBlank, trimText } from './TextPredicates';

const FENCE_MARK: string = '```';
const LANG_MARK: string = 'dsh-ui';

/** 标记之间的空白：空格或制表符。 */
const WHITESPACE: RegExp = /[ \t]+/;

/** 正文里被切出来的一段：普通文字，或一个 dsh-ui 卡片（原始 JSON）。 */
export enum MessageSegmentKind {
  PROSE = 'PROSE',
  UI = 'UI',
}

/**
 * 一条助手正文切出来的片段。
 *
 * 用「单一扁平类 + `kind` 判别」而不是两个子类 —— 与 `PromptPart` / `ChatLinkTarget`
 * 的处理一致，规避 ArkTS 的继承覆盖语法歧义。`text` 字段在两态下分别装：PROSE 是正文，
 * UI 是**原样的围栏内 JSON**（这里不解析，解析交给 `parseGenUi`）。
 */
export class MessageSegment {
  kind: MessageSegmentKind;
  text: string;

  constructor(kind: MessageSegmentKind, text: string) {
    this.kind = kind;
    this.text = text;
  }

  static prose(text: string): MessageSegment {
    return new MessageSegment(MessageSegmentKind.PROSE, text);
  }

  static ui(json: string): MessageSegment {
    return new MessageSegment(MessageSegmentKind.UI, json);
  }
}

/** 一个组件节点：保留原始 JSON 供渲染器读取。 */
export class GenUiNode {
  type: string;
  value: JsonMap;

  constructor(type: string, value: JsonMap) {
    this.type = type;
    this.value = value;
  }
}

export class GenUiSpec {
  title: string | null;
  gap: number;
  items: GenUiNode[];

  constructor(title: string | null = null, gap: number = 12, items: GenUiNode[] = []) {
    this.title = title;
    this.gap = gap;
    this.items = items;
  }
}

/**
 * 一条列表项。
 *
 * `list` 的 `items` 允许纯字符串，也允许 `{title, desc}` 对象，两种都要收。
 */
export class GenUiListItem {
  title: string;
  desc: string | null;

  constructor(title: string, desc: string | null = null) {
    this.title = title;
    this.desc = desc;
  }
}

/**
 * 只列「我们真的渲染了」的类型。
 *
 * 列全词表没有意义 —— 渲染不了还认得，等于让用户点一个没反应的按钮，
 * 那比明确地不显示更糟。未知 type 走 `genUiNodeOf` 的丢弃分支。
 */
const SUPPORTED: Set<string> = new Set<string>([
  'text', 'row', 'col', 'grid', 'card', 'divider', 'spacer',
  'stat', 'badge', 'progress', 'list', 'table', 'keyvalue', 'timeline',
  'code', 'json', 'diff', 'callout', 'steps', 'chart',
  'button', 'radio', 'submit',
]);

/** 复刻 kotlinx `JsonPrimitive.content` 家族：数字/布尔也给字符串，`null` 给 null。 */
class GenUiJson {
  static str(map: JsonMap | null, key: string): string | null {
    const value: Object | null = JsonAccess.raw(map, key);
    if (value === null) {
      return null;
    }
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

  /** 对应 `JsonPrimitive.intOrNull`：非整数或越界一律 null。 */
  static int(map: JsonMap | null, key: string): number | null {
    const value: Object | null = JsonAccess.raw(map, key);
    if (value === null || typeof value !== 'number') {
      return null;
    }
    const n: number = value as number;
    if (!Number.isInteger(n) || n < -2147483648 || n > 2147483647) {
      return null;
    }
    return n;
  }

  /** 对应 `JsonPrimitive.doubleOrNull`：任何数字都可（整数也算）。 */
  static number(map: JsonMap | null, key: string): number | null {
    const value: Object | null = JsonAccess.raw(map, key);
    return typeof value === 'number' ? value as number : null;
  }

  /** 对应 `JsonPrimitive.booleanOrNull`：只有布尔认。 */
  static bool(map: JsonMap | null, key: string): boolean | null {
    const value: Object | null = JsonAccess.raw(map, key);
    return typeof value === 'boolean' ? value as boolean : null;
  }
}

/** Kotlin `String.removePrefix(prefix)`。 */
function removePrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.substring(prefix.length) : value;
}

/**
 * 判断一行围栏头是不是 dsh-ui 卡片。
 *
 * **为什么不能只匹配 ` ```dsh-ui `**：genui skill 自己的文档里就有两种合法写法 ——
 * ` ```dsh-ui ` 与 ` ```json dsh-ui `（后者标了 JSON 高亮）。而模型写出来的是哪种并不
 * 统一。只认精确前缀的后果是：网页版能渲染的卡片，App 里退化成一个 JSON 代码块。
 *
 * 判据是**标记里含有 `dsh-ui`**，而不是位置或顺序：
 * - ` ```json dsh-ui ` 含 dsh-ui → 是；
 * - ` ```dsh-ui ` 含 dsh-ui → 是；
 * - ` ```json `、` ```mermaid `、普通 ` ``` ` → 不是；
 * - ` ```dsh-ui-bad ` 含前缀但不是标记 → 不认（否则会吞掉别的语言名）。
 */
function isGenUiInfo(line: string): boolean {
  if (!line.startsWith(FENCE_MARK)) {
    return false;
  }
  const info: string = trimText(removePrefix(trimText(line), FENCE_MARK));
  if (info.length === 0) {
    return false;
  }
  const parts: string[] = info.split(WHITESPACE);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === LANG_MARK) {
      return true;
    }
  }
  return false;
}

/**
 * 从 `from` 起找下一个 dsh-ui 围栏头的起始下标。
 *
 * 逐行找而不是 `indexOf("dsh-ui")`：语言标记必须**独占一行且位于行首**。
 * 正文里出现「见 dsh-ui 文档」这种字样时绝不能当成边界。
 */
function fenceHeadAt(body: string, from: number): number | null {
  let lineStart: number = from;
  while (lineStart <= body.length) {
    let lineEnd: number = body.indexOf('\n', lineStart);
    if (lineEnd < 0) {
      lineEnd = body.length;
    }
    const line: string = body.substring(lineStart, lineEnd);
    // 只在行首是 ``` 的行上做判断；缩进过的围栏不算。
    if (line.startsWith(FENCE_MARK) && isGenUiInfo(line)) {
      return lineStart;
    }
    if (lineEnd >= body.length) {
      break;
    }
    lineStart = lineEnd + 1;
  }
  return null;
}

/**
 * 把助手正文按 dsh-ui 围栏切开。
 *
 * 四条硬规则，每条都对应一个真实的坑：
 *
 * 1. **必须有闭合围栏才切**。流式输出时围栏是逐字到达的，开头 ``` 已出现而结尾还没到；
 *    此时就切出去会得到半截 JSON，卡片解析必然失败，用户看到的是卡片凭空消失。
 *    所以未闭合时**整段按原文保留**，等闭合了再切。退化行为是「显示原始代码块」，
 *    比「显示一个闪烁的加载框」诚实。
 * 2. **只看行首的围栏头**。正文中间出现的 ` ``` ` 是代码块，不能当卡片边界 ——
 *    否则一条「教你写 dsh-ui 围栏」的消息会被自己切成两半。
 * 3. **围栏内容原样透传，不在这里解析**。解析失败要能在 UI 层给出「这条卡片语法有问题」
 *    的提示，而不是让整条消息消失。所以本函数只做切割，JSON 合法性交给 `parseGenUi`。
 * 4. **空卡片不切**。`{"items":[]}` 切出来是个空壳，渲染成空气比不切更糟。
 */
export function splitMessageBody(body: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  // 用「已消费到哪」这一个游标推进，不用累加缓冲区：单一状态来源，
  // 杜绝尾部与游标对不上的情况。
  let cursor: number = 0;
  while (cursor < body.length) {
    const open: number | null = fenceHeadAt(body, cursor);
    if (open === null) {
      break;
    }
    const headEnd: number = body.indexOf('\n', open);
    // 围栏头后面没有换行 —— 流式输出正好停在这一行，等下一片再切。
    if (headEnd < 0) {
      return [MessageSegment.prose(body)];
    }
    const close: number = body.indexOf(FENCE_MARK, headEnd + 1);
    // 未闭合：**一字不动地**把整段交回去，连空白都不动。trim 会在每次重渲染时
    // 轻微抖动，所以刻意不做。
    if (close < 0) {
      return [MessageSegment.prose(body)];
    }
    const before: string = trimText(body.substring(cursor, open));
    if (before.length > 0) {
      segments.push(MessageSegment.prose(before));
    }
    const json: string = body.substring(headEnd + 1, close);
    if (isNotBlank(json)) {
      segments.push(MessageSegment.ui(json));
    }
    const after: number = body.indexOf('\n', close + FENCE_MARK.length);
    cursor = after < 0 ? body.length : after + 1;
  }
  const tail: string = trimText(body.substring(cursor));
  if (tail.length > 0) {
    segments.push(MessageSegment.prose(tail));
  }
  if (segments.length === 0) {
    return [MessageSegment.prose(body)];
  }
  return segments;
}

function genUiNodeOf(element: Object | null): GenUiNode | null {
  const value: JsonMap | null = JsonAccess.asMap(element);
  if (value === null) {
    return null;
  }
  const type: string | null = GenUiJson.str(value, 'type');
  if (type === null || !isNotBlank(type)) {
    return null;
  }
  if (!SUPPORTED.has(type)) {
    return null;
  }
  return new GenUiNode(type, value);
}

/**
 * 解析一段 dsh-ui JSON。
 *
 * 返回 `null` 表示**这条卡片无法显示**，UI 层据此回落到「原始代码块」——
 * 与网页版的「坏组件被丢弃、其余照常」一致，但多一层保险：整段坏掉时至少内容还在。
 * 单个节点坏掉只丢那个节点，不牵连整份 spec。
 */
export function parseGenUi(source: string): GenUiSpec | null {
  const root: JsonMap | null = JsonAccess.asMap(JsonAccess.parse(source));
  if (root === null) {
    return null;
  }
  const rawItems: Object[] = JsonAccess.arr(root, 'items');
  const items: GenUiNode[] = [];
  for (let i = 0; i < rawItems.length; i++) {
    const node: GenUiNode | null = genUiNodeOf(rawItems[i]);
    if (node !== null) {
      items.push(node);
    }
  }
  if (items.length === 0) {
    return null;
  }
  return new GenUiSpec(GenUiJson.str(root, 'title'), GenUiJson.int(root, 'gap') ?? 12, items);
}

/** `items` 里的子节点；布局容器（row/col/grid/card）用。 */
export function genUiChildren(node: GenUiNode): GenUiNode[] {
  const out: GenUiNode[] = [];
  const rawItems: Object[] = JsonAccess.arr(node.value, 'items');
  for (let i = 0; i < rawItems.length; i++) {
    const child: GenUiNode | null = genUiNodeOf(rawItems[i]);
    if (child !== null) {
      out.push(child);
    }
  }
  return out;
}

/** 原语（字符串/数字/布尔）的字符串形态；对象与 null 返回 null。 */
function primitiveContent(value: Object | null): string | null {
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
 * `list` 的条目：既接受纯字符串，也接受 `{title|label|content, desc}` 对象。
 *
 * 复刻 Kotlin 的分支顺序：**先按原语看**（纯字符串直接成条），再按对象取标题；
 * 标题取不到或全空白的条目直接丢。
 */
export function genUiListItems(node: GenUiNode): GenUiListItem[] {
  const out: GenUiListItem[] = [];
  const rawItems: Object[] = JsonAccess.arr(node.value, 'items');
  for (let i = 0; i < rawItems.length; i++) {
    const entry: Object | null = rawItems[i];
    const text: string | null = primitiveContent(entry);
    if (text !== null) {
      if (isNotBlank(text)) {
        out.push(new GenUiListItem(text));
      }
      continue;
    }
    const map: JsonMap | null = JsonAccess.asMap(entry);
    if (map === null) {
      continue;
    }
    const rawTitle: string | null = GenUiJson.str(map, 'title');
    const labelTitle: string | null = rawTitle === null ? GenUiJson.str(map, 'label') : rawTitle;
    const title: string | null = labelTitle === null ? GenUiJson.str(map, 'content') : labelTitle;
    if (title === null || isBlank(title)) {
      continue;
    }
    out.push(new GenUiListItem(title, GenUiJson.str(map, 'desc')));
  }
  return out;
}

/** `button` 的文案。 */
export function genUiLabel(node: GenUiNode): string | null {
  const label: string | null = GenUiJson.str(node.value, 'label');
  if (label !== null) {
    return label;
  }
  const content: string | null = GenUiJson.str(node.value, 'content');
  return content === null ? GenUiJson.str(node.value, 'title') : content;
}

/** 卡片式节点的标题。 */
export function genUiTitle(node: GenUiNode): string | null {
  const title: string | null = GenUiJson.str(node.value, 'title');
  return title === null ? GenUiJson.str(node.value, 'label') : title;
}

/**
 * 正文文字，去掉行内标记。
 *
 * 剥五种：`**加粗**`、`==高亮==`、`` `代码` ``、`[文字](链接)` / `![替代](图片)`、
 * `~~删除线~~`、`*斜体*`。不做完整 Markdown —— 网页版能渲染的是行内富文本这一层，
 * 表格和围栏本来就不该出现在文字字段里。
 *
 * **刻意不认下划线系的标记**（斜体 `_文字_` 与加粗 `__文字__`）：会话正文里 `_` 大量
 * 出现在标识符里（`entry_default`、`genUi_str`、Python 的 `__init__`），CommonMark 靠
 * 「词内不下划线强调」躲开这个坑，而这里只有正则、判断不出词边界 —— `a_b_c` 会被吃成
 * `a` + 强调 + `c`，`__init__` 会变成 `init`。少认两种写法，好过把变量名改得面目全非。
 *
 * 顺序要紧：先把 `**` 成对剥掉，再处理单星号斜体 —— 反过来的话 `**粗**` 会被斜体规则
 * 从第二个 `*` 起咬一口，留下两个孤立的星号。
 */
export function inlineMarkup(raw: string): string {
  return raw
    .replace(/\*\*/g, '')
    .replace(/==/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, '$1')
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1')
    .replace(/~~([^~]*)~~/g, '$1')
    .replace(/\*([^*\s](?:[^*]*[^*\s])?)\*/g, '$1');
}

/** 取 `key` 字段的正文文字（默认 `content`），并剥掉行内标记。 */
export function genUiInlineText(node: GenUiNode, key: string = 'content'): string {
  return inlineMarkup(GenUiJson.str(node.value, key) ?? '');
}

export function genUiInt(node: GenUiNode, key: string): number | null {
  return GenUiJson.int(node.value, key);
}

export function genUiNumber(node: GenUiNode, key: string): number | null {
  return GenUiJson.number(node.value, key);
}

export function genUiBool(node: GenUiNode, key: string): boolean | null {
  return GenUiJson.bool(node.value, key);
}

export function genUiStr(node: GenUiNode, key: string): string | null {
  return GenUiJson.str(node.value, key);
}

/**
 * 表格列宽的兜底下限（vp）—— 移植自原工程 `ui/GenUiCard.kt`（对应上游 `GenUiTableLayoutTest`）。
 *
 * 判据与网页版一致（`.card .tw` + `.card table{min-width:100%}`）：内容装得下就铺满卡片宽度，
 * 装不下就退回这个下限、由外层横向滚。96vp ≈ 两三个汉字加内边距 —— 再窄一列就只剩省略号，
 * 滚反而更好读。
 */
export const GENUI_TABLE_MIN_COLUMN_WIDTH_VP: number = 96;

/**
 * 一列该占多宽（vp）。
 *
 * `availableVp` 是卡片可用宽度；**无界或非法时退回下限** —— 宁可横向滚，
 * 也不要把列宽算成 0 或 NaN，让整张表消失（`row`/`col` 无界宽度约束下会拿到 `Infinity`，
 * 而 `Infinity / n` 仍是 `Infinity`，直接拿去设置宽度就是一张宽度无穷的表）。
 */
export function genUiTableColumnWidthVp(availableVp: number, columnCount: number): number {
  if (columnCount <= 0) {
    return GENUI_TABLE_MIN_COLUMN_WIDTH_VP;
  }
  if (!Number.isFinite(availableVp) || availableVp <= 0) {
    return GENUI_TABLE_MIN_COLUMN_WIDTH_VP;
  }
  return Math.max(GENUI_TABLE_MIN_COLUMN_WIDTH_VP, availableVp / columnCount);
}

/**
 * 一条助手消息的 dsh-ui 诊断报告。
 *
 * **为什么需要它**：这条链路上「围栏没被识别」「JSON 坏了」「节点类型不认识」
 * 三种失败在屏幕上长得几乎一模一样。没有实机可验证时，靠截图猜是哪一种，等于每次
 * 改代码都在掷骰子。这里把三段式（切分 → 解析 → 分发）的每一步结果都变成一行可读文字。
 *
 * `summary` 一行摘要，直接显示在消息下方；`details` 全文，包含各节点类型与被丢弃的类型名。
 */
export class GenUiDiagnosis {
  summary: string;
  details: string;

  constructor(summary: string, details: string) {
    this.summary = summary;
    this.details = details;
  }
}

class FenceScan {
  heads: number;
  genUiHeads: number;
  bareMarkers: number;

  constructor(heads: number, genUiHeads: number, bareMarkers: number) {
    this.heads = heads;
    this.genUiHeads = genUiHeads;
    this.bareMarkers = bareMarkers;
  }
}

/**
 * 扫一遍正文，数出行首围栏里有多少**头**、其中多少是 dsh-ui 的头。
 *
 * 为什么必须带状态：裸 ``` （无语言标记）看起来和闭合围栏一模一样，单看一行无法区分
 * 「开头」还是「结尾」。所以用 `insideFence` 记录当前是否在围栏内 —— 在里面遇到的裸 ```
 * 是闭合，在外面遇到的就是开头。早先的版本直接数行首 ```，于是每段卡片都被算成 2 个
 * 围栏，报出「见到 2 个围栏但都没被识别」这种把人往错方向引的话。
 *
 * `bareMarkers` 单独记裸标记数：它们天生二义，扫不准就如实报数量，不硬猜哪个是头。
 */
function fenceScan(body: string): FenceScan {
  let heads: number = 0;
  let genUiHeads: number = 0;
  let bare: number = 0;
  let insideFence: boolean = false;
  let lineStart: number = 0;
  while (lineStart <= body.length) {
    let lineEnd: number = body.indexOf('\n', lineStart);
    if (lineEnd < 0) {
      lineEnd = body.length;
    }
    const line: string = body.substring(lineStart, lineEnd);
    if (line.startsWith(FENCE_MARK)) {
      const info: string = trimText(removePrefix(trimText(line), FENCE_MARK));
      if (info.length === 0) {
        bare++;
        insideFence = !insideFence;
      } else if (!insideFence) {
        heads++;
        if (isGenUiInfo(line)) {
          genUiHeads++;
        }
        insideFence = true;
      }
    }
    if (lineEnd >= body.length) {
      break;
    }
    lineStart = lineEnd + 1;
  }
  return new FenceScan(heads, genUiHeads, bare);
}

/**
 * 对一条消息正文跑一遍三段式诊断，**不改变渲染行为**。
 *
 * 关键点：这里刻意**不复用** `splitMessageBody` / `parseGenUi` 的内部判断，而是独立
 * 复算一遍，这样「解析器认为成功但渲染仍失败」这种不一致也会暴露出来。
 */
export function diagnoseGenUi(body: string): GenUiDiagnosis {
  const scan: FenceScan = fenceScan(body);
  const fenceCount: number = scan.heads;
  const jsonFence: number = scan.genUiHeads;
  const segments: MessageSegment[] = splitMessageBody(body);
  const uiSegments: MessageSegment[] = [];
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].kind === MessageSegmentKind.UI) {
      uiSegments.push(segments[i]);
    }
  }
  const uiCount: number = uiSegments.length;
  if (uiCount === 0) {
    // 没有卡片段。三种成因对用户的意义完全不同，必须分开报：
    // 1. 一个围栏头都没有 → 本条本来就是纯文字，正常；
    // 2. 认出了 dsh-ui 围栏头但没切出卡片段 → 流式输出中围栏尚未闭合，正常，
    //    绝不能报成故障，否则用户会盯着一个「⚠」等它自己消失；
    // 3. 见到无语言标记的 ``` → 真故障，最可疑。
    //
    // 刻意不区分它是头还是闭合：裸 ``` 天生二义，如实报数量比猜一个结论有用。
    if (jsonFence > 0) {
      return new GenUiDiagnosis(
        'dsh-ui 围栏已识别，尚未闭合（流式输出中）',
        `围栏头=${jsonFence} 闭合=0 —— 等输出结束会自动切成卡片`,
      );
    }
    if (scan.bareMarkers > 0) {
      return new GenUiDiagnosis(
        `⚠ 见到 ${scan.bareMarkers} 个无标记 \`\`\` 围栏，疑似卡片没写 dsh-ui`,
        `带标记的围栏头=${fenceCount} dsh-ui头=0 裸标记=${scan.bareMarkers}`
          + ' —— 若正文里本该是卡片，网页版能渲染而 App 认不出',
      );
    }
    return new GenUiDiagnosis('无 dsh-ui 围栏（正常，本条纯文字）', 'fences=0');
  }

  const specs: (GenUiSpec | null)[] = [];
  for (let i = 0; i < uiSegments.length; i++) {
    specs.push(parseGenUi(uiSegments[i].text));
  }
  const nodes: GenUiNode[] = [];
  let goodCount: number = 0;
  let badCount: number = 0;
  for (let i = 0; i < specs.length; i++) {
    const spec: GenUiSpec | null = specs[i];
    if (spec === null) {
      badCount++;
      continue;
    }
    goodCount++;
    for (let j = 0; j < spec.items.length; j++) {
      nodes.push(spec.items[j]);
    }
  }
  // 「被丢弃」的节点其实在 parseGenUi 里就已经滤掉了（genUiNodeOf 对未知 type 返回 null），
  // 所以这里报告的是**幸存下来的**类型分布。
  const counts: Map<string, number> = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) {
    const type: string = nodes[i].type;
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const typeKeys: string[] = Array.from(counts.keys());
  const parts: string[] = [];
  parts.push(`ui=${uiCount}`);
  if (badCount > 0) {
    parts.push(`JSON坏=${badCount}`);
  }
  const knownKeys: string = typeKeys.join('/');
  parts.push(`节点=${nodes.length}(${knownKeys.length === 0 ? '无' : knownKeys})`);
  const summary: string = badCount === 0
    ? `dsh-ui ✓ ${parts.join(' ')}`
    : `⚠ 卡片 JSON 解析失败 ×${badCount}`;

  let details: string = '';
  details += `围栏头=${fenceCount}（其中 dsh-ui=${jsonFence}）\n`;
  details += `切出片段=${segments.length}，其中卡片段=${uiCount}\n`;
  details += `解析成功=${goodCount} 失败=${badCount}\n`;
  const knownParts: string[] = [];
  for (let i = 0; i < typeKeys.length; i++) {
    knownParts.push(`${typeKeys[i]}×${counts.get(typeKeys[i])}`);
  }
  details += `节点类型：${knownParts.length === 0 ? '（无）' : knownParts.join(', ')}\n`;
  if (badCount > 0) {
    let firstBad: string = '';
    for (let i = 0; i < specs.length; i++) {
      if (specs[i] === null) {
        firstBad = uiSegments[i].text;
        break;
      }
    }
    let err: string | null = null;
    try {
      JSON.parse(firstBad);
    } catch (e) {
      err = e instanceof Error ? e.message : `${e}`;
    }
    details += `首个失败片段：${err === null ? '返回 null（结构不符或 items 为空）' : err}\n`;
  }
  return new GenUiDiagnosis(summary, details);
}
