/**
 * 界面接线门禁 —— 钉住三类「错了也不报错、只是界面不更新」的接线错误。
 *
 * 这类缺陷的共同点：**编译通过、单测全绿、真机上只是"看不出变化"**。
 * 它们不属于 core 的纯逻辑，没法用行为用例覆盖，只能用「源码形状」当门禁：
 * 断言的是一段接线代码**必须存在**（或必须不存在），而不是某次调用的返回值。
 *
 * 三条都对应真机反馈：
 * 1. 点会话里的文件 → 面板只出路径、再点一次才出内容（面板拿到了过期的状态快照）。
 * 2. 同一个面板下方留白很大（FIT_CONTENT 面板里写了百分比高度）。
 * 3. 网络不通时连接页一片「连接」、失败原因没人报（`AppShell` 在未连接时根本没挂载）。
 *
 * 与 `architecture-guard.test.ts` 同一纪律：读**真实磁盘**上的源码，每个用例开头
 * 先做盘面自检（扫到的文件数/关键片段不足即红），杜绝「路径写错、什么都没读到、于是全绿」。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE: string = dirname(fileURLToPath(import.meta.url));
const ROOT: string = join(HERE, '..', '..');
const UI: string = join(ROOT, 'entry', 'src', 'main', 'ets', 'ui');

function read(name: string): string {
  return readFileSync(join(UI, name), 'utf8');
}

/** 盘面自检：不成立就红，绝不静默跳过。 */
function sanity(ok: boolean, message: string): void {
  assert.ok(ok, `盘面自检失败（${message}）—— 门禁可能读空了，这比没有门禁更坏`);
}

/** 去掉整行注释，只留代码 —— 否则本文件 KDoc 里引用的写法会把自己判红。 */
function codeLines(text: string): string[] {
  return text
    .split('\n')
    .filter((line: string): boolean => {
      const t: string = line.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    });
}

// ---------------------------------------------------------------- 面板必须自订阅

/**
 * `bindSheet` 的 content builder **不会**因为 vm 的一次 `update()` 重新执行。
 *
 * 所以面板组件的状态绝不能靠父组件「往下传」：那一份参数只在面板首次构建时求值，
 * 之后永远停在那一帧。而文件面板的首帧恰好是 `openSessionFile` 刚放进状态的**占位**
 * （只有路径、`loading=true`），异步内容回来换了新实例，面板却看不到 —— 真机表现就是
 * 「点击文件只弹路径，要再点一次才显示内容」（关掉再点会重建组件，于是"第二次就好了"）。
 *
 * 正确写法是面板自己 `@StorageLink('dshRevision') + harnessState()` 现读
 * （`JobsSheet` / `SessionFilesSheet` 现在都是这套）。
 */
test('面板组件必须自订阅 vm，不许靠父组件传状态快照', () => {
  const sheets: string[] = ['JobsSheet.ets', 'SessionFilesSheet.ets'];
  const texts: string[] = sheets.map((name: string): string => read(name));
  sanity(
    texts.every((t: string): boolean => t.includes("StorageLink('dshRevision')")),
    `面板文件缺少 @StorageLink('dshRevision')，判据可能写错了`,
  );

  const problems: string[] = [];
  for (let i = 0; i < sheets.length; i++) {
    const lines: string[] = codeLines(texts[i]);
    const hasLink: boolean = lines.some((line: string): boolean => line.includes("StorageLink('dshRevision')"));
    if (!hasLink) {
      problems.push(`- ${sheets[i]} 没有 @StorageLink('dshRevision')，面板不会随 vm 更新重绘`);
    }
  }

  // 文件面板曾把这三样当普通成员往下传（`history` / `open` / `sessionId`）。
  // 只要它们以「无装饰器的成员声明」形式回到面板里，那个 bug 就会原样复活。
  const forbidden: string[] = ['  history: ChatHistory | null = null;', '  open: SessionFileOpen | null = null;', '  sessionId: string | null = null;'];
  const sheetCode: string = codeLines(read('SessionFilesSheet.ets')).join('\n');
  for (const decl of forbidden) {
    if (sheetCode.includes(decl)) {
      problems.push(`- ui/SessionFilesSheet.ets 又出现了普通成员 \`${decl.trim()}\`（只会在首帧收值）`);
    }
  }

  assert.ok(
    problems.length === 0,
    `违反「面板自订阅」接线：\n${problems.join('\n')}\n` +
      `怎么办：面板里用 @StorageLink('dshRevision') + harnessState() 现读，父组件只传回调。`,
  );
});

// ---------------------------------------------------------------- FIT_CONTENT 内不许百分比高度

/**
 * `SheetSize.FIT_CONTENT` 的语义是「内容多高、面板多高」，此时**没有确定的父高度**
 * 供百分比参照，`height('72%')` 只能按整屏算 —— 面板被撑到贴满，条目少的时候
 * 下方就是一大片空白（真机反馈「弹窗下面留白很大」）。
 *
 * 判据：走 FIT_CONTENT 的面板源码里不许出现 `height('NN%')`。
 */
