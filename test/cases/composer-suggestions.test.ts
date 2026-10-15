import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  commandSuggestions, composerOverlayActive, mentionMatches,
} from '../../entry/src/main/ets/core/ComposerSuggestions.ts';
import { CommandDescriptor, FileEntry } from '../../entry/src/main/ets/core/Models.ts';

/**
 * 两个补全面板的判据 —— 逐条对应原工程 `ui/ChatScreen.kt` 里
 * `MentionSuggestions` / `commandSuggestions` 的行为。
 *
 * 这块的重点全在"什么时候**不**列"上：多列一条会让用户挑错命令、多看几个不该看的文件；
 * 少列一条（尤其是目录被截掉）则会让"往里继续选"这个动作永远做不成。
 */

function file(name: string, kind: string, path: string = name, size: number = 0): FileEntry {
  const v: FileEntry = new FileEntry();
  v.name = name;
  v.path = path;
  v.kind = kind;
  v.size = size;
  return v;
}

function cmd(name: string): CommandDescriptor {
  const v: CommandDescriptor = new CommandDescriptor();
  v.name = name;
  return v;
}

// ── mentionMatches：三态与过滤 ──

test('entries 为 null（还没读到）时返回空列表', () => {
  // null 是"还没读到 / 读不到"，不是"空目录" —— 面板自己按 failed 说话，这里不猜。
  assert.deepEqual(mentionMatches(null, 'a'), []);
});

test('空目录返回空列表', () => {
  assert.deepEqual(mentionMatches([], 'a'), []);
});

test('空查询列出所有条目', () => {
  const entries: FileEntry[] = [file('b.txt', 'file'), file('a.txt', 'file')];
  assert.equal(mentionMatches(entries, '').length, 2);
});

test('过滤按名字包含，且大小写不敏感', () => {
  const entries: FileEntry[] = [file('README.md', 'file'), file('main.ts', 'file')];
  assert.deepEqual(
    mentionMatches(entries, 'readme').map((e: FileEntry): string => e.name),
    ['README.md'],
  );
  assert.deepEqual(
    mentionMatches(entries, 'MAIN').map((e: FileEntry): string => e.name),
    ['main.ts'],
  );
});

test('过滤不命中路径，只命中名字', () => {
  // 源工程的判据是 name.contains(query)：第二行显示的相对路径不参与过滤，
  // 否则用户在 `@` 后输入一段目录名会莫名筛出一堆同级文件。
  const entries: FileEntry[] = [file('a.txt', 'file', 'deep/nested/a.txt')];
  assert.deepEqual(mentionMatches(entries, 'nested'), []);
});

// ── mentionMatches：排序与限量 ──

test('目录排在文件前面', () => {
  const entries: FileEntry[] = [
    file('a.txt', 'file'),
    file('zdir', 'directory'),
    file('b.txt', 'file'),
  ];
  assert.deepEqual(
    mentionMatches(entries, '').map((e: FileEntry): string => e.name),
    ['zdir', 'a.txt', 'b.txt'],
  );
});

test('同类之内按小写名升序', () => {
  const entries: FileEntry[] = [file('b', 'file'), file('A', 'file'), file('a', 'file')];
  assert.deepEqual(
    mentionMatches(entries, '').map((e: FileEntry): string => e.name),
    // 'A' 与 'a' 的小写相同 → 稳定排序保持原序（'A' 在 'a' 之前）。
    ['A', 'a', 'b'],
  );
});

test('未知 kind 一律当文件处理', () => {
  // kind 是服务端字符串，界面兜底不抛错；排序里只有字面量 'directory' 才算目录。
  const entries: FileEntry[] = [file('x', 'weird')];
  assert.equal(mentionMatches(entries, '')[0].isDirectory(), false);
});

test('超过 50 条时截断到 50（先排序再截）', () => {
  const entries: FileEntry[] = [];
  for (let i = 0; i < 120; i++) {
    entries.push(file(`f${i.toString().padStart(3, '0')}`, 'file'));
  }
  const got: FileEntry[] = mentionMatches(entries, '');
  assert.equal(got.length, 50);
  assert.equal(got[0].name, 'f000');
  assert.equal(got[49].name, 'f049');
});

