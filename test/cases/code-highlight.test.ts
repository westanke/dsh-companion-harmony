import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CodeSegment, CodeSpan, CodeTokenKind, codeSegments, highlightCode, looksLikeJson,
} from '../../entry/src/main/ets/core/CodeHighlight.ts';

/**
 * 代码高亮的三条底线，按「坏了会怎样」排序 —— 逐条对应原工程 `ChatCodeHighlightTest.kt`：
 *
 * 1. **原文一个字符都不能动**。高亮只加样式，调用方（Markdown 代码块、文件预览）
 *    按原文排版与复制；这里 trim 一下或补个换行，行号与剪贴板内容就全歪了。
 *    所以第一条断言是全覆盖的：多语言 × 多形态，逐个比拼回来的文本。
 * 2. **畸形输入不许抛**（流式输出的半截 JSON 每帧都会送进来）、**认不出的语言不许抛**
 *    （围栏标签是模型写的自由文本）。失败姿态必须是「退化成无样式文本」。
 * 3. **20 万字符不许卡**。这段逻辑跑在消息渲染路径上，长工具结果很常见；
 *    写成 O(n²)（循环里拼 substring、反复全串扫描）在单测里就会现形。
 *
 * ### 与 Kotlin 版本的两处适配
 *
 * ① 源工程断言的是**颜色**（`AnnotatedString.spanStyles`），本工程返回的是
 *    **区间 + 语义类别**（`CodeSpan`），配色在界面层（`ui/MarkdownView.ets` 的 `tokenColor`）。
 *    所以下面把「某颜色覆盖的片段」换成「某类别的片段」—— 断言强度不变：
 *    源工程那句「改色板必须同步改测试，否则就是悄悄换了配色」，在这里变成
 *    「改类别必须同步改测试」。
 * ② Kotlin 的 KEY 与 KEYWORD 是**同一个颜色**（阅读上同类）；本工程保留了两个类别
 *    （将来要分开染色不用改核心），所以涉及键的断言写 `KEY`、涉及关键字写 `KEYWORD`。
 */

/** 某个类别覆盖到的原文片段（按出现顺序）—— 用它看「哪几个词亮了」。 */
function spansWith(code: string, language: string | null, kind: CodeTokenKind): string[] {
  const out: string[] = [];
  const spans: CodeSpan[] = highlightCode(code, language);
  for (let i = 0; i < spans.length; i++) {
    if (spans[i].kind === kind) {
      out.push(code.substring(spans[i].start, spans[i].endExclusive));
    }
  }
  return out;
}

/** 高亮类别数（对应源工程的 `spanStyles.size`）。 */
function spanCount(code: string, language: string | null): number {
  return highlightCode(code, language).length;
}

/** 断言 `token` 恰好被 `kind` 覆盖，并把精确区间返回给调用方继续钉边界。 */
function spanRangeOf(code: string, language: string | null, token: string,
  kind: CodeTokenKind): string {
  const at: number = code.indexOf(token);
  assert.ok(at >= 0, `样本文本里没有 \`${token}\``);
  const spans: CodeSpan[] = highlightCode(code, language);
  for (let i = 0; i < spans.length; i++) {
    const span: CodeSpan = spans[i];
    if (span.start === at && span.endExclusive === at + token.length) {
      assert.equal(span.kind, kind, `\`${token}\` 的类别是 ${span.kind}，不是期望的 ${kind}`);
      return `${span.start}..${span.endExclusive}`;
    }
  }
  throw new Error(`\`${token}\`（${at}..${at + token.length}）没有任何样式`);
}

/** 分段拼回来必须逐字符等于原文（`codeSegments` 的契约）。 */
function rebuilt(code: string, language: string | null): string {
  const segments: CodeSegment[] = codeSegments(code, highlightCode(code, language));
  return segments.map((segment: CodeSegment): string => segment.text).join('');
}

const jsonSample: string = [
  '{',
  '  "name": "dsh",',
  '  "count": 42,',
  '  "ratio": -1.5,',
  '  "ok": true,',
  '  "none": null',
  '}',
].join('\n');

// ── ① 原文一个字符都不能改 ──────────────────────────────────────────────