test('FIT_CONTENT 面板内不许用百分比高度', () => {
  const sheets: string[] = ['JobsSheet.ets', 'SessionFilesSheet.ets'];
  const all: string = sheets.map((name: string): string => read(name)).join('\n');
  sanity(all.includes('constraintSize'), `面板文件里找不到 constraintSize，判据可能写错了`);

  const violations: string[] = [];
  for (const name of sheets) {
    const lines: string[] = read(name).split('\n');
    lines.forEach((line: string, index: number): void => {
      const t: string = line.trim();
      if (t.startsWith('//') || t.startsWith('*')) {
        return;
      }
      if (/\.height\(\s*'[0-9.]+%'\s*\)/.test(line)) {
        violations.push(`- ui/${name}:${index + 1} ${t}`);
      }
    });
  }

  assert.ok(
    violations.length === 0,
    `面板走 FIT_CONTENT，百分比高度会按整屏算，导致面板过高 + 下方大留白：\n${violations.join('\n')}\n` +
      `怎么办：用 constraintSize({ maxHeight: N })，内容不足时只占内容高度。`,
  );
});

// ---------------------------------------------------------------- 展开态必须留收回入口

/**
 * 思考条原先把「折叠标题行」整行换成了展开正文 —— 展开之后界面上再没有任何东西
 * 提示这里能点，用户只能靠记忆去点那片文字，真机反馈就是「拉开之后没有可以收回的按钮」。
 *
 * 正确形状（与源工程 `ChatThinkBar` 一致）：**标题行常驻**，正文接在它下面，
 * 行尾有一个方向箭头 `⌄` / `⌃` 当可见凭据；点击只挂在标题行上，
 * 避免用户在全文里拖动滚动时被当成点击而收回。
 */
test('思考条展开后必须仍留着标题行与收回箭头', () => {
  const text: string = read('ChatStatusBar.ets');
  const from: number = text.indexOf('thinkBar()');
  const to: number = text.indexOf('build()', from);
  sanity(from >= 0 && to > from, `ChatStatusBar.ets 里定位不到 thinkBar() 主体`);
  const body: string = text.substring(from, to);

  // 箭头必须两种朝向都在（同一行三元表达式里切换）
  const hasCollapseGlyph: boolean = body.includes("'⌃'");
  const hasExpandGlyph: boolean = body.includes("'⌄'");
  assert.ok(
    hasCollapseGlyph && hasExpandGlyph,
    `思考条缺少方向箭头（⌄ 折叠态 / ⌃ 展开态）—— 用户看不到"能收回"的凭据：\n${body.slice(0, 400)}`,
  );

  // 标题行必须排在展开分支之前：先出现 LoadingProgress（标题行），再出现 if (this.expanded)
  const headerAt: number = body.indexOf('LoadingProgress()');
  const branchAt: number = body.indexOf('if (this.expanded)');
  assert.ok(headerAt >= 0, `思考条里找不到标题行（LoadingProgress）`);
  assert.ok(branchAt > headerAt, `标题行被放进了展开分支里 —— 展开后它就消失了，等于没有收回入口`);

  // 点击要挂在标题行上（在展开分支之前），而不是整列
  const clickAt: number = body.indexOf('.onClick(');
  assert.ok(clickAt >= 0 && clickAt < branchAt, `onClick 没有挂在标题行上（或在展开分支之后）—— 拖动正文会误触收起`);
});

// ---------------------------------------------------------------- 连接页必须自己报错

/**
 * `state.error` 的显示原先只写在 `AppShell` 里，而 `AppShell` **只在连上之后才挂载**。
 * 于是连接失败（网络不通）时 `connectHostInternal` 写了 `s.error`，却没有任何一处
 * 把它显示出来：标题、按钮、配对按钮全还写着「连接」，用户看不出刚才失败过。
 *
 * 源工程 `App.kt` 把 Snackbar 放在顶层、连接页与主界面两处都可见；移植侧必须补齐
 * 连接页这一半。判据：`ConnectScreen` 里必须有报错 + 清错 + 防重复三步。
 */
test('连接页必须自己把 state.error 报出来并清掉', () => {
  const text: string = read('ConnectScreen.ets');
  const code: string = codeLines(text).join('\n');
  sanity(code.includes('reportErrorIfAny'), `ConnectScreen.ets 里找不到 reportErrorIfAny，判据可能写错了`);

  const missing: string[] = [];
  if (!code.includes('reportErrorIfAny')) {
    missing.push('- 没有 reportErrorIfAny()：连接失败时界面不会报任何错');
  }
  if (!code.includes('clearError()')) {
    missing.push('- 没有 clearError()：同一句错误会在每次重绘时反复弹');
  }
  if (!code.includes('lastReported')) {
    missing.push('- 没有 lastReported：无法抑制重复文案');
  }
  // 去重记录必须随错误被消费而复位 —— 真机上验过：点两次「重试连接」、两次都超时，
  // 第二次一个字都不弹（去重记录永不复位），用户以为没点上。
  if (!code.includes('lastReported = null')) {
    missing.push('- lastReported 从不复位：同一个错误再发生一次会被静默吞掉（重试失败看着像没点上）');
  }
  if (!code.includes("@Watch('onVmChanged')")) {
    missing.push("- revision 上没有 @Watch('onVmChanged')：vm 更新后不会走到报错逻辑");
  }

  assert.ok(
    missing.length === 0,
    `连接页的错误接线不完整：\n${missing.join('\n')}\n` +
      `怎么办：对齐 AppShell.reportErrorIfAny()（localErrorText + lastReported + clearError）。`,
  );
});
