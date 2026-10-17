import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 中英资源一致性门禁 —— 补上一条**真实缺陷**暴露出来的空白。
 *
 * ## 为什么需要它
 *
 * 本项目资源分 `base/element/string.json`（默认中文兜底）与 `en_US/element/string.json`（英文）。
 * 两者的键集必须**一一对应**：`base` 是默认语言，缺键时 `$r('app.string.x')` 在中文界面会直接
 * 取不到值；占位符（`%s` / `%d`）不一致则会在运行时把参数丢掉或串位。
 *
 * 本轮移植时发现 `base` 竟然缺了 12 个界面正在引用的键（`retry` / `build_stamp` / `appearance` /
 * `font_scale_*` / `theme_*`）——因为第 1/2 批把文案只写进了 `en_US`，`base` 侧被工具层覆盖丢失
 * （见 `docs/PORT-MAP.md` 坑 35）。这类不一致**不会让编译变红**，只会静默地让中文界面少文字，
 * 所以它得自己有一条门禁盯着。
 *
 * ## 读盘而不是 Grep
 *
 * 本文件用 `readFileSync` 直读磁盘（Node 读真实文件系统）。这与 `docs/PORT-MAP.md` 坑 28 的教训
 * 一致：在 FUSE 挂载点上 `Grep` 会读到过期视图，`Read`/直读才是真相。门禁必须读真相。
 */

const HERE: string = dirname(fileURLToPath(import.meta.url));
const ROOT: string = join(HERE, '..', '..');
const BASE: string = join(ROOT, 'entry', 'src', 'main', 'resources', 'base', 'element', 'string.json');
const EN: string = join(ROOT, 'entry', 'src', 'main', 'resources', 'en_US', 'element', 'string.json');

interface Entry {
  name: string;
  value: string;
}

function load(path: string): Entry[] {
  const raw: string = readFileSync(path, 'utf8');
  const parsed: { string: Entry[] } = JSON.parse(raw) as { string: Entry[] };
  return parsed.string;
}

const PLACEHOLDER = /%(\d+\$)?[sd]/g;

function placeholders(value: string): string[] {
  return (value.match(PLACEHOLDER) ?? []).slice().sort();
}

test('base 与 en_US 的字符串键必须一一对应', () => {
  const base: Entry[] = load(BASE);
  const en: Entry[] = load(EN);

  // 盘面自检：两个文件都必须有足够多的键，否则可能是文件被写残或路径解析错。
  assert.ok(base.length >= 350, `base 只解析出 ${base.length} 个键（预期 ≥ 350），盘面不对`);
  assert.ok(en.length >= 350, `en_US 只解析出 ${en.length} 个键（预期 ≥ 350），盘面不对`);

  const baseNames: Set<string> = new Set(base.map((e: Entry): string => e.name));
  const enNames: Set<string> = new Set(en.map((e: Entry): string => e.name));

  assert.equal(
    baseNames.size,
    base.length,
    `base/element/string.json 里有重复键（重复键会让 restool 解析失败）`,
  );
  assert.equal(
    enNames.size,
    en.length,
    `en_US/element/string.json 里有重复键（重复键会让 restool 解析失败）`,
  );

  const onlyBase: string[] = [...baseNames].filter((n: string): boolean => !enNames.has(n)).sort();
  const onlyEn: string[] = [...enNames].filter((n: string): boolean => !baseNames.has(n)).sort();

  const problems: string[] = [];
  if (onlyBase.length > 0) {
    problems.push(`只有 base 有（en_US 缺）：${onlyBase.join('、')}`);
  }
  if (onlyEn.length > 0) {
    problems.push(`只有 en_US 有（base 缺，中文界面会取不到值）：${onlyEn.join('、')}`);
  }
  assert.ok(
    problems.length === 0,
    `base / en_US 的字符串键不一致：\n${problems.join('\n')}\n怎么办：把缺失的键补进另一个文件，` +
      `并在 docs/CHANGELOG.md 记「为什么」（键漂移不会让编译变红，只会静默丢文案）。`,
  );
});

test('同名键的占位符必须一致（否则运行时参数会丢或串位）', () => {
  const baseMap: Map<string, string> = new Map(load(BASE).map((e: Entry): [string, string] => [e.name, e.value]));
  const en: Entry[] = load(EN);

  let checked: number = 0;
  const problems: string[] = [];
  for (const entry of en) {
    const baseValue: string | undefined = baseMap.get(entry.name);
    if (baseValue === undefined) {
      continue;
    }
    checked += 1;
    const a: string[] = placeholders(baseValue);
    const b: string[] = placeholders(entry.value);
    if (a.join('|') !== b.join('|')) {
      problems.push(
        `- ${entry.name}：base=[${a.join(' ')}] en_US=[${b.join(' ')}]`,
      );
    }
  }

  assert.ok(checked >= 350, `只比对了 ${checked} 个同名键（预期 ≥ 350），盘面不对`);
  assert.ok(
    problems.length === 0,
    `同名键的占位符不一致：\n${problems.join('\n')}\n怎么办：对齐两边的 %s/%d，数量与顺序都要一致。`,
  );
});
