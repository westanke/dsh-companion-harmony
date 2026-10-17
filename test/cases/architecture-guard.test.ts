import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 架构纪律的可执行门禁 —— 对位原工程 `ArchitectureGuardTest.kt`。
 *
 * ## 这个文件为什么存在
 *
 * `AGENTS.md` §4 立了一堆纪律：900 行预算、公开台账、唯一网络边界、`ui/` 不读偏好、
 * 会话展示单一出口。但这些纪律此前**只活在文档里**，全靠人自觉。本文件把纪律变成会红的断言。
 *
 * ## 危险失败模式：静默全绿
 *
 * 门禁最可怕的不是「太严」，是**「路径解析错了、什么都没扫到、于是全绿」** —— 那比没有门禁
 * 更坏，因为它会冒充证据。所以每个测试开头都先跑「盘面自检」(`sanity`)：扫到的文件数必须
 * ≥ 阈值，任何一条不成立就**红**。
 *
 * ## 与源工程的三处有意差异（都是为了不写成恒绿的空转断言）
 *
 * 1. **坑位索引 ↔ 正文双向一致**：源工程 `PITFALLS.md` 的正文标题与索引条目**同名**，所以能
 *    直接双向比对。本仓的索引（`AGENTS.md` §7）是**触发词**（「布局溢出系统手势区」），
 *    正文（`docs/PORT-MAP.md`）是**编号**（「坑 13：底部那半条『输入框消失』…」），两者
 *    **本就不同名**。硬写双向比对只会恒红，或逼人把有检索价值的触发词删掉。故本条**不移植**，
 *    改在 `docs/CHANGELOG.md` / `AGENTS.md` §8 如实记为「刻意未引入」。
 * 2. **`@patch` 五要素**：本仓`AGENTS.md` §8 明确「暂未引入」，全仓 0 处 `// @patch`，
 *    写成断言就是一条永不触发的空转门禁 —— 不写。
 * 3. **网络边界判据取 `import` 行**，而不是裸符号：本仓 `core/` 下有多处**注释**提到
 *    `@ohos.net.http`（解释错误码来源），取裸符号会把正确的注释判成违规。
 */

const HERE: string = dirname(fileURLToPath(import.meta.url));
const ROOT: string = join(HERE, '..', '..');
const ETS_ROOT: string = join(ROOT, 'entry', 'src', 'main', 'ets');
const DEBT_DOC: string = join(ROOT, 'docs', 'TECH-DEBT.md');

/** 行数预算（`AGENTS.md` §4.2：900 行/文件）。超预算文件必须在 `docs/TECH-DEBT.md` 登记。 */
const LINE_BUDGET: number = 900;

/** 网络边界：只有 `platform/` 下的传输实现允许 import 这两条 NetStack 模块。 */
const NETWORK_MODULES: string[] = ["'@kit.NetworkKit'", "'@ohos.net.http'", "'@ohos.net.webSocket'"];

/** 表现层不得把偏好当状态（`AGENTS.md` §4.1）。 */
const PREF_SYMBOLS: string[] = ['PrefsStore', 'SharedPreferences', '@ohos.data.preferences'];

function rel(abs: string): string {
  return relative(ROOT, abs).split('\\').join('/');
}

function walk(dir: string, acc: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const abs: string = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      walk(abs, acc);
    } else if (entry.endsWith('.ets') || (entry.endsWith('.ts') && !entry.endsWith('.d.ts'))) {
      acc.push(abs);
    }
  }
  return acc;
}

/** 归一化路径：`entry/src/main/ets/` 之后的相对路径（如 `ui/ChatDetail.ets`）。 */
function packagePath(abs: string): string {
  const r: string = rel(abs);
  const prefix: string = 'entry/src/main/ets/';
  return r.startsWith(prefix) ? r.slice(prefix.length) : r;
}

/** 行数与 `wc -l` 对齐：按换行符计数，末尾单个换行不算一行。 */
function lineCount(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  let lines: number = text.split('\n').length;
  if (text.endsWith('\n')) {
    lines -= 1;
  }
  return lines;
}

function isCommentLine(line: string): boolean {
  const t: string = line.trim();
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('*/');
}

/** 盘面自检：不成立就红，绝不静默跳过。 */
function sanity(ok: boolean, message: string): void {
  assert.ok(ok, `盘面自检失败（${message}）—— 门禁可能扫空了，这比没有门禁更坏`);
}

// ---------------------------------------------------------------- §4.2 行数预算

test('行数预算 900 超预算文件必须已在债务台账登记', () => {
  const files: string[] = walk(ETS_ROOT, []);
  sanity(files.length >= 60, `entry/src/main/ets 下只扫到 ${files.length} 个源文件（预期 ≥ 60），盘面不对`);

  const debt: string[] = readFileSync(DEBT_DOC, 'utf8').split('\n')
    .map((l: string): string => l.split('`').join('').split('*').join(''));

  /** 台账行是否登记了「路径 + 记录行数 ≥ 实际行数」。 */
  const registered = (candidates: string[], actual: number): boolean => {
    for (const line of debt) {
      if (!candidates.some((c: string): boolean => line.includes(c))) {
        continue;
      }
      const numbers: number[] = (line.match(/\d+/g) ?? []).map((n: string): number => Number.parseInt(n, 10));
      if (numbers.some((n: number): boolean => n >= actual)) {
        return true;
      }
    }
    return false;
  };

  const violations: string[] = [];
  let exempt: number = 0;
  for (const abs of files) {
    const actual: number = lineCount(readFileSync(abs, 'utf8'));
    if (actual <= LINE_BUDGET) {
      continue;
    }
    const candidates: string[] = [packagePath(abs), rel(abs)];
    if (registered(candidates, actual)) {
      exempt += 1;
    } else {
      violations.push(
        `- 文件：${rel(abs)}（台账里的写法：${packagePath(abs)}）实际行数：${actual}，超出预算 ${actual - LINE_BUDGET} 行；` +
          `docs/TECH-DEBT.md 里没有「路径 + 记录行数 ≥ ${actual}」的登记`,
      );
    }
  }

  assert.ok(
    violations.length === 0,
    `违反 AGENTS.md §4.2（行数预算 ${LINE_BUDGET} 行/文件，债务台账只许收紧）：\n${violations.join('\n')}\n` +
      `怎么办：把文件按职责拆到 ${LINE_BUDGET} 行以内（首选）；确需保留就在 docs/TECH-DEBT.md 立一行表格，` +
      `登记「路径 + 新行数 + 为什么是债 + 清账阶段」，并保证登记行数 ≥ 实际行数。已合规登记的文件数：${exempt}。`,
  );
});

