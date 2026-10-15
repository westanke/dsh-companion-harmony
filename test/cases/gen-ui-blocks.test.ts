import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MessageSegmentKind, diagnoseGenUi, genUiBool, genUiChildren, genUiInt, genUiLabel,
  genUiListItems, genUiNumber, genUiStr, genUiTitle, inlineMarkup, parseGenUi, splitMessageBody,
} from '../../entry/src/main/ets/core/GenUiBlocks.ts';

/**
 * dsh-ui 卡片切分 / 解析 / 诊断测试 —— 逐条对应原工程 `GenUiBlocksTest.kt`。
 *
 * 这组断言存在的理由：这条链路上「围栏没被识别」「JSON 坏了」「节点类型不认识」三种失败
 * 在屏幕上长得几乎一模一样。切分错了，用户看到的是「有的卡片弹得出来、有的显示成 md」；
 * 诊断错了，用户会盯着一个「⚠」等它自己消失。所以四条硬规则与三态诊断都要钉住。
 */

test('正文与卡片围栏被正确切开', () => {
  const segments = splitMessageBody('正文\n```dsh-ui\n{"a":1}\n```\n尾巴');
  assert.equal(segments.length, 3);
  assert.equal(segments[0].kind, MessageSegmentKind.PROSE);
  assert.equal(segments[0].text, '正文');
  assert.equal(segments[1].kind, MessageSegmentKind.UI);
  assert.equal(segments[1].text.trim(), '{"a":1}');
  assert.equal(segments[2].kind, MessageSegmentKind.PROSE);
  assert.equal(segments[2].text, '尾巴');
});

test('未闭合的围栏整段按原文保留（流式输出中的中间态）', () => {
  // 开头 ``` 已出现而结尾还没到；切出去会得到半截 JSON，卡片解析必然失败。
  const body = '正文\n```dsh-ui\n{"a"';
  const segments = splitMessageBody(body);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].kind, MessageSegmentKind.PROSE);
  assert.equal(segments[0].text, body, '未闭合时一字不动地交回整段');
});

test('围栏头后没有换行时也整段保留，等下一片再切', () => {
  const body = '```dsh-ui';
  const segments = splitMessageBody(body);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].text, body);
});

test('```json dsh-ui 与 ```dsh-ui 都认（genui skill 自己就有两种写法）', () => {
  const withHighlight = splitMessageBody('a\n```json dsh-ui\n{"items":[{"type":"text"}]}\n```\n');
  assert.equal(withHighlight.length, 2);
  assert.equal(withHighlight[1].kind, MessageSegmentKind.UI);

  const plain = splitMessageBody('a\n```dsh-ui\n{"items":[{"type":"text"}]}\n```\n');
  assert.equal(plain.length, 2);
  assert.equal(plain[1].kind, MessageSegmentKind.UI);
});

test('没有 dsh-ui 标记的围栏不认（```json / ```mermaid / 裸 ```）', () => {
  for (const info of ['json', 'mermaid', '']) {
    const body = `a\n\`\`\`${info}\nx\n\`\`\`\n`;
    const segments = splitMessageBody(body);
    assert.equal(segments.length, 1, `info='${info}' 不该被切开`);
    assert.equal(segments[0].kind, MessageSegmentKind.PROSE);
    assert.equal(segments[0].text, body.trim());
  }
});

test('```dsh-ui-bad 不是标记，不认（否则会吞掉别的语言名）', () => {
  const body = 'a\n```dsh-ui-bad\nx\n```\n';
  const segments = splitMessageBody(body);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].kind, MessageSegmentKind.PROSE);
});

test('只认行首的围栏头，正文中间的反引号不算边界', () => {
  // 一条「教你写 dsh-ui 围栏」的消息不该被自己切成两半。
  const body = '这行讲 ```dsh-ui 怎么写\n第二行';
  const segments = splitMessageBody(body);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].text, body);
});

test('内容为空的围栏不切出空卡片段', () => {
  const segments = splitMessageBody('a\n```dsh-ui\n\n```\nb');
  assert.equal(segments.length, 2);
  assert.equal(segments[0].text, 'a');
  assert.equal(segments[1].text, 'b');
});

