import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARKDOWN_TABLE_MAX_COLUMN_VP, MARKDOWN_TABLE_MIN_COLUMN_VP, markdownTableColumnWidths,
  MdBlock, MdBlockKind, MdTable, markdownBlocks } from '../../entry/src/main/ets/core/MarkdownLite.ts';

/**
 * Markdown 块级切分 —— 源工程没有这个文件（正文交给 Android 专有的
 * `com.mikepenz.markdown.m3` 渲染），是移植时新增的替代实现，因此没有对应的上游测试。
 *
 * 单测的理由与工程里其它 `core/*` 一致：块级切分错的表现是「屏幕上排版怪怪的」，
 * 肉眼几乎不可能指出是哪一条规则错了；而这几条规则里最容易写反的正是
 * 「代码块内容必须原样透传」与「有序列表必须以 1 开头」。
 */

function kinds(blocks: MdBlock[]): string[] {
  return blocks.map((b: MdBlock): string => b.kind);
}

test('空正文切不出任何块', () => {
  assert.deepEqual(markdownBlocks(''), []);
  assert.deepEqual(markdownBlocks('   \n\t\n'), []);
});

test('连续非空行并成一段，空行分段', () => {
  const blocks = markdownBlocks('第一行\n第二行\n\n第三段');
  assert.deepEqual(kinds(blocks), [MdBlockKind.PARAGRAPH, MdBlockKind.PARAGRAPH]);
  // 段落内**保留**原换行，不按 CommonMark 并成空格 —— 中文一行一句的写法很常见，
  // 并成空格会在中文里插出多余空格。
  assert.equal(blocks[0].text, '第一行\n第二行');
  assert.equal(blocks[1].text, '第三段');
});

test('ATX 标题按井号个数分级，且井号后必须有空白', () => {
  const blocks = markdownBlocks('# 一级\n## 二级\n###### 六级');
  assert.deepEqual(kinds(blocks), [MdBlockKind.HEADING, MdBlockKind.HEADING, MdBlockKind.HEADING]);
  assert.deepEqual(blocks.map((b: MdBlock): number => b.level), [1, 2, 6]);
  assert.equal(blocks[0].text, '一级');
});

test('井号后没有空白不算标题', () => {
  // `#hashtag` 是正文里的标签写法，不是标题。
  const blocks = markdownBlocks('#hashtag 不是标题');
  assert.deepEqual(kinds(blocks), [MdBlockKind.PARAGRAPH]);
  assert.equal(blocks[0].text, '#hashtag 不是标题');
});

test('七级井号回落成段落', () => {
  const blocks = markdownBlocks('####### 七级不存在');
  assert.deepEqual(kinds(blocks), [MdBlockKind.PARAGRAPH]);
});

test('无序列表：短横线、星号、加号都认，标记去掉', () => {
  const blocks = markdownBlocks('- 甲\n* 乙\n+ 丙');
  assert.deepEqual(kinds(blocks), [MdBlockKind.BULLET, MdBlockKind.BULLET, MdBlockKind.BULLET]);
  assert.deepEqual(blocks.map((b: MdBlock): string => b.text), ['甲', '乙', '丙']);
});

test('有序列表从 1 起连续编号', () => {
  const blocks = markdownBlocks('1. 甲\n1. 乙\n1. 丙');
  assert.deepEqual(kinds(blocks), [MdBlockKind.ORDERED, MdBlockKind.ORDERED, MdBlockKind.ORDERED]);
  assert.deepEqual(blocks.map((b: MdBlock): number => b.ordinal), [1, 2, 3]);
});

test('有序列表重排后序号从头开始', () => {
  const blocks = markdownBlocks('1. 甲\n\n1. 乙');
  assert.deepEqual(blocks.map((b: MdBlock): number => b.ordinal), [1, 1]);
});

test('非 1 开头的数字加点不算有序项', () => {
  // `37. 这条正文` 在会话里几乎只能是误判（版本号、金额、时间戳）。
  const blocks = markdownBlocks('37. 看着像列表其实不是');
  assert.deepEqual(kinds(blocks), [MdBlockKind.PARAGRAPH]);
});

