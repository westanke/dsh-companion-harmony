import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InlineKind, InlineSegment, inlineSegments } from '../../entry/src/main/ets/core/InlineSegments.ts';
import { inlineMarkup } from '../../entry/src/main/ets/core/GenUiBlocks.ts';
import { linkifyKnownFiles } from '../../entry/src/main/ets/core/PathLinks.ts';

/**
 * 行内分段的门禁。
 *
 * 这一层是「链接能点」的前置条件：正文里的 `[文字](目标)` 必须被**原样切出来**，
 * 而切完之后拼回去必须与改造前**逐字相同**（多一个字符少一个字符都是版式事故）。
 * 所以用例分两半：一半钉「切得对」，一半钉「拼回去不变」。
 */

/** 把分段结果压成可读字符串，便于一眼比对：链接写成 `[显示→目标]`。 */
function render(raw: string): string {
  return inlineSegments(raw)
    .map((s: InlineSegment): string => (s.kind === InlineKind.LINK ? `[${s.text}→${s.url}]` : s.text))
    .join('');
}

/** 只取显示文字（丢掉目标），用来验证「版式没变」。 */
function visible(raw: string): string {
  return inlineSegments(raw)
    .map((s: InlineSegment): string => s.text)
    .join('');
}

test('空串切出空分段（渲染层不必判空）', () => {
  assert.equal(inlineSegments('').length, 0);
});

test('没有链接时只剩一段普通文字，且与改造前逐字相同', () => {
  const raw = '普通文字 **粗体** 和 `code` 还有 ~~删掉~~ 与 *斜体*';
  const segs = inlineSegments(raw);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].kind, InlineKind.TEXT);
  assert.equal(segs[0].text, inlineMarkup(raw));
});

test('一个链接被切出来，前后文字照旧', () => {
  assert.equal(render('已落盘：[报告](/root/report.md)'), '已落盘：[报告→/root/report.md]');
});

test('显示文字经过 inlineMarkup（链接文字里的粗体也剥掉）', () => {
  assert.equal(render('[**报告**](/a.md)'), '[报告→/a.md]');
});

test('空标签回退成目标本身，不让链接变成隐形', () => {
  assert.equal(render('[](/a.md)'), '[/a.md→/a.md]');
});

test('多个链接按原文顺序排列', () => {
  assert.equal(
    render('先 [甲](/a.md) 再 [乙](/b.md)'),
    '先 [甲→/a.md] 再 [乙→/b.md]',
  );
});

test('半截的 `[` 当普通字符，后半段文字一个字都不丢', () => {
  // 流式期间每帧都可能出现写了一半的链接，这里必须稳。
  assert.equal(render('看 [ 这里 [real](/a)'), '看 [ 这里 [real→/a]');
  assert.equal(render('[x](/a'), '[x](/a');
});

test('标签里嵌方括号时外层不成链接，内层那一对照常成链', () => {
  assert.equal(render('[外层 [内层](/c)'), '[外层 [内层→/c]');
});

test('图片按替代文字显示（与 inlineMarkup 的处理一致）', () => {
  assert.equal(render('![图](/a.png)'), '图');
  assert.equal(render('前 ![图](/a.png) 后'), '前 图 后');
});

test('目标里的括号要配平，不能被第一个 `)` 截断', () => {
  assert.equal(render('[文件](/a/b(1).md)'), '[文件→/a/b(1).md]');
  assert.equal(render('[文件](/a/b(1).md) 尾'), '[文件→/a/b(1).md] 尾');
});

test('与 linkifyKnownFiles 组合：带括号的文件名能原样点开', () => {
  // 这一条是两者接口的现场：带括号文件名正是 `linkifyKnownFiles` 会原样写进目标的形态，
  // 若这里按「第一个 `)` 收尾」，目标会被截成 `/a/a+b(1`，点开必然找不到文件。
  const linked = linkifyKnownFiles('已落盘：a+b(1).md', ['/a/a+b(1).md']);
  assert.equal(linked, '已落盘：[a+b(1).md](/a/a+b(1).md)');
  assert.equal(render(linked), '已落盘：[a+b(1).md→/a/a+b(1).md]');
});

test('行内代码里的链接写法照样会被切开（已知取舍，钉住）', () => {
  // ArkTS 侧没有「先分段再判代码段」的位置信息，这段代码里的链接写法会被当成链接，
  // 而配不成对的反引号只能按普通字符留下 —— 于是显示成 `` `a` ``，不是「代码段」。
  // 之所以接受：模型正文里代码段内写 Markdown 链接极其罕见，
  // 而链接点不动是 2026-10-19 被明确投诉的问题。
  assert.equal(render('`[a](/b)`'), '`[a→/b]`');
});

test('版式不变：有链接的正文，显示文字与剥壳后的原文一致', () => {
  const raw = '已落盘：[报告](/root/report.md)，另有 **两个** 待办';
  assert.equal(visible(raw), '已落盘：报告，另有 两个 待办');
});