test('纯文字正文原样返回唯一一段', () => {
  const segments = splitMessageBody('就是一段话');
  assert.equal(segments.length, 1);
  assert.equal(segments[0].kind, MessageSegmentKind.PROSE);
  assert.equal(segments[0].text, '就是一段话');
});

test('parseGenUi 解出标题、间距与节点', () => {
  const spec = parseGenUi('{"title":"标题","gap":5,"items":[{"type":"text","content":"hi"}]}');
  assert.notEqual(spec, null);
  assert.equal(spec!.title, '标题');
  assert.equal(spec!.gap, 5);
  assert.equal(spec!.items.length, 1);
  assert.equal(spec!.items[0].type, 'text');
});

test('gap 缺省或非整数时回落 12', () => {
  assert.equal(parseGenUi('{"items":[{"type":"text"}]}')!.gap, 12);
  assert.equal(parseGenUi('{"gap":1.5,"items":[{"type":"text"}]}')!.gap, 12);
  assert.equal(parseGenUi('{"gap":"7","items":[{"type":"text"}]}')!.gap, 12);
});

test('坏 JSON / 非对象根 / items 为空 / 未知类型 → 无法显示', () => {
  assert.equal(parseGenUi('{bad json}'), null);
  assert.equal(parseGenUi('[1,2,3]'), null);
  assert.equal(parseGenUi('"just a string"'), null);
  assert.equal(parseGenUi('{"items":[]}'), null);
  assert.equal(parseGenUi('{"items":[{"type":"unknown-widget"}]}'), null);
  assert.equal(parseGenUi('{"items":[{"noType":true}]}'), null);
  assert.equal(parseGenUi('{"items":[null,"x",42]}'), null);
});

test('单个坏节点只丢它自己，不牵连整份 spec', () => {
  const spec = parseGenUi('{"items":[{"type":"text"},{"type":"nope"},{"type":"card"}]}');
  assert.notEqual(spec, null);
  assert.equal(spec!.items.length, 2);
  assert.equal(spec!.items[0].type, 'text');
  assert.equal(spec!.items[1].type, 'card');
});

test('genUiChildren 取布局容器的子节点并滤掉未知类型', () => {
  const spec = parseGenUi('{"items":[{"type":"row","items":[{"type":"text"},{"type":"bad"}]}]}');
  const node = spec!.items[0];
  const children = genUiChildren(node);
  assert.equal(children.length, 1);
  assert.equal(children[0].type, 'text');
});

test('genUiListItems 同时接受纯字符串与对象条目', () => {
  const spec = parseGenUi('{"items":[{"type":"list","items":['
    + '"a",{"title":"t","desc":"d"},{"label":"l"},{"content":"c"},{"title":"  "},42]}]}');
  const items = genUiListItems(spec!.items[0]);
  assert.equal(items.length, 5);
  assert.equal(items[0].title, 'a');
  assert.equal(items[0].desc, null);
  assert.equal(items[1].title, 't');
  assert.equal(items[1].desc, 'd');
  assert.equal(items[2].title, 'l');
  assert.equal(items[3].title, 'c');
  // 数字原语也成条目（kotlinx content 语义），标题全空白的对象被丢。
  assert.equal(items[4].title, '42');
});

test('label / title 取值优先级', () => {
  const card = parseGenUi('{"items":[{"type":"card","title":"标题","label":"标签"}]}')!.items[0];
  assert.equal(genUiLabel(card), '标签');
  assert.equal(genUiTitle(card), '标题');

  const noLabel = parseGenUi('{"items":[{"type":"button","content":"点我"}]}')!.items[0];
  assert.equal(genUiLabel(noLabel), '点我');

  const onlyTitle = parseGenUi('{"items":[{"type":"card","title":"标题"}]}')!.items[0];
  assert.equal(genUiLabel(onlyTitle), '标题');
  assert.equal(genUiTitle(onlyTitle), '标题');
});

