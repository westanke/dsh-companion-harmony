/**
 * 代码块 / 工具输出的轻量高亮（零依赖）—— 移植自原工程 `ui/chat/ChatCodeHighlight.kt`（460 行）。
 *
 * ## 为什么自己写而不是引库
 *
 * 本工程的工具调用参数与结果几乎全是 JSON，围栏代码块也以 JSON / Shell / Kotlin 为主。
 * 为这几种语言引一套语法高亮依赖，换来的包体积与构建复杂度都不划算，所以只做两件事：
 * JSON 单遍扫描 + 通用关键字规则。
 *
 * ## 为什么 JSON 用字符扫描而不是正则
 *
 * 「后一个非空白字符是冒号」在正则里只能写成前视断言；而按「非捕获组 + 星号」处理
 * 字符串字面量（`"(?:\\.|[^"\\])*"`）靠**递归**实现重复组，长串字面量会直接爆栈 ——
 * 源工程在 JVM 上实测 20 万字符的字符串/`"\"` 重复都抛 `StackOverflowError`。
 * 单遍扫描天然 O(n) 且无回溯，顺手把「字符串里的冒号不算键」这类边界一次写清楚。
 *
 * 同一条理由把**块注释**也从正则改成了扫描：碰上「开了块注释却没闭合」的输入
 * （流式输出的常态），懒惰匹配的正则每个起点都要一路扫到串尾，20 万字符下就是 O(n²)。
 *
 * ## 契约
 *
 * `codeSegments(code, spans)` 拼出来的文本与入参**逐字符一致** —— 只加样式，不改字符、
 * 不 trim、不补换行。界面按原文排版与复制，这里动一个字符，行号与剪贴板内容就全歪了。
 *
 * 认不出的语言标签一律返回**无样式**（空 span 列表），不抛异常：围栏标签是模型写的
 * 自由文本，高亮失败绝不能连累消息渲染。
 *
 * ## 与安卓版的差异
 *
 * 原工程直接返回 `AnnotatedString`（Compose 专有）；ArkTS 侧没有等价类型，
 * 所以这里返回**半开区间 `[start, endExclusive)` 的 span 列表**，由界面（`ui/ChatStatusBar` /
 * `ui/MarkdownView`）把每个区间包成 `Span` 子组件上色。核心逻辑（扫什么、谁遮谁）
 * 与源工程一字不差，色板则挪到了界面层 —— 颜色是主题的职责，`core/` 不碰平台 API。
 */

/** 一段着色区间的语义类别。界面按类别映射到具体颜色。 */
export enum CodeTokenKind {
  /** 语言关键字（`if` / `fun` / `class`…）。 */
  KEYWORD = 'KEYWORD',
  /** 字符串字面量（含引号本身）。 */
  STRING = 'STRING',
  /** 数字（含负号与小数点）。 */
  NUMBER = 'NUMBER',
  /** JSON 的字面量 `true` / `false` / `null`。 */
  LITERAL = 'LITERAL',
  /** JSON 的键：与 KEYWORD 分开是一个类别，将来想调成两种颜色不必改这里。 */
  KEY = 'KEY',
  /** 注释。 */
  COMMENT = 'COMMENT',
  /** 无样式（只在 `codeSegments` 产出的分段里出现，`highlightCode` 不会返回它）。 */
  PLAIN = 'PLAIN',
}

/**
 * 一段候选样式，`[start, endExclusive)` 半开区间。
 *
 * `priority` 只用于**同起点**时的排序，越小越优先（见 `pickNonOverlapping`）。
 */
export class CodeSpan {
  start: number;
  endExclusive: number;
  kind: CodeTokenKind;
  priority: number;

  constructor(start: number, endExclusive: number, kind: CodeTokenKind, priority: number) {
    this.start = start;
    this.endExclusive = endExclusive;
    this.kind = kind;
    this.priority = priority;
  }

