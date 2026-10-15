/**
 * 从 HTML 里抽出**结构**，供 ArkUI 画成原生控件 —— 移植自原工程 `data/HtmlPreview.kt`（235 行）。
 *
 * 为什么不用 WebView 直接渲染：WebView 会执行页面里的 `<script>`、加载外链、发起网络
 * 请求。这里读的是「会话里出现过的任意文件」—— 用 WebView 等于把手机浏览器的一次请求
 * 权限交给一份不可信文件。这里只做**纯文本抽取**：没有 JS、没有网络、没有样式执行。
 *
 * 抽出来的是标题、段落、列表项、引用、代码块、链接、表格行 —— 也就是「一份 HTML
 * 读起来说了什么」。标签与实体在这里就被消化掉，UI 层不需要知道 HTML 的存在。
 */

import { isNotBlank, trimText } from './TextPredicates';

/** 一段抽取结果的形态。 */
export enum HtmlBlockKind {
  HEADING = 'HEADING',
  PARAGRAPH = 'PARAGRAPH',
  LIST_ITEM = 'LIST_ITEM',
  QUOTE = 'QUOTE',
  CODE = 'CODE',
  LINK = 'LINK',
}

export class HtmlBlock {
  kind: HtmlBlockKind;
  text: string;
  href: string | null;

  constructor(kind: HtmlBlockKind, text: string, href: string | null = null) {
    this.kind = kind;
    this.text = text;
    this.href = href;
  }
}

/**
 * 不打断段落的标签：行内标记与自闭合标签。
 *
 * 它们出现时**不能** flush —— `<b>粗体</b>` 里的正文要和它前面那句连成一段，
 * 每遇一个行内标签就断开的话，一段话会被切成十几段。
 */
const VOID_OR_INLINE: Set<string> = new Set<string>([
  'b', 'i', 'em', 'strong', 'span', 'u', 's', 'small', 'sub', 'sup', 'mark',
  'br', 'hr', 'img', 'meta', 'link', 'input', 'source',
]);

/** Kotlin `String.substringBefore(delimiter)`：找不到分隔符时返回整串。 */
function substringBefore(value: string, delimiter: string): string {
  const index: number = value.indexOf(delimiter);
  return index < 0 ? value : value.substring(0, index);
}

/** Kotlin `String.removePrefix(prefix)`。 */
function removePrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.substring(prefix.length) : value;
}

/**
 * 取标签名（小写，去 `</` 前缀与属性）—— 对应 Kotlin 的
 * `tag.removePrefix("/").substringBefore(' ').substringBefore('/').lowercase()`。
 */
function tagNameOf(raw: string): string {
  const trimmed: string = trimText(raw);
  const withoutSlash: string = removePrefix(trimmed, '/');
  const withoutAttrs: string = substringBefore(substringBefore(withoutSlash, ' '), '/');
  return withoutAttrs.toLowerCase();
}

/**
 * 大小写不敏感地找子串（对应 Kotlin `indexOf(string, startIndex, ignoreCase = true)`）。
 *
 * 两侧都先小写再比。标签名与闭合标记全是 ASCII，所以不会遇到「小写后长度变化」的语言
 * 特例；真遇到了也只是这一层位置算不准，不会误报内容。
 */
function indexOfIgnoreCase(source: string, needle: string, from: number): number {
  return source.toLowerCase().indexOf(needle.toLowerCase(), from);
}

/**
 * 从 [from] 起读纯文本，直到遇到 `stops` 里任一标签的起始。
 *
 * `collapseWhitespace` 为 false 时**保留换行与缩进** —— 代码块里的缩进是信息，
 * 压成一行之后 `if (x) {` 和它的函数体就贴成了一行，读者得自己猜层级。
 */
function readTextUntil(source: string, from: number, stops: Set<string>,
  collapseWhitespace: boolean = true): string {
  let cursor: number = from;
  let builder: string = '';
  while (cursor < source.length) {
    const open: number = source.indexOf('<', cursor);
    if (open < 0) {
      builder += source.substring(cursor);
      break;
    }
    builder += source.substring(cursor, open);
    const close: number = source.indexOf('>', open);
    if (close < 0) {
      builder += source.substring(open);
      break;
    }
    const name: string = tagNameOf(source.substring(open + 1, close));
    if (stops.has(name)) {
      break;
    }
    builder += ' ';
    cursor = close + 1;
  }
  return collapseWhitespace ? trimText(builder.replace(/\s+/g, ' ')) : trimText(builder);
}