test('任何语言标签下都不改动原文一个字', () => {
  const samples: string[] = [
    '', // 空串
    '   ', // 全空白
    '\n\n',
    'val x = 1 // 中文注释',
    '{\r\n  "键": "值",\r\n  "n": -1.5\r\n}', // CRLF + 非 ASCII
    '#!/bin/bash\nIFS=$\'\\n\' echo "$1"\n',
    'def f():\n    return \'x\'',
    '<div class="a">文本</div>',
    'line1\nline2\r\nline3',
    '{"a": "未闭合',
    'f(x) { y -> y + 1 } /* 半截块注释',
  ];
  const languages: (string | null)[] = [
    null, '', '   ', 'json', 'JSON ', 'kotlin', 'kt', 'kts', 'java', 'js', 'ts',
    'python', 'py', 'shell', 'sh', 'bash', 'yaml', 'yml', 'xml', 'html', 'css',
    'rust', 'go', 'ps1', '未知语言',
  ];

  for (let s = 0; s < samples.length; s++) {
    for (let l = 0; l < languages.length; l++) {
      const code: string = samples[s];
      const language: string | null = languages[l];
      assert.equal(rebuilt(code, language), code,
        `语言标签 \`${language}\` 改动了原文：\`${code}\``);
    }
  }
});

test('空输入没有任何样式', () => {
  assert.equal(spanCount('', 'json'), 0);
  assert.equal(rebuilt('', 'json'), '');
});

// ── ② JSON：键 / 字符串 / 数字 / 字面量 ──────────────────────────────────

test('JSON 的键、值、数字、字面量各归其类', () => {
  assert.deepEqual(spansWith(jsonSample, 'json', CodeTokenKind.KEY),
    ['"name"', '"count"', '"ratio"', '"ok"', '"none"']);
  assert.deepEqual(spansWith(jsonSample, 'json', CodeTokenKind.STRING), ['"dsh"']);
  assert.deepEqual(spansWith(jsonSample, 'json', CodeTokenKind.NUMBER), ['42', '-1.5']);
  assert.deepEqual(spansWith(jsonSample, 'json', CodeTokenKind.LITERAL), ['true', 'null']);
  assert.deepEqual(spansWith(jsonSample, 'json', CodeTokenKind.COMMENT), []);
});

test('JSON 的区间是精确的，不是整块涂色', () => {
  // 键的区间是 [4, 10)：只包住 `"name"` 这 6 个字符，不含冒号与缩进。
  assert.equal(spanRangeOf(jsonSample, 'json', '"name"', CodeTokenKind.KEY), '4..10');
  // 值的区间同理：`"dsh"` 占 [12, 17)
  assert.equal(spanRangeOf(jsonSample, 'json', '"dsh"', CodeTokenKind.STRING), '12..17');
  // 粒度断言：5 键 + 1 字符串 + 2 数字 + 2 字面量，一段不多一段不少（防「整块涂色」）
  assert.equal(spanCount(jsonSample, 'json'), 10);
});

test('JSON 的键判定忽略空白与嵌套', () => {
  const spaced: string = '{ "a" : "b" ,\n "c"\t:\t[1] }';

  // 冒号前有空白（含换行/制表）照样是键；冒号后的 `"b"` 是值。
  assert.deepEqual(spansWith(spaced, 'json', CodeTokenKind.KEY), ['"a"', '"c"']);
  assert.deepEqual(spansWith(spaced, 'json', CodeTokenKind.STRING), ['"b"']);

  const nested: string = '{"a":{"b":[{"c":1}]}}';
  assert.deepEqual(spansWith(nested, 'json', CodeTokenKind.KEY), ['"a"', '"b"', '"c"']);
  assert.deepEqual(spansWith(nested, 'json', CodeTokenKind.NUMBER), ['1']);
});

test('JSON 的转义不提前结束字符串', () => {
  const code: string = '{"a": "\\"x\\"", "b": 2}';

  // `\"` 不能把字符串提前截断，所以 `"b"` 仍被识别为键（而不是被上一段的残骸吃掉）。
  assert.deepEqual(spansWith(code, 'json', CodeTokenKind.KEY), ['"a"', '"b"']);
  assert.deepEqual(spansWith(code, 'json', CodeTokenKind.NUMBER), ['2']);
  assert.equal(rebuilt(code, 'json'), code);
});

