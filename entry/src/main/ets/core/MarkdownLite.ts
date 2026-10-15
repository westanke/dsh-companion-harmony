/**
 * 极简 Markdown **块级**切分 —— 源工程没有这个文件，是移植时新增的。
 *
 * 为什么必须新增：原工程助手正文交给第三方库 `com.mikepenz.markdown.m3` 渲染，
 * 那是 Android 专有的 Compose 组件；ArkUI 没有等价物（`@ohos.*` 里没有任何
 * Markdown 解析能力，自绘一个完整 CommonMark 解析器不在本次范围内）。
 *
 * 于是这里只做**块级**切分，把正文切成「标题 / 列表项 / 引用 / 代码块 / 表格 /
 * 分隔线 / 段落」，由界面按块给字号、缩进与等宽字体。行内标记（`**粗体**`、
 * `` `代码` ``、`[文字](链接)`）交给 `GenUiBlocks.inlineMarkup` 统一剥掉 ——
 * 那一份实现已经在用，不重复造。
 *
 * ## 表格：移植时的口径修正
 *
 * 早期这版**刻意不解析表格**，理由是「手机上没有可读的宽表格」。真机反馈推翻了这个
 * 判断：会话里表格出现得不少（工具输出、文件内容摘要都在用），不画表格的结果是整块
 * 竖线裸文本，比窄表格难读得多。现在的口径是 —— **能画就画，画不下就横向滚**：
 * 列宽按内容估算（`markdownTableColumnWidths`），总宽超出屏宽时由界面套一层横向
 * `Scroll`，与 dsh-ui 卡片里的表格（`GenUiCard.tableView`）同一套做法。
 *
 * ## 其余两条刻意的不做
 *
 * 1. **段落内不把换行并成空格**（CommonMark 的软换行规则）。用户写中文时常一行一句、
 *    行间不留空行，并成空格会在中文里插出多余空格。保留原换行更贴近他打出来的样子。
 * 2. **不做嵌套**（列表里套列表、引用里套列表）。目前真实会话里没有这种形态，
 *    猜错了反而会把层级拍平得更难看。
 *
 * 判据抽在这里并且单测，理由与工程里其它 `core/*` 一致：块级切分错的表现是
 * 「屏幕上排版怪怪的」，肉眼很难说清是哪一条错了。
 */

import { isBlank, trimText } from './TextPredicates';

export enum MdBlockKind {
  HEADING = 'HEADING',
  BULLET = 'BULLET',
  ORDERED = 'ORDERED',
  QUOTE = 'QUOTE',
  CODE = 'CODE',
  TABLE = 'TABLE',
  HR = 'HR',
  PARAGRAPH = 'PARAGRAPH',
}

/**
 * 一张 GFM 表格的原始内容。
 *
 * `header` 是表头各列的文字，`rows` 是数据行（每行是一个 cell 数组）。**行长度不齐**
 * 是刻意保留的：引擎（与真实的服务端输出）会写出列数少几格的行，渲染时按表头列数
 * 取、缺的补空，比在这里截齐更能暴露「数据本来就不齐」这个事实。
 */
export class MdTable {
  header: string[];
  rows: string[][];

  constructor(header: string[], rows: string[][]) {
    this.header = header;
    this.rows = rows;
  }
}

/**
 * 一个块。
 *
 * 用「单一扁平类 + `kind` 判别」而不是多个子类 —— 与 `MessageSegment` /
 * `PromptPart` / `ChatLinkTarget` 的既定写法一致，规避 ArkTS 的继承覆盖语法歧义。
 */
export class MdBlock {
  kind: MdBlockKind;
  text: string;
  /** 标题层级（1..6）；非标题为 0。 */
  level: number;
  /** 有序列表项的序号（1 起）；非有序项为 0。 */
  ordinal: number;
  /** 代码块的语言标记（围栏后的那段文字，可能为空）。 */
  lang: string;
  /** 表格内容；`kind === TABLE` 时非空，其余块恒为 null。 */
  table: MdTable | null;

  constructor(kind: MdBlockKind, text: string = '', level: number = 0, ordinal: number = 0,
    lang: string = '', table: MdTable | null = null) {
    this.kind = kind;
    this.text = text;
    this.level = level;
    this.ordinal = ordinal;
    this.lang = lang;
    this.table = table;
  }
}

/** ATX 标题最多 6 级（`#######` 是普通段落）。 */
const MAX_HEADING_LEVEL: number = 6;

/** 把带 `\r\n` / `\r` / `\n` 的正文切成行；末尾空行照原样保留（块级解析不依赖它）。 */
function splitLines(body: string): string[] {
  return body.split(/\r\n|\r|\n/);
}