test('inlineMarkup 剥掉行内标记', () => {
  assert.equal(inlineMarkup('**粗** `码` ==亮=='), '粗 码 亮');
  assert.equal(inlineMarkup('无标记'), '无标记');
});

test('inlineMarkup 把链接与图片还原成文字', () => {
  // 裸的 `[文字](链接)` 在屏幕上比什么都难看，链接本身又不该被当成可见正文。
  assert.equal(inlineMarkup('见 [signing/README](https://x/y.md) 一节'), '见 signing/README 一节');
  assert.equal(inlineMarkup('![示意图](https://x/a.png)'), '示意图');
});

test('inlineMarkup 剥删除线与星号斜体', () => {
  assert.equal(inlineMarkup('~~废弃~~'), '废弃');
  assert.equal(inlineMarkup('这是 *重点* 内容'), '这是 重点 内容');
});

test('inlineMarkup 不碰下划线系标记，避免改坏标识符', () => {
  // CommonMark 靠词边界躲开 `a_b_c` 这种坑，正则做不到 —— 宁可少认两种写法。
  assert.equal(inlineMarkup('entry_default 与 __init__ 保持原样'),
    'entry_default 与 __init__ 保持原样');
});

test('inlineMarkup 不把带空格的星号当成斜体', () => {
  assert.equal(inlineMarkup('5 * 3 = 15'), '5 * 3 = 15');
});

test('数值访问器按 kotlinx 语义取值', () => {
  const node = parseGenUi('{"items":[{"type":"stat","value":3,"ratio":1.5,"flag":true,"label":"x"}]}')!.items[0];
  assert.equal(genUiInt(node, 'value'), 3);
  // 非整数给 null，而不是像 JS Number() 那样悄悄接受。
  assert.equal(genUiInt(node, 'ratio'), null);
  assert.equal(genUiNumber(node, 'ratio'), 1.5);
  assert.equal(genUiNumber(node, 'value'), 3);
  assert.equal(genUiBool(node, 'flag'), true);
  assert.equal(genUiBool(node, 'value'), null);
  assert.equal(genUiStr(node, 'label'), 'x');
  assert.equal(genUiStr(node, 'missing'), null);
});

test('诊断：纯文字 → 明确报「正常」', () => {
  const diagnosis = diagnoseGenUi('就是一段纯文字');
  assert.equal(diagnosis.summary, '无 dsh-ui 围栏（正常，本条纯文字）');
  assert.equal(diagnosis.details, 'fences=0');
});

test('诊断：dsh-ui 围栏未闭合 → 报「流式输出中」而非故障', () => {
  // 绝不能报成故障，否则用户会盯着一个「⚠」等它自己消失。
  const diagnosis = diagnoseGenUi('a\n```dsh-ui\n{"a"');
  assert.equal(diagnosis.summary, 'dsh-ui 围栏已识别，尚未闭合（流式输出中）');
  assert.equal(diagnosis.details, '围栏头=1 闭合=0 —— 等输出结束会自动切成卡片');
});

test('诊断：无标记围栏 → 真故障，如实报数量', () => {
  const diagnosis = diagnoseGenUi('a\n```\nx\n```\n');
  assert.match(diagnosis.summary, /2 个无标记/);
  assert.match(diagnosis.details, /裸标记=2/);
});

test('诊断：正常卡片 → ✓ 且围栏只算 1 个头（裸反引号不算头）', () => {
  const diagnosis = diagnoseGenUi('a\n```dsh-ui\n{"items":[{"type":"text","content":"hi"}]}\n```\n');
  assert.equal(diagnosis.summary, 'dsh-ui ✓ ui=1 节点=1(text)');
  assert.match(diagnosis.details, /围栏头=1（其中 dsh-ui=1）/);
});

test('诊断：坏 JSON 会点名失败数量与首个失败原因', () => {
  const diagnosis = diagnoseGenUi('a\n```dsh-ui\n{bad json}\n```\n');
  assert.equal(diagnosis.summary, '⚠ 卡片 JSON 解析失败 ×1');
  assert.match(diagnosis.details, /解析成功=0 失败=1/);
  assert.match(diagnosis.details, /首个失败片段：/);
});