// ---------------------------------------------------------------- §4.1 唯一网络边界

test('唯一网络边界：只有 platform/ 允许 import NetStack 模块', () => {
  const files: string[] = walk(ETS_ROOT, []);
  sanity(files.length >= 60, `只扫到 ${files.length} 个源文件，盘面不对`);

  /** 至少要扫到一个真实 import，否则判据可能恒绿。 */
  let boundaryHits: number = 0;
  const violations: string[] = [];
  for (const abs of files) {
    const pkg: string = packagePath(abs);
    const lines: string[] = readFileSync(abs, 'utf8').split('\n');
    lines.forEach((line: string, index: number): void => {
      if (!NETWORK_MODULES.some((m: string): boolean => line.includes(m))) {
        return;
      }
      if (!line.includes('import') || isCommentLine(line)) {
        return;
      }
      boundaryHits += 1;
      if (!pkg.startsWith('platform/')) {
        violations.push(`- ${rel(abs)}:${index + 1} 直接 import 了 NetStack 模块：${line.trim()}`);
      }
    });
  }

  sanity(boundaryHits >= 2, `全仓只找到 ${boundaryHits} 处 NetStack import（预期 ≥ 2），判据可能写错了`);
  assert.ok(
    violations.length === 0,
    `违反 AGENTS.md §4.1：DshClient（+ platform/）是唯一网络边界，表现层/核心层不得直接发网络请求。\n` +
      `${violations.join('\n')}\n怎么办：把网络调用下沉到 core/DshClient.ts 经 platform/ 传输实现，界面只调 vm 动作。`,
  );
});

// ---------------------------------------------------------------- §4.1 ui 不读偏好

test('ui 层不得把偏好当状态', () => {
  const uiFiles: string[] = walk(ETS_ROOT, [])
    .filter((abs: string): boolean => packagePath(abs).startsWith('ui/'));
  sanity(uiFiles.length >= 10, `ui/ 下只扫到 ${uiFiles.length} 个源文件（预期 ≥ 10），盘面不对`);

  const violations: string[] = [];
  const allowedComments: string[] = [];
  for (const abs of uiFiles) {
    readFileSync(abs, 'utf8').split('\n').forEach((line: string, index: number): void => {
      if (!PREF_SYMBOLS.some((s: string): boolean => line.includes(s))) {
        return;
      }
      const at: string = `${rel(abs)}:${index + 1}`;
      if (isCommentLine(line)) {
        allowedComments.push(at);
      } else {
        violations.push(`- ${at} 代码里出现偏好符号：${line.trim()}`);
      }
    });
  }

  assert.ok(
    violations.length === 0,
    `违反 AGENTS.md §4.1：ArkUI 表现层不得读偏好当状态（改了不触发重绘）。\n${violations.join('\n')}\n` +
      `怎么办：ui/ 只消费 HarnessState；偏好值由 core 侧读出放进 state，界面用 state.xxx + vm 动作。` +
      `（本次放行的整行注释：${allowedComments.length === 0 ? '无' : allowedComments.join('、')}——放行是刻意的，理由见本文件 KDoc。）`,
  );
});

// ---------------------------------------------------------------- §4.1 会话展示单一出口

test('会话展示单一出口：displayItemsOf 只许在 core/ 里有一份', () => {
  const files: string[] = walk(ETS_ROOT, []);
  sanity(files.length >= 60, `只扫到 ${files.length} 个源文件，盘面不对`);

  const definitions: string[] = [];
  const uiImports: string[] = [];
  for (const abs of files) {
    const pkg: string = packagePath(abs);
    const lines: string[] = readFileSync(abs, 'utf8').split('\n');
    lines.forEach((line: string, index: number): void => {
      if (/export\s+function\s+displayItemsOf\s*\(/.test(line)) {
        definitions.push(`${rel(abs)}:${index + 1}`);
      }
      if (pkg.startsWith('ui/') && line.includes('displayItemsOf') && !isCommentLine(line)) {
        uiImports.push(`${rel(abs)}:${index + 1} ${line.trim()}`);
      }
    });
  }

  sanity(definitions.length >= 1, `全仓找不到 displayItemsOf 的定义，判据可能写错了`);
  assert.equal(
    definitions.length,
    1,
    `会话展示必须走单一出口：displayItemsOf 只许有一份定义，实际找到 ${definitions.length} 份：\n${definitions.join('\n')}`,
  );
  assert.ok(
    definitions[0].startsWith('entry/src/main/ets/core/'),
    `displayItemsOf 必须定义在 core/ 层，实际在 ${definitions[0]}`,
  );
  assert.ok(
    uiImports.length === 0,
    `ui/ 不得直接调用展示出口 displayItemsOf（会绕过 core 的过滤口径）：\n${uiImports.join('\n')}`,
  );
});