/** 标题：`#` 到 `######` 后必须跟空白（`#hashtag` 不是标题）。 */
function headingLevelOf(line: string): number {
  const trimmed: string = trimText(line);
  let hashes: number = 0;
  while (hashes < trimmed.length && trimmed.charAt(hashes) === '#') {
    hashes++;
  }
  if (hashes === 0 || hashes > MAX_HEADING_LEVEL) {
    return 0;
  }
  const next: string = hashes < trimmed.length ? trimmed.charAt(hashes) : '';
  if (next !== ' ' && next !== '\t') {
    return 0;
  }
  return hashes;
}

/** 列表项标记的长度（`- ` / `* ` / `+ ` 各 1 字符）；不是列表项返回 0。 */
function bulletMarkerLength(line: string): number {
  const trimmed: string = trimText(line);
  if (trimmed.length < 2) {
    return 0;
  }
  const first: string = trimmed.charAt(0);
  const second: string = trimmed.charAt(1);
  if ((first === '-' || first === '*' || first === '+') && (second === ' ' || second === '\t')) {
    return 1;
  }
  return 0;
}

/**
 * 有序列表项：`1. ` / `1) `。
 *
 * 只认 9 位以内的数字（防止把 `20260101.5 亿` 这种正文当成列表项），
 * 且数字必须以 1 开头 —— CommonMark 允许任意起始号，但会话正文里出现「从 37. 开始」
 * 的列表几乎只能是误判。
 */
function orderedMarkerLength(line: string): number {
  const trimmed: string = trimText(line);
  let digits: number = 0;
  while (digits < trimmed.length && digits < 9 && isDigit(trimmed.charAt(digits))) {
    digits++;
  }
  if (digits === 0 || digits >= trimmed.length) {
    return 0;
  }
  if (trimmed.charAt(0) !== '1') {
    return 0;
  }
  const mark: string = trimmed.charAt(digits);
  if (mark !== '.' && mark !== ')') {
    return 0;
  }
  const after: string = digits + 1 < trimmed.length ? trimmed.charAt(digits + 1) : '';
  if (after !== ' ' && after !== '\t') {
    return 0;
  }
  return digits + 1;
}

function isDigit(ch: string): boolean {
  return ch.length === 1 && ch >= '0' && ch <= '9';
}

/** 引用：行首的 `>`（后面可跟一个空格）。 */
function quotePrefixLength(line: string): number {
  const trimmed: string = trimText(line);
  if (trimmed.length === 0 || trimmed.charAt(0) !== '>') {
    return 0;
  }
  return trimmed.length > 1 && trimmed.charAt(1) === ' ' ? 2 : 1;
}

/** 围栏头：` ``` ` 开头的行；返回信息串（```` ```json ```` 里就是 `json`）。 */
function fenceLangOf(line: string): string | null {
  const trimmed: string = trimText(line);
  if (!trimmed.startsWith('```')) {
    return null;
  }
  return trimText(trimmed.substring(3));
}

/**
 * 分隔线：整行只有 `-` / `*` / `_`（允许夹空格）且同一种字符至少三个。
 *
 * **必须在列表项判定之前跑**：`- - -` 会被 `bulletMarkerLength` 认成「短横线开头的列表项」，
 * 而 CommonMark 里它是分隔线。判据本身把混合字符排除（`-*-` 不算），所以
 * 「`- 正文`」这种真正的列表项不会被误吃。
 */
function isThematicBreak(line: string): boolean {
  const trimmed: string = trimText(line);
  if (trimmed.length < 3) {
    return false;
  }
  let dashes: number = 0;
  let stars: number = 0;
  let underscores: number = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const ch: string = trimmed.charAt(i);
    if (ch === '-') {
      dashes++;
    } else if (ch === '*') {
      stars++;
    } else if (ch === '_') {
      underscores++;
    } else if (ch !== ' ') {
      return false;
    }
  }
  return dashes >= 3 || stars >= 3 || underscores >= 3;
}

/**
 * 把一行表格切成一格一格；不是表格行返回 null。
 *
 * 只要求「含一个 `|`」。首尾那个空段（`| a |` 拆出来的第一、最后一段）丢掉，
 * 于是 `| a | b |` 与 `a | b` 两种写法切出来一样 —— 真实输出里两种都有。
 */
function tableRowCells(line: string): string[] | null {
  const trimmed: string = trimText(line);
  if (trimmed.length === 0 || trimmed.indexOf('|') < 0) {
    return null;
  }
  const parts: string[] = trimmed.split('|');
  const cells: string[] = [];
  const last: number = parts.length - 1;
  for (let i = 0; i <= last; i++) {
    const cell: string = trimText(parts[i]);
    // 段落里恰好出现一个 `|` 时（`a | b`）首段是有内容的，不能丢；
    // 只有「写在两边当边框」的那种空段才丢。
    if ((i === 0 || i === last) && cell.length === 0) {
      continue;
    }
    cells.push(cell);
  }
  return cells.length > 0 ? cells : null;
}