  length(): number {
    return this.endExclusive - this.start;
  }
}

/** 字符串最优先：`"// 不是注释"` 里注释规则也会命中，不能让它赢。 */
const PRIORITY_STRING: number = 0;

/** 注释次之：注释里出现的关键字不该亮。 */
const PRIORITY_COMMENT: number = 1;

/** 关键字 / 标签名 / JSON 字面量再次。 */
const PRIORITY_KEYWORD: number = 2;

/** 数字最低：`1e5` 这类被字符串/注释包住的数字要让位。 */
const PRIORITY_NUMBER: number = 3;

/** JSON 的三种字面量。 */
const JSON_LITERALS: string[] = ['true', 'false', 'null'];

// ── 语言规则表 ─────────────────────────────────────────────────────────────

/**
 * 通用规则的参数。
 *
 * `hashComments`：`#` 注释只属于部分语言 —— CSS 的 `#fff` 是颜色值，误判成注释会让
 * 色值整段变灰，所以按语言开关而不是全局启用。
 * `tagNames`：HTML/XML 里真正该亮的是标签名，而不是通用关键字（`class` 这种在标记语言里
 * 只是属性名），所以这一类走标签名规则、跳过关键字集合。
 */
class LanguageRule {
  keywords: string[];
  ignoreCase: boolean;
  hashComments: boolean;
  tagNames: boolean;

  constructor(keywords: string[] = [], ignoreCase: boolean = false,
    hashComments: boolean = false, tagNames: boolean = false) {
    this.keywords = keywords;
    this.ignoreCase = ignoreCase;
    this.hashComments = hashComments;
    this.tagNames = tagNames;
  }
}

const KOTLIN_KEYWORDS: string[] = [
  'fun', 'val', 'var', 'if', 'else', 'when', 'for', 'while', 'do', 'return', 'break',
  'continue', 'class', 'interface', 'object', 'data', 'sealed', 'enum', 'annotation',
  'companion', 'init', 'constructor', 'this', 'super', 'import', 'package', 'is', 'as',
  'in', 'out', 'by', 'where', 'try', 'catch', 'finally', 'throw', 'typealias', 'suspend',
  'inline', 'noinline', 'crossinline', 'reified', 'tailrec', 'operator', 'infix', 'override',
  'open', 'abstract', 'internal', 'private', 'protected', 'public', 'lateinit', 'const',
  'external', 'actual', 'expect', 'vararg', 'dynamic', 'null', 'true', 'false',
];

const JAVA_KEYWORDS: string[] = [
  'class', 'interface', 'enum', 'extends', 'implements', 'public', 'private', 'protected',
  'static', 'final', 'abstract', 'void', 'int', 'long', 'double', 'float', 'boolean', 'char',
  'byte', 'short', 'new', 'this', 'super', 'if', 'else', 'switch', 'case', 'default', 'for',
  'while', 'do', 'break', 'continue', 'return', 'try', 'catch', 'finally', 'throw', 'throws',
  'import', 'package', 'instanceof', 'synchronized', 'volatile', 'transient', 'native',
  'strictfp', 'assert', 'null', 'true', 'false', 'var', 'record', 'sealed', 'permits', 'yield',
];

/**
 * JS/TS 关键字。刻意**不收** `string` / `number` / `boolean` 这类型别名：
 * 在 JS 里它们是常见的变量名，收进来会把普通变量点亮成关键字。
 */
const JS_KEYWORDS: string[] = [
  'function', 'var', 'let', 'const', 'if', 'else', 'for', 'while', 'do', 'switch', 'case',
  'default', 'break', 'continue', 'return', 'class', 'extends', 'super', 'new', 'this',
  'typeof', 'instanceof', 'delete', 'in', 'of', 'void', 'yield', 'async', 'await', 'try',
  'catch', 'finally', 'throw', 'import', 'export', 'from', 'as', 'static', 'get', 'set',
  'interface', 'type', 'enum', 'implements', 'public', 'private', 'protected', 'readonly',
  'declare', 'namespace', 'abstract', 'null', 'undefined', 'true', 'false', 'keyof', 'infer',
  'satisfies', 'never', 'unknown',
];