test('目录不会被文件挤掉：60 个文件 + 1 个目录时目录仍列在首位', () => {
  // 这条钉的是「先排序再截断」的顺序 —— 若改成先截断，目录会被文件挤出去。
  const entries: FileEntry[] = [file('zzz-dir', 'directory')];
  for (let i = 0; i < 60; i++) {
    entries.push(file(`f${i.toString().padStart(3, '0')}`, 'file'));
  }
  assert.equal(mentionMatches(entries, '')[0].name, 'zzz-dir');
});

// ── commandSuggestions：行首语法 ──

test('不以斜杠开头时不显示', () => {
  assert.deepEqual(commandSuggestions('pl', [cmd('plan')]), []);
  assert.deepEqual(commandSuggestions('', [cmd('plan')]), []);
});

test('只有一个斜杠时列出全部（最多 5 条）', () => {
  const commands: CommandDescriptor[] = [cmd('compact'), cmd('export')];
  assert.deepEqual(
    commandSuggestions('/', commands).map((c: CommandDescriptor): string => c.name),
    ['compact', 'export'],
  );
});

test('按前缀过滤，且大小写不敏感', () => {
  const commands: CommandDescriptor[] = [cmd('compact'), cmd('plan'), cmd('permission')];
  assert.deepEqual(
    commandSuggestions('/p', commands).map((c: CommandDescriptor): string => c.name),
    ['plan', 'permission'],
  );
  assert.deepEqual(
    commandSuggestions('/P', commands).map((c: CommandDescriptor): string => c.name),
    ['plan', 'permission'],
  );
});

test('斜杠之后出现空白就说明在打参数，面板收起', () => {
  // 关键：命令名是行首语法，"/plan --force" 已经在写参数了，不该再挑命令。
  assert.deepEqual(commandSuggestions('/plan ', [cmd('plan')]), []);
  assert.deepEqual(commandSuggestions('/ plan', [cmd('plan')]), []);
  assert.deepEqual(commandSuggestions('/plan\tx', [cmd('plan')]), []);
});

test('全角空格同样让面板收起', () => {
  // Kotlin 的 isWhitespace 覆盖 Zs 全部，与 @ 提及的空白口径一致。
  assert.deepEqual(commandSuggestions('/plan\u3000', [cmd('plan')]), []);
});

test('removePrefix 只去掉一个前缀斜杠，第二根斜杠参与前缀匹配', () => {
  // "//x" → query 是 "/x"，没有任何命令名以 "/" 开头 → 空列表。
  // 若误写成 replace 全去斜杠，这里会返回匹配 'x' 的命令，是个只在手打时才暴露的 bug。
  assert.deepEqual(commandSuggestions('//x', [cmd('x')]), []);
});

test('超过 5 条时截断到 5', () => {
  const commands: CommandDescriptor[] = [];
  for (let i = 0; i < 9; i++) {
    commands.push(cmd(`c${i.toString()}`));
  }
  assert.equal(commandSuggestions('/', commands).length, 5);
});

test('过滤保持命令清单的原有顺序', () => {
  // 源工程是 filter（不是 sort）：命令清单的顺序由服务端给定，界面不该重排。
  const commands: CommandDescriptor[] = [cmd('zebra'), cmd('apple')];
  assert.deepEqual(
    commandSuggestions('/', commands).map((c: CommandDescriptor): string => c.name),
    ['zebra', 'apple'],
  );
});

// ── composerOverlayActive：两个判据的并 ──

test('@ 提及活跃时面板开着', () => {
  assert.equal(composerOverlayActive('@src', []), true);
  assert.equal(composerOverlayActive('看看 @src', []), true);
});

test('命令前缀命中时面板开着', () => {
  assert.equal(composerOverlayActive('/pl', [cmd('plan')]), true);
});

test('普通文本、邮箱、打完命令后都算关着', () => {
  assert.equal(composerOverlayActive('普通文本', [cmd('plan')]), false);
  assert.equal(composerOverlayActive('foo@bar.com', [cmd('plan')]), false);
  assert.equal(composerOverlayActive('/plan --force', [cmd('plan')]), false);
  // 有命令前缀但没有任何命令匹配 → 面板不显示，判据也该为假。
  assert.equal(composerOverlayActive('/zzz', [cmd('plan')]), false);
});
