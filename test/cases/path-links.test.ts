import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinCwd, linkifyKnownFiles } from '../../entry/src/main/ets/core/PathLinks.ts';

/**
 * 正文文件链接化的门禁（对标源工程 `ChatPathLinksTest.kt`，源 v2.2.44 `a344e3f`）。
 *
 * 三条安全约束是重点：**唯一文件名才替换**（同名多目录宁可点不开，也不能点错文件）、
 * **不碰已有 Markdown 链接**（否则得到 `[[text](p)](p)`）、**只替换第一次出现**。
 * 另外钉住幂等 —— 这段文本会被反复经过渲染路径，重复包裹是必然出现的退化。
 */

test('唯一文件名被链接化', () => {
  assert.equal(
    linkifyKnownFiles('已落盘：report.md', ['/root/workspace/report.md']),
    '已落盘：[report.md](/root/workspace/report.md)',
  );
});

test('同名多路径的整条跳过（点错文件比点不开更严重）', () => {
  const known = ['/a/notes.md', '/b/notes.md'];
  assert.equal(linkifyKnownFiles('见 notes.md', known), '见 notes.md');
});

test('多个不同名各自替换', () => {
  const known = ['/a/one.md', '/a/two.md'];
  assert.equal(
    linkifyKnownFiles('先看 one.md 再看 two.md', known),
    '先看 [one.md](/a/one.md) 再看 [two.md](/a/two.md)',
  );
});

test('不重复包裹已有的 Markdown 链接', () => {
  const known = ['/a/report.md'];
  // `report.md` 前面紧贴 `(`、后面紧贴 `)`，都在排除集内 → 不动。
  assert.equal(linkifyKnownFiles('[看报告](report.md)', known), '[看报告](report.md)');
});

test('只替换第一次出现', () => {
  const known = ['/a/report.md'];
  assert.equal(
    linkifyKnownFiles('report.md 和 report.md', known),
    '[report.md](/a/report.md) 和 report.md',
  );
});

test('长名优先：短名不抢长名的命中', () => {
  const known = ['/a/a.md', '/a/report-a.md'];
  // `a.md` 落在 `report-a.md` 内部，且前面是 `-`（在排除集内）→ 本来就不该命中；
  // 排序是第二道保险（长名先进替换队列）。
  assert.equal(
    linkifyKnownFiles('report-a.md', known),
    '[report-a.md](/a/report-a.md)',
  );
  // 单说短名时照常命中。
  assert.equal(linkifyKnownFiles('看 a.md', known), '看 [a.md](/a/a.md)');
});

test('空正文或空文件清单原样返回', () => {
  assert.equal(linkifyKnownFiles('', ['/a/x.md']), '');
  assert.equal(linkifyKnownFiles('任意正文', []), '任意正文');
});

test('路径末段为空（目录式路径）不产生空名匹配', () => {
  assert.equal(linkifyKnownFiles('随便什么', ['/a/b/']), '随便什么');
});

test('幂等：连跑两次结果一致', () => {
  const known = ['/a/report.md'];
  const once = linkifyKnownFiles('已落盘：report.md', known);
  assert.equal(linkifyKnownFiles(once, known), once);
});

test('边界：紧跟中文全角括号仍可点，紧跟半角右括号不动', () => {
  const known = ['/a/report.md'];
  // 全角括号不在排除集内 → 应汉字边界不影响链接化。
  assert.equal(linkifyKnownFiles('（report.md）', known), '（[report.md](/a/report.md)）');
  // 半角右括号在排除集内 → 判为「已经是链接的一部分」，不动。
  assert.equal(linkifyKnownFiles('(report.md)', known), '(report.md)');
});

test('joinCwd：相对路径拼上会话工作目录', () => {
  // 源工程 v2.2.44 补的那条分支：模型正文里的链接常写成 `docs/report.md`。
  assert.equal(joinCwd('/root/workspace', 'docs/report.md'), '/root/workspace/docs/report.md');
});

test('joinCwd：两边多余 / 只留一个，不产生双斜杠', () => {
  assert.equal(joinCwd('/root/workspace/', 'docs/x.md'), '/root/workspace/docs/x.md');
  assert.equal(joinCwd('/root/workspace', '/docs/x.md'), '/root/workspace/docs/x.md');
  assert.equal(joinCwd('/root/workspace/', '/docs/x.md'), '/root/workspace/docs/x.md');
  // 根目录这一点最容易被拼成 `//docs/x.md`。
  assert.equal(joinCwd('/', 'docs/x.md'), '/docs/x.md');
  assert.equal(joinCwd('/', '/docs/x.md'), '/docs/x.md');
});

test('joinCwd：结果能被 linkify 后的链接目标直接使用（接口对齐）', () => {
  // 这条钉的是两个函数的**接口**：相对路径拼成绝对路径后，必须与原清单里的绝对路径
  // 逐字一致，否则「点开的文件」与「清单里的文件」成了两个不同的东西。
  const known = ['/root/workspace/docs/report.md'];
  const linked = linkifyKnownFiles('已落盘：report.md', known);
  assert.equal(linked, '已落盘：[report.md](/root/workspace/docs/report.md)');
  assert.equal(joinCwd('/root/workspace', 'docs/report.md'), known[0]);
});

test('文件名带正则特殊字符不会被当模式（点号必须转义）', () => {
  const known = ['/a/a+b(1).md'];
  assert.equal(
    linkifyKnownFiles('看 a+b(1).md 吧', known),
    '看 [a+b(1).md](/a/a+b(1).md) 吧',
  );
});