/** 含少量约定俗成的内建名（`print` / `self`）：它们在 Python 代码里就是「会亮」的那类词。 */
const PYTHON_KEYWORDS: string[] = [
  'def', 'class', 'if', 'elif', 'else', 'for', 'while', 'return', 'yield', 'lambda', 'import',
  'from', 'as', 'with', 'try', 'except', 'finally', 'raise', 'pass', 'break', 'continue', 'in',
  'is', 'not', 'and', 'or', 'None', 'True', 'False', 'global', 'nonlocal', 'del', 'assert',
  'async', 'await', 'match', 'case', 'self', 'print',
];

/** Shell 的 `if` / `fi` / `done` 大小写都合法，所以这条规则忽略大小写。 */
const SHELL_KEYWORDS: string[] = [
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac',
  'in', 'function', 'select', 'time', 'return', 'break', 'continue', 'local', 'export',
  'readonly', 'declare', 'typeset', 'unset', 'shift', 'eval', 'exec', 'exit', 'source',
  'alias', 'set', 'echo', 'printf', 'read', 'trap', 'wait', 'kill', 'test', 'true', 'false',
  'sudo',
];

const YAML_KEYWORDS: string[] = ['true', 'false', 'null', 'yes', 'no', 'on', 'off'];

const CSS_KEYWORDS: string[] = [
  'display', 'position', 'margin', 'padding', 'border', 'color', 'background', 'font', 'width',
  'height', 'flex', 'grid', 'none', 'block', 'inline', 'absolute', 'relative', 'fixed',
  'sticky', 'important', 'media', 'import', 'keyframes', 'transform', 'transition', 'animation',
  'opacity', 'content', 'auto', 'inherit', 'initial', 'unset', 'calc', 'var', 'rgba', 'rgb',
  'hsl', 'url', 'top', 'left', 'right', 'bottom',
];

/**
 * 语言标签 → 规则。标签先做「去空白 + 小写」归一化；
 * 表里没有的一律按认不出来处理（返回无样式），所以这张表就是支持范围本身。
 */
interface LanguageRuleEntry {
  label: string;
  rule: LanguageRule;
}

function buildLanguageRules(): LanguageRuleEntry[] {
  const kotlin: LanguageRule = new LanguageRule(KOTLIN_KEYWORDS);
  const java: LanguageRule = new LanguageRule(JAVA_KEYWORDS);
  const script: LanguageRule = new LanguageRule(JS_KEYWORDS);
  const python: LanguageRule = new LanguageRule(PYTHON_KEYWORDS, false, true, false);
  const shell: LanguageRule = new LanguageRule(SHELL_KEYWORDS, true, true, false);
  const yaml: LanguageRule = new LanguageRule(YAML_KEYWORDS, false, true, false);
  const markup: LanguageRule = new LanguageRule([], false, false, true);
  const css: LanguageRule = new LanguageRule(CSS_KEYWORDS);
  return [
    { label: 'kotlin', rule: kotlin }, { label: 'kt', rule: kotlin }, { label: 'kts', rule: kotlin },
    { label: 'java', rule: java },
    { label: 'js', rule: script }, { label: 'ts', rule: script },
    { label: 'python', rule: python }, { label: 'py', rule: python },
    { label: 'shell', rule: shell }, { label: 'sh', rule: shell }, { label: 'bash', rule: shell },
    { label: 'yaml', rule: yaml }, { label: 'yml', rule: yaml },
    { label: 'xml', rule: markup }, { label: 'html', rule: markup },
    { label: 'css', rule: css },
  ];
}

const LANGUAGE_RULES: LanguageRuleEntry[] = buildLanguageRules();