/** 跳过 [name] 的闭合标签；没找到就返回源串末尾，不吞掉后续内容。 */
function skipToClose(source: string, from: number, name: string): number {
  const marker: string = `</${name}`;
  const end: number = indexOfIgnoreCase(source, marker, from);
  if (end < 0) {
    return source.length;
  }
  const close: number = source.indexOf('>', end);
  return close < 0 ? source.length : close + 1;
}

/**
 * 极简 HTML → `HtmlBlock` 抽取。
 *
 * 刻意只支持最常见的标签，**不是**通用解析器：
 * - 段落/换行 → `PARAGRAPH`
 * - `h1`–`h6` → `HEADING`
 * - `li` → `LIST_ITEM`（无序/有序列表都不区分，UI 统一画成项目符号；区分有序列表
 *   就要维护计数器，而编号在跳过嵌套时会错位）
 * - `blockquote` → `QUOTE`
 * - `pre` / `code` → `CODE`（代码保留原文，不剥行内标记）
 * - `a href=` → `LINK`
 * - `script` / `style` 的内容**整体丢弃**，连同标签本身
 *
 * 为什么 `script` 的内容要丢而不是当文本显示：一段 `function f(){...}` 对读者没有信息量，
 * 却是这份文件里最容易被误读成「App 在执行它」的部分。
 */
export function extractHtmlBlocks(source: string): HtmlBlock[] {
  const blocks: HtmlBlock[] = [];
  let cursor: number = 0;
  let paragraph: string = '';

  const flushParagraph = (): void => {
    const text: string = trimText(paragraph);
    paragraph = '';
    if (text.length > 0) {
      blocks.push(new HtmlBlock(HtmlBlockKind.PARAGRAPH, text));
    }
  };

  while (cursor < source.length) {
    const open: number = source.indexOf('<', cursor);
    if (open < 0) {
      paragraph += decodeHtmlEntities(source.substring(cursor));
      break;
    }
    if (open > cursor) {
      paragraph += decodeHtmlEntities(source.substring(cursor, open));
    }
    const close: number = source.indexOf('>', open);
    if (close < 0) {
      // 标签没闭合（流式写入的半个标签）：剩下的当纯文本，别把内容整个丢掉。
      paragraph += decodeHtmlEntities(source.substring(open));
      break;
    }
    const tag: string = trimText(source.substring(open + 1, close));
    const closing: boolean = tag.startsWith('/');
    const name: string = tagNameOf(tag);
    // script/style 连标签带内容一起跳过 —— 位置靠后说明标签已经开了。
    if (name === 'script' || name === 'style') {
      flushParagraph();
      const closingTag: string = `</${name}`;
      const end: number = indexOfIgnoreCase(source, closingTag, close);
      if (end < 0) {
        cursor = source.length;
      } else {
        const gt: number = source.indexOf('>', end);
        cursor = gt < 0 ? source.length : gt + 1;
      }
      continue;
    }
    // 一个**开标签**意味着新的一段开始：先把之前攒下的正文收掉。
    // 闭合标签一律不做事 —— `</ul>`、`</div>` 这种容器闭合不该产生任何效果。
    //
    // 顺序很要紧：**先 flush 再抽自己的内容**。反过来（先抽后 flush）的话，
    // `<li>甲</li>` 的「甲」会和它前面的正文粘成一段。
    if (closing || VOID_OR_INLINE.has(name)) {
      cursor = close + 1;
      continue;
    }
    flushParagraph();
    cursor = close + 1;

    if (name === 'li' || name === 'tr') {
      const text: string = readTextUntil(source, cursor, new Set<string>([name]));
      if (isNotBlank(text)) {
        blocks.push(new HtmlBlock(HtmlBlockKind.LIST_ITEM, text));
      }
      cursor = skipToClose(source, cursor, name);
    } else if (name === 'blockquote') {
      const text: string = readTextUntil(source, cursor, new Set<string>(['blockquote']));
      if (isNotBlank(text)) {
        blocks.push(new HtmlBlock(HtmlBlockKind.QUOTE, text));
      }
      cursor = skipToClose(source, cursor, 'blockquote');
    } else if (name === 'pre' || name === 'code') {
      // `pre` 与 `code` 常常是嵌套的（`<pre><code>…</code></pre>`）。
      // **只认自己这一个标签的闭合**，中间遇到别的标签当分隔符
      // （代码块里的换行与缩进才是信息，不能因为一个 <span> 就断掉）。
      const text: string = readTextUntil(source, cursor, new Set<string>([name]), false);
      if (isNotBlank(text)) {
        blocks.push(new HtmlBlock(HtmlBlockKind.CODE, text));
      }
      cursor = skipToClose(source, cursor, name);
    } else if (name === 'a') {
      const text: string = readTextUntil(source, cursor, new Set<string>(['a']));
      const match: RegExpMatchArray | null = tag.match(/href\s*=\s*["']([^"']+)["']/i);
      const href: string | null = match === null ? null : match[1];
      if (isNotBlank(text)) {
        blocks.push(new HtmlBlock(HtmlBlockKind.LINK, text, href));
      }
      cursor = skipToClose(source, cursor, 'a');
    } else if (name === 'h1' || name === 'h2' || name === 'h3'
      || name === 'h4' || name === 'h5' || name === 'h6') {
      const text: string = readTextUntil(source, cursor, new Set<string>([name]));
      if (isNotBlank(text)) {
        blocks.push(new HtmlBlock(HtmlBlockKind.HEADING, text));
      }
      cursor = skipToClose(source, cursor, name);
    }
  }
  flushParagraph();
  return blocks;
}