/** 分隔行的一格：`:?---+:?`（GFM 只要求至少一个横线，列对齐的冒号可有可无）。 */
function isDelimiterCell(cell: string): boolean {
  let body: string = cell;
  if (body.startsWith(':')) {
    body = body.substring(1);
  }
  if (body.endsWith(':')) {
    body = body.substring(0, body.length - 1);
  }
  if (body.length === 0) {
    return false;
  }
  for (let i = 0; i < body.length; i++) {
    if (body.charAt(i) !== '-') {
      return false;
    }
  }
  return true;
}

/** 分隔行：每一格都是 `---` / `:---:` 这种；返回列数，不是分隔行返回 0。 */
function tableDelimiterColumns(line: string): number {
  const cells: string[] | null = tableRowCells(line);
  if (cells === null) {
    return 0;
  }
  for (let i = 0; i < cells.length; i++) {
    if (!isDelimiterCell(cells[i])) {
      return 0;
    }
  }
  return cells.length;
}

/** Markdown 表格列宽的兜底下限（vp）—— 再窄一列就只剩省略号，横向滚反而更好读。 */
export const MARKDOWN_TABLE_MIN_COLUMN_VP: number = 64;

/** 单列上限（vp）：不然一个长句会把整张表撑成横向无限滚。超宽的文字在列内折行。 */
export const MARKDOWN_TABLE_MAX_COLUMN_VP: number = 240;

/** 单元格左右内边距（vp），与渲染层的 `padding(8)` 对齐。 */
export const MARKDOWN_TABLE_CELL_PADDING_VP: number = 16;

/**
 * 一个字符占多少「字宽」：全角 1，西文 0.60。
 *
 * 只用来估列宽，不求精确 —— 汉字几乎都是正方形、西文接近半宽，这个比例足够挑出
 * 「这一列该给两格还是二十格」。真正的排版交给 Text 自己折行。
 *
 * 西文取 0.60 而非更小的 0.55：0.55 在真机上贴边到被反噬 —— 系统比例字体下小写
 * 字母平均约 0.55~0.58 em，`bundleName` 这类长标识符估出的列宽恰好比实际渲染宽度
 * 窄几个像素，于是被强制在词内断开（屏幕上显示成 `bundleNam` / `e`）。留约 8% 余量
 * 才能稳定「整格折行、单词不断」这个目标。
 */
function charWidthUnit(ch: string): number {
  const code: number = ch.charCodeAt(0);
  const wide: boolean = (code >= 0x1100 && code <= 0x115f)
    || code === 0x2329 || code === 0x232a
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6);
  return wide ? 1 : 0.60;
}

function displayWidthUnits(text: string): number {
  let units: number = 0;
  for (let i = 0; i < text.length; i++) {
    units += charWidthUnit(text.charAt(i));
  }
  return units;
}

/**
 * 每列该占多宽（vp）：取「表头 + 全部数据行」里最长的那一格估算，夹在上下限之间。
 *
 * 传入的是**已经去掉行内标记的显示文字**（界面先过一遍 `inlineMarkup` 再调这里）——
 * 否则 `[文字](很长的链接)` 里那段链接会把列宽抬到上限，整张表变得又空又宽。
 * 这个函数因此不认识 `**` / `` ` `` / `[...](...)`，那是调用方的责任。
 *
 * 表头与正文**字号不同**（表头略大，见 `ChatMessage.tableView`），所以两边分别估算再
 * 取大：只按正文字号算会让长表头那格偏窄，表头照样被折断 —— 与上一轮修的是同一类错。
 * 不传 `headerFontSizeVp`（0）时按正文字号处理，兼容只关心正文的调用方。
 *
 * 空表返回空数组；列宽恒 ≥ 下限，所以调用方不必再兜底。
 */
export function markdownTableColumnWidths(header: string[], rows: string[][],
  fontSizeVp: number, headerFontSizeVp: number = 0): number[] {
  const headerSize: number = headerFontSizeVp > 0 ? headerFontSizeVp : fontSizeVp;
  const widths: number[] = [];
  const columns: number = header.length;
  for (let c = 0; c < columns; c++) {
    const headerUnits: number = displayWidthUnits(header[c]);
    let bodyUnits: number = 0;
    for (let r = 0; r < rows.length; r++) {
      const row: string[] = rows[r];
      if (c < row.length) {
        const cell: number = displayWidthUnits(row[c]);
        if (cell > bodyUnits) {
          bodyUnits = cell;
        }
      }
    }
    const headerEstimate: number = headerUnits * headerSize;
    const bodyEstimate: number = bodyUnits * fontSizeVp;
    const estimated: number = (headerEstimate > bodyEstimate ? headerEstimate : bodyEstimate)
      + MARKDOWN_TABLE_CELL_PADDING_VP;
    let width: number = estimated;
    if (width < MARKDOWN_TABLE_MIN_COLUMN_VP) {
      width = MARKDOWN_TABLE_MIN_COLUMN_VP;
    } else if (width > MARKDOWN_TABLE_MAX_COLUMN_VP) {
      width = MARKDOWN_TABLE_MAX_COLUMN_VP;
    }
    widths.push(Math.round(width));
  }
  return widths;
}

