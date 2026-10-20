/**
 * 行内文本的分段 —— 把 `[文字](链接)` 从正文里切出来，好让界面把它渲染成**可点的**链接。
 *
 * ## 为什么需要
 *
 * 本工程的 Markdown 渲染器是自研的（`core/MarkdownLite.ts` + `inlineMarkup`），
 * 而 `inlineMarkup` 会把链接**拍平成纯文字**（`[看这里](/abs/x.md)` → `看这里`）——
 * 渲染上没错，但链接就**点不动**了。源工程用 `com.mikepenz.markdown.m3`，
 * 链接天然带 `LinkAnnotation.Url`，再由 `ui/chat/ChatLinkHandlers.kt` 统一分流
 * （服务端绝对路径走 `openSessionFile`、http(s) 走浏览器、其余明确告知不支持）。
 *
 * 所以这里补的是「分段」这一环：界面拿到分段后，普通文字照旧、链接那段挂上点击。
 * 分流规则不在这里 —— 它由 `core/ChatLinkTarget.ts` 决定，界面只负责把 url 递过去。
 *
 * ## 为什么用「手写扫描」而不是正则
 *
 * 模式本身好写（`\[([^\]]*)\]\(([^)]*)\)`），但 ArkTS 侧分段的取法只有两条路：
 * 反复 `RegExp.exec` 记账 `lastIndex`，或 `split` 配捕获组。两条都依赖引擎细节，
 * 而这里的分段**必须逐字符还原原文**（少一个字符，正文就少一段）。手写扫描只用
 * `indexOf` / `substring`，行为完全可预期，还能顺手处理「半个链接」这种脏输入。
 *
 * ## 三条判据
 *
 * 1. **配对才算链接**：`[` 后面找不到 `](` 或收尾的 `)` 时，这个 `[` 只是普通字符 ——
 *    模型写到一半的括号（流式期间每帧都会出现）不该让后半段文字凭空消失。
 * 2. **标签里不许再出现方括号**：`[不完整 [real](u)` 这种情况，若按「第一个 `](`」配对，
 *    会把 `不完整 [real` 整段当成链接文字。宁可两者都不成链接。
 * 3. **图片按替代文字显示**：`![图](url)` 与 `inlineMarkup` 的处理保持一致（丢掉图片、留下
 *    替代文字）—— 本工程的 Markdown 渲染器没有内嵌图片能力，这条不是新决定，是沿用。
 * 4. **目标里的括号要配对**：`[文件](`/a/b(1).md`)` 这种是**本工程自己造出来的**
 *    （`linkifyKnownFiles` 会把带括号的文件名原样写进目标）——按「第一个 `)` 收尾」会截成
 *    `/a/b(1`，点开就必然找不到文件。所以从 `](` 之后做**括号计数**，配平到 0 才算结束。
 *
 * 普通文字段一律过 `inlineMarkup`（剥 `**` / `~~` / 反引号 / 斜体），所以分段后的显示文字
 * 与改造前**逐字相同** —— 这次改造只多出「链接那一小段可点」，不动任何排版。
 */

import { inlineMarkup } from './GenUiBlocks';

/** 一段行内文本是普通文字还是链接。 */
export enum InlineKind {
  TEXT = 'text',
  LINK = 'link',
}

/**
 * 一段行内文本。
 *
 * 用单一扁平类 + `kind` 判别（与 `ChatLinkTarget` / `PromptPart` 同一套写法），
 * 不用继承 —— ArkTS 严格模式下子类覆盖成员容易撞上语法歧义。
 */
export class InlineSegment {
  kind: InlineKind;
  /** 要显示的文字（普通文字段已剥标记，链接段是链接文字）。 */
  text: string;
  /** 链接目标；普通文字段是空串。 */
  url: string;

  constructor(kind: InlineKind = InlineKind.TEXT, text: string = '', url: string = '') {
    this.kind = kind;
    this.text = text;
    this.url = url;
  }

  static text(display: string): InlineSegment {
    return new InlineSegment(InlineKind.TEXT, display, '');
  }

  static link(display: string, url: string): InlineSegment {
    return new InlineSegment(InlineKind.LINK, display, url);
  }
}

/** 把一段普通文字过 `inlineMarkup` 后收进结果；空串直接丢掉（免得产生空 Span）。 */
function pushText(out: InlineSegment[], chunk: string): void {
  const text: string = inlineMarkup(chunk);
  if (text.length > 0) {
    out.push(InlineSegment.text(text));
  }
}

/**
 * 从 `](` 之后找目标的收尾位置（判据 4：括号要配平）。
 *
 * 返回 `)` 的下标；括号数收不回来（`[x](/a` 这种半截输入）返回 `-1`。
 */
function findUrlEnd(raw: string, from: number): number {
  let depth: number = 1;
  for (let i: number = from; i < raw.length; i++) {
    const ch: string = raw.charAt(i);
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

/** 把一个字符串切成「普通文字 / 链接」的有序分段（顺序即原文顺序）。 */
export function inlineSegments(raw: string): InlineSegment[] {
  const out: InlineSegment[] = [];
  let cursor: number = 0;
  while (cursor < raw.length) {
    const open: number = raw.indexOf('[', cursor);
    if (open < 0) {
      // 后面再没有 `[` 了：剩下的全是普通文字。
      pushText(out, raw.substring(cursor));
      break;
    }
    const close: number = raw.indexOf('](', open + 1);
    const end: number = close < 0 ? -1 : findUrlEnd(raw, close + 2);
    if (close < 0 || end < 0) {
      // 判据 1：没配对。这个 `[` 当普通字符，往前走一格继续找。
      pushText(out, raw.substring(cursor, open + 1));
      cursor = open + 1;
      continue;
    }
    const label: string = raw.substring(open + 1, close);
    if (label.indexOf('[') >= 0 || label.indexOf(']') >= 0) {
      // 判据 2：标签里还嵌着方括号 —— 说明上面那个 `](` 不属于这个 `[`。
      pushText(out, raw.substring(cursor, open + 1));
      cursor = open + 1;
      continue;
    }
    // 判据 3：`![...](...)` 是图片，按替代文字显示。
    const isImage: boolean = open > cursor && raw.charAt(open - 1) === '!';
    const url: string = raw.substring(close + 2, end);
    pushText(out, raw.substring(cursor, isImage ? open - 1 : open));
    if (isImage) {
      pushText(out, label);
    } else {
      // 链接文字也过一道 inlineMarkup：Span 只有一种样式，`**报告**` 这种标记若原样留下
      // 就会在屏幕上多出一对星号。剥完之后空了就退回目标本身（判据 5 的兜底）。
      const display: string = inlineMarkup(label);
      out.push(InlineSegment.link(display.length > 0 ? display : url, url));
    }
    cursor = end + 1;
  }
  return out;
}