test('CRLF 的 JSON 键照样识别', () => {
  const code: string = '{\r\n  "键": "值",\r\n  "n": 1\r\n}';

  assert.deepEqual(spansWith(code, 'json', CodeTokenKind.KEY), ['"键"', '"n"']);
  assert.deepEqual(spansWith(code, 'json', CodeTokenKind.STRING), ['"值"']);
  assert.deepEqual(spansWith(code, 'json', CodeTokenKind.NUMBER), ['1']);
  assert.equal(rebuilt(code, 'json'), code);
});

test('空标签只在内容像 JSON 时才按 JSON 猜一次', () => {
  const json: string = '  {"a": 1}\n';

  // null 与空白标签都归一到「猜一次」：工具结果里裸 JSON 太常见了。
  assert.deepEqual(spansWith(json, null, CodeTokenKind.NUMBER), ['1']);
  assert.deepEqual(spansWith(json, '   ', CodeTokenKind.NUMBER), ['1']);
  // 数组里的两个数字都要着色。
  assert.deepEqual(spansWith('[1, 2]', null, CodeTokenKind.NUMBER), ['1', '2']);
  // 显式标签要归一化（大小写 + 空白）。
  assert.deepEqual(spansWith('{"a": 1}', ' JSON ', CodeTokenKind.NUMBER), ['1']);
  // 不像 JSON 的裸文本不猜：保持无样式，别把散文当 JSON 涂色。
  assert.equal(spanCount('select 1 from t', null), 0);
});

test('looksLikeJson 只看首尾字符', () => {
  assert.equal(looksLikeJson('{"a": 1}'), true);
  assert.equal(looksLikeJson('  [1, 2]  '), true);
  assert.equal(looksLikeJson('{'), false);
  assert.equal(looksLikeJson('   '), false);
  assert.equal(looksLikeJson('select 1'), false);
});

// ── ③ 认不出的语言：无样式、不抛异常 ────────────────────────────────────

test('认不出的语言只给无样式文本', () => {
  const code: string = 'fn main() { println!("hi") }';
  const languages: string[] = ['rust', 'go', 'c++', 'csharp', 'ps1', 'jsx', 'vue', 'sql', '未知语言'];

  for (let i = 0; i < languages.length; i++) {
    assert.equal(spanCount(code, languages[i]), 0, `语言标签 \`${languages[i]}\` 不该产生样式`);
    assert.equal(rebuilt(code, languages[i]), code, `语言标签 \`${languages[i]}\` 改动了原文`);
  }
});

// ── 通用规则：关键字 / 字符串 / 数字 / 注释 ─────────────────────────────

test('Kotlin 规则点亮关键字、字符串、数字与注释', () => {
  const code: string = 'val n = 42 // 注释里的 val 不该单独亮\nval s = "x"';

  assert.deepEqual(spansWith(code, 'kotlin', CodeTokenKind.KEYWORD), ['val', 'val']);
  assert.deepEqual(spansWith(code, 'kotlin', CodeTokenKind.STRING), ['"x"']);
  assert.deepEqual(spansWith(code, 'kotlin', CodeTokenKind.NUMBER), ['42']);
  assert.deepEqual(spansWith(code, 'kotlin', CodeTokenKind.COMMENT), ['// 注释里的 val 不该单独亮']);
  assert.equal(rebuilt(code, 'kotlin'), code);
});

test('字符串内容压过注释与关键字规则', () => {
  const code: string = 'val s = "// 不是注释"\nval t = "if"';

  // 重叠消解的判据：字符串起点更早，所以它赢 —— 顺序反过来写也不该变色。
  assert.deepEqual(spansWith(code, 'kotlin', CodeTokenKind.COMMENT), []);
  assert.deepEqual(spansWith(code, 'kotlin', CodeTokenKind.STRING), ['"// 不是注释"', '"if"']);
  assert.deepEqual(spansWith(code, 'kotlin', CodeTokenKind.KEYWORD), ['val', 'val']);
});

test('Shell 关键字忽略大小写', () => {
  const code: string = 'IF [ -f x ]; THEN\n  echo "done 不是关键字"\nFI';

  assert.deepEqual(spansWith(code, 'sh', CodeTokenKind.KEYWORD), ['IF', 'THEN', 'echo', 'FI']);
  assert.deepEqual(spansWith(code, 'sh', CodeTokenKind.STRING), ['"done 不是关键字"']);
});

