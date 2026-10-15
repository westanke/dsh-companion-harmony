import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HtmlBlockKind, decodeHtmlEntities, extractHtmlBlocks,
} from '../../entry/src/main/ets/core/HtmlPreview.ts';

/**
 * HTML 结构抽取测试 —— 逐条对应原工程 `HtmlPreviewTest.kt`。
 *
 * 这组断言存在的理由：这是**替代 WebView** 的那条路。抽取错的代价是用户看到不该看到的
 * 东西（脚本正文）、或该看到的看不到（整段代码块因为嵌套标签而消失）。所以「脚本整体
 * 丢弃」「代码保留换行」「行内标签不切断段落」都要钉住。
 */

test('标题与段落各自成块', () => {
  const blocks = extractHtmlBlocks('<h1>标题</h1><p>正文</p>');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].kind, HtmlBlockKind.HEADING);
  assert.equal(blocks[0].text, '标题');
  assert.equal(blocks[1].kind, HtmlBlockKind.PARAGRAPH);
  assert.equal(blocks[1].text, '正文');
});

test('h1 到 h6 都算标题', () => {
  const blocks = extractHtmlBlocks('<h3>小标题</h3>');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, HtmlBlockKind.HEADING);
});

test('script / style 的内容整体丢弃，连同标签本身', () => {
  const source = '<p>甲</p><script>var x = 1;</script><style>.a { color: red; }</style><p>乙</p>';
  const blocks = extractHtmlBlocks(source);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, '甲');
  assert.equal(blocks[1].text, '乙');
  // 脚本正文绝不能出现在任何一块里：那是这份文件里最容易被误读成「App 在执行它」的部分。
  for (const block of blocks) {
    assert.doesNotMatch(block.text, /var x/);
    assert.doesNotMatch(block.text, /color: red/);
  }
});

test('列表项不分有序无序，统一成项目符号', () => {
  const unordered = extractHtmlBlocks('<ul><li>甲</li><li>乙</li></ul>');
  assert.equal(unordered.length, 2);
  assert.equal(unordered[0].kind, HtmlBlockKind.LIST_ITEM);
  assert.equal(unordered[0].text, '甲');
  assert.equal(unordered[1].text, '乙');

  const ordered = extractHtmlBlocks('<ol><li>一</li></ol>');
  assert.equal(ordered.length, 1);
  assert.equal(ordered[0].kind, HtmlBlockKind.LIST_ITEM);
});

test('表格行按列表项抽', () => {
  const blocks = extractHtmlBlocks('<table><tr><td>单元格</td></tr></table>');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, HtmlBlockKind.LIST_ITEM);
  assert.equal(blocks[0].text, '单元格');
});

test('引用块', () => {
  const blocks = extractHtmlBlocks('<blockquote>引用内容</blockquote>');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, HtmlBlockKind.QUOTE);
  assert.equal(blocks[0].text, '引用内容');
});

test('代码块保留换行与缩进，压成一行就丢了层级', () => {
  const blocks = extractHtmlBlocks('<pre>if (x) {\n  y();\n}</pre>');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, HtmlBlockKind.CODE);
  assert.equal(blocks[0].text, 'if (x) {\n  y();\n}');
});

test('嵌套的 pre/code 只抽一个代码块，不因内层标签而断掉', () => {
  // 早先的 bug：把 pre 与 code 都放进 stops，于是 <pre> 内部一撞见 <code> 就停，
  // 再按 </pre> 跳过 —— 代码块整个抽不出来。
  const blocks = extractHtmlBlocks('<pre><code>x()</code></pre>');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, HtmlBlockKind.CODE);
  assert.equal(blocks[0].text, 'x()');
});

test('链接带出 href', () => {
  const blocks = extractHtmlBlocks('<a href="https://a.b/x">点我</a>');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, HtmlBlockKind.LINK);
  assert.equal(blocks[0].text, '点我');
  assert.equal(blocks[0].href, 'https://a.b/x');

  // 单引号与大小写不敏感。
  const single = extractHtmlBlocks("<A HREF='/y'>这</A>");
  assert.equal(single[0].href, '/y');
});

test('行内标签不切断段落', () => {
  const blocks = extractHtmlBlocks('<p>甲<b>乙</b>丙</p>');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, HtmlBlockKind.PARAGRAPH);
  assert.equal(blocks[0].text, '甲乙丙');
});

test('块内遇到非停止标签时补一个空格，避免文字粘连', () => {
  const blocks = extractHtmlBlocks('<li>甲<b>乙</b></li>');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, '甲 乙');
});

test('容器闭合标签不产生任何块', () => {
  const blocks = extractHtmlBlocks('<div><ul></ul></div>');
  assert.equal(blocks.length, 0);
});

test('半个标签（流式写入）当纯文本保留，别把内容整个丢掉', () => {
  const blocks = extractHtmlBlocks('<p>甲<b');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, HtmlBlockKind.PARAGRAPH);
  assert.equal(blocks[0].text, '甲<b');
});

test('实体还原：常见五项 + 数字/十六进制实体', () => {
  assert.equal(decodeHtmlEntities('&amp;&lt;&gt;&quot;&apos;&nbsp;'), '&<>"\' ');
  assert.equal(decodeHtmlEntities('&#65;'), 'A');
  assert.equal(decodeHtmlEntities('&#x41;'), 'A');
  assert.equal(decodeHtmlEntities('&#X41;'), 'A');
});

test('认不出的实体与裸 & 原样保留', () => {
  assert.equal(decodeHtmlEntities('&foo;'), '&foo;');
  assert.equal(decodeHtmlEntities('&amp'), '&amp');
  assert.equal(decodeHtmlEntities('a & b'), 'a & b');
  // 实体名超过长度上限（分号离 & 超过 10 个字符）→ 当普通 & 处理。
  assert.equal(decodeHtmlEntities('&abcdefghij;'), '&abcdefghij;');
  assert.equal(decodeHtmlEntities('没有实体'), '没有实体');
});

test('实体在抽取过程中就被消化掉', () => {
  const blocks = extractHtmlBlocks('<p>甲 &amp; 乙</p>');
  assert.equal(blocks[0].text, '甲 & 乙');
});