function ruleFor(label: string): LanguageRule | null {
  for (let i = 0; i < LANGUAGE_RULES.length; i++) {
    if (LANGUAGE_RULES[i].label === label) {
      return LANGUAGE_RULES[i].rule;
    }
  }
  return null;
}

// ── 对外入口 ───────────────────────────────────────────────────────────────

/**
 * 给 `code` 算出着色区间；围栏语言标签为 `language`（可为空串或 null）。
 * 返回的区间**互不重叠且按起点升序**，认不出的语言返回空数组。
 */
export function highlightCode(code: string, language: string | null): CodeSpan[] {
  if (code.length === 0) {
    return [];
  }

  // 不带 Locale 的小写：土耳其语环境下 "I" 会被折成 "ı"，语言标签就认不出来了。
  const label: string = language === null ? '' : language.trim().toLowerCase();
  if (label === 'json') {
    return jsonSpans(code);
  }
  if (label.length === 0) {
    // 标签为空时「猜」一次：工具结果十有八九是裸 JSON，而空标签在围栏里很常见。
    return looksLikeJson(code) ? jsonSpans(code) : [];
  }
  const rule: LanguageRule | null = ruleFor(label);
  return rule === null ? [] : genericSpans(code, rule);
}

/**
 * 内容是否「看起来像 JSON」：去掉首尾空白后，以 `{`/`[` 开头且以 `}`/`]` 结尾。
 *
 * 为什么用这个粗糙判据：这里只决定要不要**尝试** JSON 规则，扫出来的东西本来就是
 * 尽力而为；引 JSON 解析器反而会把这个纯函数变成「可能抛异常」的函数，
 * 也会把「畸形 JSON 照样渲染」这条底线搭进去。
 */
export function looksLikeJson(code: string): boolean {
  let first: number = 0;
  while (first < code.length && isWhitespace(code.charAt(first))) {
    first++;
  }
  if (first >= code.length) {
    return false;
  }
  let last: number = code.length - 1;
  while (last >= 0 && isWhitespace(code.charAt(last))) {
    last--;
  }
  const open: string = code.charAt(first);
  const close: string = code.charAt(last);
  return (open === '{' || open === '[') && (close === '}' || close === ']');
}

/** 一段带样式的文本（界面直接照着生成 `Span` 子组件）。 */
export class CodeSegment {
  text: string;
  kind: CodeTokenKind;

  constructor(text: string, kind: CodeTokenKind) {
    this.text = text;
    this.kind = kind;
  }
}

/**
 * 把区间列表摊回「一段段文字 + 类别」。
 *
 * 未着色的空隙补成 `PLAIN` 段；拼起来必须**逐字符等于**入参 `code`（见文件头契约）。
 */
export function codeSegments(code: string, spans: CodeSpan[]): CodeSegment[] {
  const out: CodeSegment[] = [];
  let cursor: number = 0;
  for (let i = 0; i < spans.length; i++) {
    const span: CodeSpan = spans[i];
    if (span.start > cursor) {
      out.push(new CodeSegment(code.substring(cursor, span.start), CodeTokenKind.PLAIN));
    }
    out.push(new CodeSegment(code.substring(span.start, span.endExclusive), span.kind));
    cursor = span.endExclusive;
  }
  if (cursor < code.length) {
    out.push(new CodeSegment(code.substring(cursor), CodeTokenKind.PLAIN));
  }
  return out;
}

// ── JSON：单遍字符扫描 ─────────────────────────────────────────────────────

/**
 * JSON 只认四类：键、字符串、数字、字面量。
 *
 * 键与值的区别只看「字符串之后第一个非空白字符是不是冒号」—— 扫描时顺手看一眼即可，
 * 既不需要前视断言，也不需要先建语法树。
 */