test('Python 的 # 注释点亮，而 CSS 的 #fff 不点亮', () => {
  const python: string = 'def f(n):  # 计数\n    return n + 1';

  assert.deepEqual(spansWith(python, 'python', CodeTokenKind.COMMENT), ['# 计数']);
  assert.deepEqual(spansWith(python, 'python', CodeTokenKind.KEYWORD), ['def', 'return']);
  assert.deepEqual(spansWith(python, 'python', CodeTokenKind.NUMBER), ['1']);

  // CSS 的 `#fff` 是色值：按语言开关 `#` 注释，而不是全局启用。
  const css: string = 'a { color: #fff; margin: 0 auto; }';

  assert.deepEqual(spansWith(css, 'css', CodeTokenKind.COMMENT), []);
  assert.deepEqual(spansWith(css, 'css', CodeTokenKind.KEYWORD), ['color', 'margin', 'auto']);
});

test('块注释点亮，且半截块注释一直染到串尾', () => {
  const code: string = 'int x = 1; /* 说明\n 多行 */ int y = 2; // 行注释';

  assert.deepEqual(spansWith(code, 'java', CodeTokenKind.COMMENT), ['/* 说明\n 多行 */', '// 行注释']);
  assert.deepEqual(spansWith(code, 'java', CodeTokenKind.KEYWORD), ['int', 'int']);
  assert.deepEqual(spansWith(code, 'java', CodeTokenKind.NUMBER), ['1', '2']);

  // 半截块注释（流式输出常态）要一直染到串尾，而不是整段不回色。
  const half: string = 'fun f() { /* 还没写完';
  assert.deepEqual(spansWith(half, 'kotlin', CodeTokenKind.COMMENT), ['/* 还没写完']);
});

test('标记语言点亮标签名而不是关键字', () => {
  const code: string = '<div class="row">文本</div>';

  assert.deepEqual(spansWith(code, 'html', CodeTokenKind.KEYWORD), ['div', 'div']);
  assert.deepEqual(spansWith(code, 'html', CodeTokenKind.STRING), ['"row"']);
});

// ── 畸形输入：不抛、不退化成「整段无样式」 ───────────────────────────────

test('畸形 JSON 不抛异常，且保留可用的样式', () => {
  // 未闭合字符串：半截值仍然着色到行尾，不能让后面的内容失去解析。
  const unclosed: string = '{"a": "未闭合';

  assert.deepEqual(spansWith(unclosed, 'json', CodeTokenKind.KEY), ['"a"']);
  assert.deepEqual(spansWith(unclosed, 'json', CodeTokenKind.STRING), ['"未闭合']);
  assert.equal(rebuilt(unclosed, 'json'), unclosed);

  // 括号不配平 + 半个指数 `1e` + 孤立负号 `-`：都不许抛，键照旧认出来。
  const broken: string = '{"a": 1e, "b": -}';

  assert.deepEqual(spansWith(broken, 'json', CodeTokenKind.KEY), ['"a"', '"b"']);
  assert.equal(rebuilt(broken, 'json'), broken);

  // 单引号不是 JSON 字符串：`{'k': 1}` 里只有数字 1 该亮。
  const single: string = "{'k': 1}";

  assert.deepEqual(spansWith(single, 'json', CodeTokenKind.NUMBER), ['1']);
  assert.equal(rebuilt(single, 'json'), single);

  // 长未闭合输入（流式场景）：原文不变、不抛。
  const longUnclosed: string = `{${'"k":"v",'.repeat(2000)}`;
  assert.equal(rebuilt(longUnclosed, 'json'), longUnclosed);
});

test('猜 JSON 那条路碰上畸形内容同样安全', () => {
  const samples: string[] = [
    '{"a": "未闭合',
    '{"a": 1e, "b": -}',
    '[[[[',
    '}{',
    '{"a": 1,}',
  ];

  for (let i = 0; i < samples.length; i++) {
    const sample: string = samples[i];
    assert.equal(rebuilt(sample, null), sample, `空标签 + 畸形内容改动了原文：\`${sample}\``);
  }
});

test('未闭合字符串停在行尾，不吞掉后面几十行', () => {
  // 落单的引号若一路吞到串尾，整段代码就失去高亮 —— 比不着色更糟。
  const code: string = 'val s = "半截\nval t = 42';

  assert.deepEqual(spansWith(code, 'kotlin', CodeTokenKind.NUMBER), ['42']);
});

// ── ④ 性能：20 万字符不许卡 ────────────────────────────────────────────