function digitValue(ch: string, radix: number): number {
  const code: number = ch.charCodeAt(0);
  let value: number = -1;
  if (code >= 0x30 && code <= 0x39) {
    value = code - 0x30;
  } else if (code >= 0x61 && code <= 0x7A) {
    value = code - 0x61 + 10;
  } else if (code >= 0x41 && code <= 0x5A) {
    value = code - 0x41 + 10;
  }
  return value < radix ? value : -1;
}

/**
 * Kotlin `String.toIntOrNull(radix)`：非法字符、空串、越界一律 null。
 *
 * 刻意不用 JS 的 `Number.parseInt`：它会在非法字符处停下并返回已解析的部分
 * （`"12x"` → 12），而 Kotlin 的口径是整串必须合法。
 */
function intOrNull(text: string, radix: number): number | null {
  if (text.length === 0) {
    return null;
  }
  let index: number = 0;
  let negative: boolean = false;
  const first: string = text.charAt(0);
  if (first === '+') {
    index = 1;
  } else if (first === '-') {
    negative = true;
    index = 1;
  }
  if (index >= text.length) {
    return null;
  }
  let value: number = 0;
  for (; index < text.length; index++) {
    const digit: number = digitValue(text.charAt(index), radix);
    if (digit < 0) {
      return null;
    }
    value = value * radix + digit;
    if (value > 2147483647) {
      return null;
    }
  }
  return negative ? -value : value;
}

/** 单个 UTF-16 码元的实体还原；超出 0..0xFFFF 的码点一律不认（当成字面 `&`）。 */
function charFromCode(code: number): string | null {
  if (code < 0 || code > 0xFFFF) {
    return null;
  }
  return String.fromCharCode(code);
}

/**
 * HTML 实体的最小还原。
 *
 * 只覆盖真正常见的几个（`&amp;` 这类转义，以及 `&nbsp;`）—— 完整的实体表有 2000 多个，
 * 为了显示效果去引一整个库不值得；而 `&#123;` 这种数字实体在正文里偶尔出现，顺手支持。
 */
export function decodeHtmlEntities(raw: string): string {
  if (raw.indexOf('&') < 0) {
    return raw;
  }
  let out: string = '';
  let cursor: number = 0;
  while (cursor < raw.length) {
    const amp: number = raw.indexOf('&', cursor);
    if (amp < 0) {
      out += raw.substring(cursor);
      break;
    }
    out += raw.substring(cursor, amp);
    const semicolon: number = raw.indexOf(';', amp);
    // 实体名有长度上限；找不到分号就不是实体，当普通 & 处理。
    if (semicolon < 0 || semicolon - amp > 10) {
      out += '&';
      cursor = amp + 1;
      continue;
    }
    const body: string = raw.substring(amp + 1, semicolon);
    let resolved: string | null = null;
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code: number | null = intOrNull(body.substring(2), 16);
      resolved = code === null ? null : charFromCode(code);
    } else if (body.startsWith('#')) {
      const code: number | null = intOrNull(body.substring(1), 10);
      resolved = code === null ? null : charFromCode(code);
    } else if (body === 'amp') {
      resolved = '&';
    } else if (body === 'lt') {
      resolved = '<';
    } else if (body === 'gt') {
      resolved = '>';
    } else if (body === 'quot') {
      resolved = '"';
    } else if (body === 'apos') {
      resolved = "'";
    } else if (body === 'nbsp') {
      resolved = ' ';
    }
    if (resolved === null) {
      out += '&';
      cursor = amp + 1;
    } else {
      out += resolved;
      cursor = semicolon + 1;
    }
  }
  return out;
}