test('引用：行首大于号，去掉以后再剪空白', () => {
  const blocks = markdownBlocks('> 引用一句\n>> 双引号也是引用');
  assert.deepEqual(kinds(blocks), [MdBlockKind.QUOTE, MdBlockKind.QUOTE]);
  assert.equal(blocks[0].text, '引用一句');
  assert.equal(blocks[1].text, '> 双引号也是引用');
});

test('代码块：围栏头不进正文，语言标记留在 lang，内容原样透传', () => {
  const blocks = markdownBlocks('```python\n# 这是注释不是标题\n- 这是 diff 行不是列表项\n```');
  assert.deepEqual(kinds(blocks), [MdBlockKind.CODE]);
  assert.equal(blocks[0].lang, 'python');
  assert.equal(blocks[0].text, '# 这是注释不是标题\n- 这是 diff 行不是列表项');
});

test('未闭合的代码块照样成块，块里不出现围栏标记', () => {
  const blocks = markdownBlocks('前言\n\n```json\n{"a":1}');
  assert.deepEqual(kinds(blocks), [MdBlockKind.PARAGRAPH, MdBlockKind.CODE]);
  assert.equal(blocks[1].lang, 'json');
  assert.equal(blocks[1].text, '{"a":1}');
});

test('代码块里的空行不会被当成段落分隔', () => {
  const blocks = markdownBlocks('```\n甲\n\n乙\n```');
  assert.deepEqual(kinds(blocks), [MdBlockKind.CODE]);
  assert.equal(blocks[0].text, '甲\n\n乙');
});

test('CRLF 换行与 LF 等价', () => {
  assert.deepEqual(markdownBlocks('# 甲\r\n\r\n乙'), markdownBlocks('# 甲\n\n乙'));
});

test('行内标记不在这里处理（由 inlineMarkup 负责）', () => {
  const blocks = markdownBlocks('**粗体** 与 `代码`');
  assert.equal(blocks[0].text, '**粗体** 与 `代码`');
});

test('GFM 表格：表头 + 分隔行 + 数据行，切成一个 TABLE 块', () => {
  const blocks = markdownBlocks('| 坑 | 说明 |\n|---|---|\n| 证书类型 | 调试证书 |\n| 容器 | 无成对色 |');
  assert.deepEqual(kinds(blocks), [MdBlockKind.TABLE]);
  const table: MdTable = blocks[0].table as MdTable;
  assert.deepEqual(table.header, ['坑', '说明']);
  assert.deepEqual(table.rows, [['证书类型', '调试证书'], ['容器', '无成对色']]);
});

test('表格两边没有竖线也能认（a | b 形式）', () => {
  const blocks = markdownBlocks('坑 | 说明\n--- | ---\n证书 | 调试');
  assert.deepEqual(kinds(blocks), [MdBlockKind.TABLE]);
  const table: MdTable = blocks[0].table as MdTable;
  assert.deepEqual(table.header, ['坑', '说明']);
  assert.deepEqual(table.rows, [['证书', '调试']]);
});

test('只有竖线、下一行不是分隔行时，仍按段落处理', () => {
  // 正文里 `a | b`（命令行管道、竖线分隔）太常见，缺了「下一行必须是分隔行」这道闸门
  // 就会把一整段吃掉。
  const blocks = markdownBlocks('输入 | grep foo\n输出两行');
  assert.deepEqual(kinds(blocks), [MdBlockKind.PARAGRAPH]);
});

test('表格在空行处收尾，后面的正文另起一段', () => {
  const blocks = markdownBlocks('| a |\n|---|\n| 1 |\n\n尾巴');
  assert.deepEqual(kinds(blocks), [MdBlockKind.TABLE, MdBlockKind.PARAGRAPH]);
  assert.equal(blocks[1].text, '尾巴');
});

test('表格行数不齐时原样保留（缺格由渲染层补空）', () => {
  const blocks = markdownBlocks('| a | b | c |\n|---|---|---|\n| 1 |');
  const table: MdTable = blocks[0].table as MdTable;
  assert.deepEqual(table.rows, [['1']]);
});