test('20 万字符的高亮不许卡', () => {
  let jsonInput: string = '[';
  while (jsonInput.length < 200000) {
    jsonInput += '{"k":"v","n":-12.5,"b":true},';
  }
  jsonInput += ']';

  let genericInput: string = '';
  while (genericInput.length < 200000) {
    genericInput += 'val x = 42 // 注释注释注释注释注释注释注释\n';
  }
  assert.ok(jsonInput.length >= 200000, `样例没到 20 万字符：${jsonInput.length}`);
  assert.ok(genericInput.length >= 200000, `样例没到 20 万字符：${genericInput.length}`);

  // 先确认真的高亮了（否则测的是「早退」路径，等于没测）。
  const jsonSpans: number = spanCount(jsonInput, 'json');
  const genericSpans: number = spanCount(genericInput, 'kotlin');
  assert.ok(jsonSpans > 10000, `JSON 高亮段数太少：${jsonSpans}`);
  assert.ok(genericSpans > 10000, `通用高亮段数太少：${genericSpans}`);
  assert.equal(rebuilt(jsonInput, 'json'), jsonInput);
  assert.equal(rebuilt(genericInput, 'kotlin'), genericInput);

  // 阈值放到 3000ms：只为拦 O(n²) 这类量级问题，不跟 CI 抖动较劲。
  const jsonStarted: number = Date.now();
  highlightCode(jsonInput, 'json');
  const jsonMs: number = Date.now() - jsonStarted;

  const genericStarted: number = Date.now();
  highlightCode(genericInput, 'kotlin');
  const genericMs: number = Date.now() - genericStarted;

  assert.ok(jsonMs < 3000, `JSON 高亮 20 万字符耗时 ${jsonMs}ms`);
  assert.ok(genericMs < 3000, `通用高亮 20 万字符耗时 ${genericMs}ms`);
});

test('病态引号串不许卡（钉住那个爆栈/二次方回归）', () => {
  // 这一条是**回归钉子**，钉的是一个真实的崩溃：`"(?:\\.|[^"\\])*"` 用递归处理重复组，
  // 20 万字符的长字符串字面量会让 JVM 抛 StackOverflowError —— 一旦抛异常，
  // 整段消息渲染不出来。字符串改成单遍扫描后这里应当瞬间跑完；
  // 谁把它改回重复组正则、或把块注释改回懒惰匹配正则，这条会红。
  const longLiteral: string = `"${'a'.repeat(200000)}"`;   // 完整的长字符串字面量
  const quoteThenRuns: string = `"${'a'.repeat(200000)}`;  // 只开了头、还没有结尾
  const escapedRuns: string = '"\\'.repeat(100000);        // 即 `"\"\"\"\...`，20 万字符

  const samples: string[] = [longLiteral, quoteThenRuns, escapedRuns];
  const languages: string[] = ['kotlin', 'json'];
  for (let s = 0; s < samples.length; s++) {
    for (let l = 0; l < languages.length; l++) {
      assert.equal(rebuilt(samples[s], languages[l]), samples[s],
        `语言 \`${languages[l]}\` 改动了原文`);
    }
  }
  // 三种形态在通用规则下都只该有一段样式。
  assert.equal(spanCount(longLiteral, 'kotlin'), 1);
  assert.equal(spanCount(quoteThenRuns, 'kotlin'), 1);
  assert.equal(spanCount(escapedRuns, 'kotlin'), 1);

  const literalStarted: number = Date.now();
  highlightCode(longLiteral, 'kotlin');
  const literalMs: number = Date.now() - literalStarted;

  const jsonLiteralStarted: number = Date.now();
  highlightCode(longLiteral, 'json');
  const jsonLiteralMs: number = Date.now() - jsonLiteralStarted;

  const quotedStarted: number = Date.now();
  highlightCode(escapedRuns, 'kotlin');
  const quotedMs: number = Date.now() - quotedStarted;

  assert.ok(literalMs < 3000, `通用规则处理 20 万字符长字面量耗时 ${literalMs}ms`);
  assert.ok(jsonLiteralMs < 3000, `JSON 规则处理 20 万字符长字面量耗时 ${jsonLiteralMs}ms`);
  assert.ok(quotedMs < 3000, `通用规则处理 \`"\\\` 重复 20 万字符耗时 ${quotedMs}ms`);
});
