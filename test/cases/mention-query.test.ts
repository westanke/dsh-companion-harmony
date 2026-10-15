import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  absolute, activeStart, applySelection, query,
} from '../../entry/src/main/ets/core/MentionQuery.ts';

/**
 * `@` 提及识别与替换的边界用例 —— 逐条对应原工程 `MentionQueryTest.kt`。
 *
 * 这块逻辑的坑全在「什么时候**不**该触发」上：宽松一点就会在正常打字时弹出文件列表，
 * 而那种打扰比不弹更烦人。所以下面一半用例是在测「不该触发」。
 */

// ── activeStart：什么时候该触发 ──

test('行首的 @ 触发', () => {
  assert.equal(activeStart('@'), 0);
  assert.equal(activeStart('@src'), 0);
});

test('空白之后的 @ 触发', () => {
  // 「帮我看看 」是 5 个字符（下标 0..4），@ 落在下标 5。
  assert.equal(activeStart('帮我看看 @src'), 5);
  // " @" 里空格占下标 0，@ 在下标 1。
  assert.equal(activeStart(' @'), 1);
});

test('换行之后的 @ 也触发', () => {
  // 多行输入时用户在第二行打 @ —— 换行属于空白，同样算新词开始。
  assert.equal(activeStart('ab\n@x'), 3);
});

// ── activeStart：什么时候不该触发（重点）──

test('邮箱形态不触发', () => {
  // `foo@bar.com` 里的 @ 前面是字母，那是个邮箱不是提及。
  // 这条是整块逻辑存在的理由：宽松匹配会在用户正常打字时弹列表。
  assert.equal(activeStart('foo@bar.com'), null);
  assert.equal(activeStart('联系我 foo@bar.com'), null);
});

test('光标已离开提及词时不触发', () => {
  // 打完 @src 又敲了空格，说明这个词结束了 —— 补全不该还挂着。
  assert.equal(activeStart('@src '), null);
  assert.equal(activeStart('@src 后面还有字'), null);
});

test('完全没有 @ 时不触发', () => {
  assert.equal(activeStart(''), null);
  assert.equal(activeStart('普通文本'), null);
});

test('取的是最后一个未闭合的 @', () => {
  // "@src @li"：下标 0 那个 @src 已经闭合（后面有空格），
  // 真正的光标在第二个 @ 后面，它在下标 5。
  assert.equal(activeStart('@src @li'), 5);
});

test('全角空格与不换行空格也算空白，@ 一样触发', () => {
  // Kotlin 的 isWhitespace 覆盖 Zs 全部，所以这两个字符后面的 @ 都算新词开始。
  assert.equal(activeStart('\u3000@a'), 1);
  assert.equal(activeStart('\u00A0@a'), 1);
});

test('U+FEFF 不算空白，所以它后面的 @ 不触发', () => {
  // 与 Kotlin 口径一致：BOM 是普通字符，`\uFEFF@a` 里的 @ 前面「有字」，不构成提及。
  assert.equal(activeStart('\uFEFF@a'), null);
});

// ── query：正在输入的查询串 ──

test('query 取 @ 之后那段', () => {
  assert.equal(query('@src'), 'src');
  assert.equal(query('看看 @li'), 'li');
  assert.equal(query('@'), '');
});

test('没有活跃提及则 query 为 null', () => {
  assert.equal(query('普通文本'), null);
  assert.equal(query('foo@bar.com'), null);
});

// ── applySelection：替换而非整行覆盖 ──

test('只替换 @ 到末尾那一段', () => {
  // 关键：前半句必须留着。整行替换会把「帮我看看」吃掉。
  assert.equal(applySelection('帮我看看 @src', '@/w/src '), '帮我看看 @/w/src ');
});

test('纯提及被完整替换', () => {
  assert.equal(applySelection('@a', '@/w/a.txt '), '@/w/a.txt ');
});

test('目录结尾不带空格以便继续下拉', () => {
  // 目录补 `/` 不补空格：用户接着打下一级正好接上。
  assert.equal(applySelection('@s', '@/w/src/'), '@/w/src/');
});

test('没有活跃提及时退化为直接追加', () => {
  assert.equal(applySelection('普通文本', 'x'), '普通文本x');
});

// ── absolute：把「相对授权根的条目路径」换成绝对路径 ──
//
// 关键语义：列举接口给的 entryPath 是**相对授权根**的完整路径，会话工作目录只是它的
// 一段前缀 —— 所以这里是「换前缀」，不是「cwd + 相对路径」那种拼接。
// 旧实现与旧测试都按后一种理解写，于是 `@` 插进输入框的是错的路径。

test('会话目录在根下时换掉前缀', () => {
  assert.equal(absolute('/r/ws', 'ws', 'ws/a.txt'), '/r/ws/a.txt');
  assert.equal(absolute('/r/ws', 'ws', 'ws/深/一层.kt'), '/r/ws/深/一层.kt');
});

test('会话目录就是授权根本身时直接接上', () => {
  // cwd 为空串是**合法值**：path.relative(root, root) === ''。此时 cwdAbsolute 即根。
  // 线上那句「读不到这个会话的工作目录」就是因为把它当成了「没有工作目录」。
  assert.equal(absolute('/r', '', 'a.txt'), '/r/a.txt');
  assert.equal(absolute('/r', '', ''), '/r');
});

test('绝对路径结尾的多余斜杠不会拼出双斜杠', () => {
  assert.equal(absolute('/r/ws/', 'ws', 'ws/a.txt'), '/r/ws/a.txt');
  assert.equal(absolute('/r/ws///', 'ws', 'ws/a.txt'), '/r/ws/a.txt');
});

test('前缀按整段比对，不误配同前缀的兄弟目录', () => {
  // "ws" 不能把 "wsx/a.txt" 的前缀吃掉 —— 那会拼出一个不存在的路径，
  // 而模型拿到无效路径只会白白失败一次。
  assert.equal(absolute('/r/ws', 'ws', 'wsx/a.txt'), 'wsx/a.txt');
});

test('拿不到绝对根时退化成相对根的路径', () => {
  // 老服务端不返回 cwdAbsolute：这里是降级，但比硬拼一个错的绝对路径强。
  assert.equal(absolute(null, 'ws', 'ws/a.txt'), 'ws/a.txt');
  assert.equal(absolute('', 'ws', 'ws/a.txt'), 'ws/a.txt');
  assert.equal(absolute('   ', 'ws', 'ws/a.txt'), 'ws/a.txt');
});

test('cwdRelative 前后的空白与斜杠都先裁掉', () => {
  assert.equal(absolute('/r/ws', ' ws ', 'ws/a.txt'), '/r/ws/a.txt');
  assert.equal(absolute('/r/ws', '/ws/', 'ws/a.txt'), '/r/ws/a.txt');
});

test('前缀与条目路径完全相同时结果是根目录本身', () => {
  // entryPath == prefix 是「工作目录自身」这一行，tail 为空 → 只剩根。
  assert.equal(absolute('/r/ws', 'ws', 'ws'), '/r/ws');
});

test('条目路径不以工作目录前缀开头时，退回它自己（不硬拼）', () => {
  // entryPath 理论上总是「相对授权根」，会带着工作目录前缀；若拿到的竟然是别的形态，
  // 就按原工程的降级策略返回它本身 —— 绝不硬拼一个错的绝对路径。
  assert.equal(absolute('/r/ws', 'ws', '/a.txt'), '/a.txt');
  assert.equal(absolute('/r/ws', 'ws', 'other/a.txt'), 'other/a.txt');
});