test('对齐冒号的分隔行也认', () => {
  const blocks = markdownBlocks('| 左 | 中 | 右 |\n|:---|:---:|---:|\n| 1 | 2 | 3 |');
  assert.deepEqual(kinds(blocks), [MdBlockKind.TABLE]);
  assert.equal((blocks[0].table as MdTable).header.length, 3);
});

test('分隔线：连字符、星号、下划线各成一条 HR', () => {
  const blocks = markdownBlocks('---\n\n***\n\n- - -\n\n___');
  assert.deepEqual(kinds(blocks), [MdBlockKind.HR, MdBlockKind.HR, MdBlockKind.HR, MdBlockKind.HR]);
});

test('分隔线判定不吃掉真正的列表项', () => {
  // `- 正文` 是列表项；`- - -` 才是分隔线。判定先后顺序错了会把列表项变没。
  const blocks = markdownBlocks('- 正文\n- - -\n- 又一项');
  assert.deepEqual(kinds(blocks),
    [MdBlockKind.BULLET, MdBlockKind.HR, MdBlockKind.BULLET]);
});

test('少于三个的横线不算分隔线', () => {
  const blocks = markdownBlocks('--');
  assert.deepEqual(kinds(blocks), [MdBlockKind.PARAGRAPH]);
});

test('列宽：空表返回空数组', () => {
  assert.deepEqual(markdownTableColumnWidths([], [], 13), []);
});

test('列宽：按内容估算，短的夹到下限、长的夹到上限', () => {
  const widths = markdownTableColumnWidths(['a', '很长很长很长很长很长很长很长很长很长的一列'],
    [['1', 'x']], 13);
  assert.equal(widths.length, 2);
  assert.equal(widths[0], MARKDOWN_TABLE_MIN_COLUMN_VP);
  assert.equal(widths[1], MARKDOWN_TABLE_MAX_COLUMN_VP);
});

test('列宽：取表头与全部数据行里最长的那一格', () => {
  // 表头八格宽、数据行十五格宽 → 该列应比「只看表头」算出来的更宽。
  // （都取到下限的短文本比不出差别，所以这里刻意都用超过下限的宽度。）
  const narrow = markdownTableColumnWidths(['abcdefgh'], [], 13)[0];
  const wide = markdownTableColumnWidths(['abcdefgh'], [['abcdefghijklmno']], 13)[0];
  assert.ok(wide > narrow, `数据行更长时应更宽：${wide} vs ${narrow}`);
});

test('列宽：长英文标识符的列宽足以让它不折在词内', () => {
  // 真机回归：`bundleName` 曾被渲染成 `bundleNam` / `e` 两行（西文字宽系数 0.55 偏窄，
  // 估出的列宽比实际渲染宽度小几个像素）。列宽必须 ≥ 该单词按西文字宽估出的宽度，
  // 否则 Text 会在词内强制断开 —— 这是「整格折行、单词不断」的底线。
  const width = markdownTableColumnWidths(['坑'], [['bundleName']], 13)[0];
  const needed = Math.ceil(10 * 0.60 * 13) + 16;
  assert.ok(width >= needed, `列宽应容得下整个单词：${width} < ${needed}`);
});

test('列宽：表头字号大于正文时，长表头那列按表头字号估', () => {
  // 表头与正文用不同字号渲染（14 / 13）。若统一按正文字号算，长表头会偏窄而被折断。
  const bodyOnly = markdownTableColumnWidths(['bundleName'], [], 13)[0];
  const withHeader = markdownTableColumnWidths(['bundleName'], [], 13, 14)[0];
  assert.ok(withHeader > bodyOnly, `表头更大时应更宽：${withHeader} vs ${bodyOnly}`);
});

test('列宽：不传表头字号时按正文字号处理', () => {
  assert.deepEqual(markdownTableColumnWidths(['abcd'], [['abcd']], 13),
    markdownTableColumnWidths(['abcd'], [['abcd']], 13, 0));
});