/**
 * 把正文切成块。
 *
 * 状态机很浅，只有两处「攒着」：段落行缓冲与代码块行缓冲；表格是第三种「一次吃掉
 * 多行」的块。之所以不用正则一次性替换，是因为代码块里的内容**必须原样透传** ——
 * 一段 ``` 里出现 `# 注释`（Python/shell）或 `- item`（diff）时，任何二次解析都会把
 * 它变成标题或列表。
 */
export function markdownBlocks(body: string): MdBlock[] {
  const out: MdBlock[] = [];
  const lines: string[] = splitLines(body);
  let paragraph: string[] = [];
  let orderedRun: number = 0;
  let index: number = 0;

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      out.push(new MdBlock(MdBlockKind.PARAGRAPH, paragraph.join('\n')));
      paragraph = [];
    }
  };

  while (index < lines.length) {
    const line: string = lines[index];

    if (isBlank(line)) {
      flushParagraph();
      orderedRun = 0;
      index++;
      continue;
    }

    const lang: string | null = fenceLangOf(line);
    if (lang !== null) {
      flushParagraph();
      orderedRun = 0;
      index++;
      const code: string[] = [];
      while (index < lines.length) {
        if (fenceLangOf(lines[index]) !== null) {
          index++;
          break;
        }
        code.push(lines[index]);
        index++;
      }
      // 未闭合也照样成块：流式输出期间围栏还没写完，此时把已到的内容按等宽显示
      // 最接近最终形态；围栏头那一行**不**并进正文（否则代码块里会多出一行 ```）。
      const text: string = code.join('\n');
      out.push(new MdBlock(MdBlockKind.CODE, text, 0, 0, lang));
      continue;
    }

    const level: number = headingLevelOf(line);
    if (level > 0) {
      flushParagraph();
      orderedRun = 0;
      const trimmed: string = trimText(line);
      out.push(new MdBlock(MdBlockKind.HEADING, trimText(trimmed.substring(level)), level));
      index++;
      continue;
    }

    // 表格：本行含 `|` **且**下一行是分隔行，才认。这个「下一行」条件是硬闸门 ——
    // 正文里单独出现一个竖线（`a | b`、命令行管道）太常见，少一道检查就会把整段吃掉。
    const headerCells: string[] | null = tableRowCells(line);
    if (headerCells !== null && index + 1 < lines.length
      && tableDelimiterColumns(lines[index + 1]) > 0) {
      flushParagraph();
      orderedRun = 0;
      const rows: string[][] = [];
      index += 2;
      // 数据行直到空行或首个不含 `|` 的行；整行原样切，列数不齐留给渲染层补空。
      while (index < lines.length && !isBlank(lines[index])) {
        const cells: string[] | null = tableRowCells(lines[index]);
        if (cells === null) {
          break;
        }
        rows.push(cells);
        index++;
      }
      out.push(new MdBlock(MdBlockKind.TABLE, '', 0, 0, '', new MdTable(headerCells, rows)));
      continue;
    }

    if (isThematicBreak(line)) {
      flushParagraph();
      orderedRun = 0;
      out.push(new MdBlock(MdBlockKind.HR));
      index++;
      continue;
    }

    const quote: number = quotePrefixLength(line);
    if (quote > 0) {
      flushParagraph();
      orderedRun = 0;
      const trimmed: string = trimText(line);
      out.push(new MdBlock(MdBlockKind.QUOTE, trimText(trimmed.substring(quote))));
      index++;
      continue;
    }

    const bullet: number = bulletMarkerLength(line);
    if (bullet > 0) {
      flushParagraph();
      orderedRun = 0;
      const trimmed: string = trimText(line);
      out.push(new MdBlock(MdBlockKind.BULLET, trimText(trimmed.substring(bullet))));
      index++;
      continue;
    }

    const ordered: number = orderedMarkerLength(line);
    if (ordered > 0) {
      flushParagraph();
      orderedRun++;
      const trimmed: string = trimText(line);
      out.push(new MdBlock(MdBlockKind.ORDERED, trimText(trimmed.substring(ordered)), 0, orderedRun));
      index++;
      continue;
    }

    orderedRun = 0;
    paragraph.push(line);
    index++;
  }

  flushParagraph();
  return out;
}