function jsonSpans(code: string): CodeSpan[] {
  const spans: CodeSpan[] = [];
  let i: number = 0;
  while (i < code.length) {
    const c: string = code.charAt(i);
    if (c === '"') {
      const end: number = stringEnd(code, i, '"');
      const kind: CodeTokenKind =
        nextSignificant(code, end) === ':' ? CodeTokenKind.KEY : CodeTokenKind.STRING;
      spans.push(new CodeSpan(i, end, kind, PRIORITY_STRING));
      i = end;
    } else if (c === '-' || isDigit(c)) {
      const end: number = numberEnd(code, i);
      const before: string = i === 0 ? ' ' : code.charAt(i - 1);
      const after: string = end < code.length ? code.charAt(end) : ' ';
      // 两侧都要是词边界：`1e` / `12abc` 这种畸形片段不按数字着色，避免半截变色。
      if (end > i && !isIdentifierPart(before) && !isIdentifierPart(after)) {
        spans.push(new CodeSpan(i, end, CodeTokenKind.NUMBER, PRIORITY_NUMBER));
        i = end;
      } else {
        i++;
      }
    } else if (c === 't' || c === 'f' || c === 'n') {
      const end: number = literalEnd(code, i);
      if (end > i) {
        spans.push(new CodeSpan(i, end, CodeTokenKind.LITERAL, PRIORITY_KEYWORD));
        i = end;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }
  return spans;
}

/**
 * 从 `start` 处的引号扫到配对的闭引号之后；没找到闭引号就停在行尾（或串尾）。
 *
 * 未闭合必须能返回（而不是报错）：流式输出的半截字符串每一帧都会被送到这里。
 * 停在**行尾**而不是串尾，是为了不让一个落单的引号把后面几十行代码全吞进字符串 ——
 * 那会让整段代码失去高亮，比不着色更糟。
 */
function stringEnd(code: string, start: number, quote: string): number {
  let j: number = start + 1;
  while (j < code.length) {
    const c: string = code.charAt(j);
    // 反斜杠转义：连同被转义的字符一起跳掉，所以 `\"` 不会提前结束字符串。
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === quote) {
      return j + 1;
    }
    if (c === '\n') {
      return j;
    }
    j++;
  }
  return code.length;
}

/**
 * 通用代码里的字符串：单遍扫描，双引号与单引号各来一遍。
 *
 * 为什么不写 `"(?:\\.|[^"\\])*"` 那条正则：它不违反「禁后向断言」的字面规定，
 * 但**实测会爆栈** —— 重复组靠递归实现，长字符串字面量在 JVM 上抛 `StackOverflowError`，
 * 而流式输出送来的半截长字符串恰好是那个形状。
 */
function quotedSpans(code: string, quote: string): CodeSpan[] {
  const spans: CodeSpan[] = [];
  let i: number = 0;
  while (i < code.length) {
    if (code.charAt(i) !== quote) {
      i++;
      continue;
    }
    const end: number = stringEnd(code, i, quote);
    spans.push(new CodeSpan(i, end, CodeTokenKind.STRING, PRIORITY_STRING));
    i = end;
  }
  return spans;
}

/** 返回 `from` 之后第一个非空白字符；到串尾返回 NUL（与 `:` 永不相等，省掉可空判断）。 */
function nextSignificant(code: string, from: number): string {
  let j: number = from;
  while (j < code.length && isWhitespace(code.charAt(j))) {
    j++;
  }
  return j < code.length ? code.charAt(j) : '\u0000';
}

/** 扫一个 JSON 数字（含负号、小数、指数）；不是数字（如孤立的 `-`）时返回 `start`。 */
function numberEnd(code: string, start: number): number {
  let j: number = start;
  if (code.charAt(j) === '-') {
    j++;
  }
  const intFrom: number = j;
  while (j < code.length && isDigit(code.charAt(j))) {
    j++;
  }
  if (j === intFrom) {
    return start;
  }

  if (j + 1 < code.length && code.charAt(j) === '.' && isDigit(code.charAt(j + 1))) {
    j++;
    while (j < code.length && isDigit(code.charAt(j))) {
      j++;
    }
  }
  if (j < code.length && (code.charAt(j) === 'e' || code.charAt(j) === 'E')) {
    let k: number = j + 1;
    if (k < code.length && (code.charAt(k) === '+' || code.charAt(k) === '-')) {
      k++;
    }
    const expFrom: number = k;
    while (k < code.length && isDigit(code.charAt(k))) {
      k++;
    }
    if (k > expFrom) {
      j = k;
    }
  }
  return j;
}

/** 扫 `true` / `false` / `null`（右侧要词边界）；不是字面量时返回 `start`。 */
function literalEnd(code: string, start: number): number {
  for (let i = 0; i < JSON_LITERALS.length; i++) {
    const word: string = JSON_LITERALS[i];
    const end: number = start + word.length;
    if (code.startsWith(word, start) && !isIdentifierPart(end < code.length ? code.charAt(end) : ' ')) {
      return end;
    }
  }
  return start;
}

// ── 通用规则：扫描 + 关键字集合 ─────────────────────────────────────────────

/** `#` 注释，只对 Python / Shell / YAML 生效（CSS 的 `#fff` 是颜色值）。 */
function hashCommentSpans(code: string): CodeSpan[] {
  return regexSpans(code, /#[^\n]*/g, CodeTokenKind.COMMENT, PRIORITY_COMMENT);
}

/** 行注释。`[^\n]*` 是线性匹配，不含断言。 */
function lineCommentSpans(code: string): CodeSpan[] {
  return regexSpans(code, /\/\/[^\n]*/g, CodeTokenKind.COMMENT, PRIORITY_COMMENT);
}

/** `\b` 在这里就是词边界：`abc123` 不会被当成数字。 */
function numberSpans(code: string): CodeSpan[] {
  return regexSpans(code, /\b\d+(\.\d+)?\b/g, CodeTokenKind.NUMBER, PRIORITY_NUMBER);
}

function identifierSpans(code: string): CodeSpan[] {
  return regexSpans(code, /[A-Za-z_][A-Za-z0-9_]*/g, CodeTokenKind.KEYWORD, PRIORITY_KEYWORD);
}

/** 标签名单独取第 1 组，避免把 `<` 也染上色。 */
function tagNameSpans(code: string): CodeSpan[] {
  const spans: CodeSpan[] = [];
  const re: RegExp = /<\/?([A-Za-z][A-Za-z0-9:-]*)/g;
  re.lastIndex = 0;
  let match: RegExpExecArray | null = re.exec(code);
  while (match !== null) {
    const full: string = match[0];
    const name: string = match[1];
    const start: number = match.index + full.length - name.length;
    spans.push(new CodeSpan(start, start + name.length, CodeTokenKind.KEYWORD, PRIORITY_KEYWORD));
    match = re.exec(code);
  }
  return spans;
}

/**
 * 按全局正则扫出全部区间。
 *
 * 每次调用前把 `lastIndex` 归零：这些正则是**模块级共享**的，上一次的进度会留着，
 * 不清就会从半截开始扫（源工程用 `findAll` 没有这个坑，JS 的 `exec` 有）。
 */
function regexSpans(code: string, re: RegExp, kind: CodeTokenKind, priority: number): CodeSpan[] {
  const spans: CodeSpan[] = [];
  re.lastIndex = 0;
  let match: RegExpExecArray | null = re.exec(code);
  while (match !== null) {
    if (match[0].length > 0) {
      spans.push(new CodeSpan(match.index, match.index + match[0].length, kind, priority));
    }
    match = re.exec(code);
  }
  return spans;
}

/**
 * 块注释用扫描而不是正则：懒惰匹配的正则碰上「开了块注释却没闭合」的输入时，
 * 每个起点都要一路扫到串尾，大文件下就是 O(n²)，足以卡住主线程 ——
 * 而流式输出出现半截块注释是常态。扫描版跳过已配对的区间，整体仍是 O(n)。
 */
function blockCommentSpans(code: string): CodeSpan[] {
  const spans: CodeSpan[] = [];
  let i: number = 0;
  while (true) {
    const from: number = code.indexOf('/*', i);
    if (from < 0) {
      return spans;
    }
    const close: number = code.indexOf('*/', from + 2);
    const end: number = close < 0 ? code.length : close + 2;
    spans.push(new CodeSpan(from, end, CodeTokenKind.COMMENT, PRIORITY_COMMENT));
    i = end;
  }
}

/** 通用高亮：字符串 / 注释 / 数字 / 关键字（或标签名）四类候选，最后消解重叠。 */
function genericSpans(code: string, rule: LanguageRule): CodeSpan[] {
  const candidates: CodeSpan[] = [];
  appendAll(candidates, quotedSpans(code, '"'));
  appendAll(candidates, quotedSpans(code, '\''));
  appendAll(candidates, lineCommentSpans(code));
  if (rule.hashComments) {
    appendAll(candidates, hashCommentSpans(code));
  }
  appendAll(candidates, blockCommentSpans(code));
  appendAll(candidates, numberSpans(code));

  if (rule.tagNames) {
    appendAll(candidates, tagNameSpans(code));
  } else if (rule.keywords.length > 0) {
    const words: string[] = rule.keywords;
    const identifiers: CodeSpan[] = identifierSpans(code);
    for (let i = 0; i < identifiers.length; i++) {
      const span: CodeSpan = identifiers[i];
      const word: string = code.substring(span.start, span.endExclusive);
      const key: string = rule.ignoreCase ? word.toLowerCase() : word;
      if (words.includes(key)) {
        candidates.push(span);
      }
    }
  }
  return pickNonOverlapping(candidates);
}

/**
 * 重叠消解：按「起点早者优先、同起点按优先级」贪心占位。
 *
 * 为什么要显式消解：字符串里的 `//`、注释里的 `val`、`"if"` 里的 `if` 都会被各自的规则
 * 命中，如果统统交给渲染层叠加，最终画面取决于添加顺序 —— 调一下规则的先后，
 * 颜色就悄悄变了。这里一次算清谁赢，与遍历顺序无关。
 */
function pickNonOverlapping(candidates: CodeSpan[]): CodeSpan[] {
  if (candidates.length === 0) {
    return [];
  }
  candidates.sort((a: CodeSpan, b: CodeSpan): number => {
    if (a.start !== b.start) {
      return a.start - b.start;
    }
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    // 同起点同优先级时取更长者（长的排在前面）。
    return b.length() - a.length();
  });

  const picked: CodeSpan[] = [];
  let takenUpTo: number = 0;
  for (let i = 0; i < candidates.length; i++) {
    const span: CodeSpan = candidates[i];
    if (span.start >= takenUpTo) {
      picked.push(span);
      takenUpTo = span.endExclusive;
    }
  }
  return picked;
}

// ── 小工具 ─────────────────────────────────────────────────────────────────

function appendAll(target: CodeSpan[], source: CodeSpan[]): void {
  for (let i = 0; i < source.length; i++) {
    target.push(source[i]);
  }
}

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function isDigit(ch: string): boolean {
  return ch.length === 1 && ch >= '0' && ch <= '9';
}

function isIdentifierPart(ch: string): boolean {
  if (isDigit(ch)) {
    return true;
  }
  if (ch.length !== 1) {
    return false;
  }
  const code: number = ch.charCodeAt(0);
  const isAsciiLetter: boolean = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
  // 非 ASCII（CJK 等）按「字母」处理：Kotlin 的 `isLetterOrDigit()` 就是全 Unicode 口径，
  // 若只在 ASCII 上判标识符，`1中文` 里的 `1` 会被误判成「两侧有词边界」而被着色。
  return isAsciiLetter || ch === '_' || code > 0x7f;
}
