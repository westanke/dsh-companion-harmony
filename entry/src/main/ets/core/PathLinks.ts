/**
 * 把消息正文里**已知的会话文件**变成可点链接 —— 移植自源工程 `data/ChatPathLinks.kt`（源 v2.2.44 `a344e3f`）。
 *
 * ## 为什么需要
 *
 * 模型经常在正文里顺手写一句「已落盘：`deploy-report.md`」或者带个 📄 图标加文件名 ——
 * 那是**纯文本**，不是 Markdown 链接，于是应用只把它当一句话渲染，用户去点它自然毫无反应
 * （源工程 2026-10-19 真机反馈：「会话中有个文件，我试了打不开」；同一个文件从「本会话的文件」
 * 面板点得开，说明链路本身没问题，缺的只是**正文里那句话不是链接**）。
 *
 * ## 为什么按「文件名」匹配，而不是整条绝对路径
 *
 * 模型写进正文的通常只有**文件名**（整条 `/media/...` 太长，它一般省略）。所以拿会话已知
 * 文件的末段名去正文里找。
 *
 * ## 三条安全约束（宁可不加链接，也不打开错的文件）
 *
 * 1. **只有唯一文件名才替换**：同一个文件名同时出现在多个目录时**跳过** ——
 *    点开后打开另一个目录里的同名文件，比「点不开」严重得多；
 * 2. **不碰已有的 Markdown 链接 / 括号**：正文里 `[text](path)` 已经能点，再包一层会得到
 *    `[[text](path)](path)`（源工程单测 `doesNotWrapAnExistingMarkdownLinkTwice` 抓的就是它）；
 * 3. **只替换第一次出现**：同一消息里重复提到同一个文件名时只让第一处可点，
 *    避免整段文字被链接语法淹没。
 *
 * 幂等性由约束 2 保证：替换出来的 `[name](path)` 里那个 `name` 前面紧贴 `[`、后面紧贴 `]`，
 * 都在排除集内，所以再跑一遍不会二次包裹。
 */

import { isNotBlank } from './TextPredicates';

/** 文件名 → 唯一绝对路径；同名对应多个不同路径的整条丢弃（约束 1）。 */
function uniquePathsByName(knownAbsolutePaths: string[]): Map<string, string> {
  const pathsByName: Map<string, string[]> = new Map<string, string[]>();
  for (let i: number = 0; i < knownAbsolutePaths.length; i++) {
    const path: string = knownAbsolutePaths[i];
    const slash: number = path.lastIndexOf('/');
    const name: string = slash >= 0 ? path.substring(slash + 1) : path;
    if (!isNotBlank(name)) {
      continue;
    }
    const existing: string[] | undefined = pathsByName.get(name);
    if (existing === undefined) {
      pathsByName.set(name, [path]);
    } else if (existing.indexOf(path) < 0) {
      existing.push(path);
    }
  }

  const unique: Map<string, string> = new Map<string, string>();
  pathsByName.forEach((paths: string[], name: string): void => {
    if (paths.length === 1) {
      unique.set(name, paths[0]);
    }
  });
  return unique;
}

/** 正则字面量转义：文件名里带 `.` 是常态，不转义 `.` 会当成「任意字符」。 */
const REGEXP_SPECIALS: RegExp = /[.*+?^${}()|[\]\\]/g;

function escapeRegExp(text: string): string {
  return text.replace(REGEXP_SPECIALS, '\\$&');
}

/**
 * 把正文里已知的会话文件名变成 Markdown 链接。
 *
 * 边界前后**不能紧贴** URL 字符**与方/圆括号** —— 后者正是 `[看报告](xxx.md)` 的形状；
 * 只排除 `\w` 会把里面那层再包一遍（见文件头的约束 2）。
 */
export function linkifyKnownFiles(text: string, knownAbsolutePaths: string[]): string {
  if (text.length === 0 || knownAbsolutePaths.length === 0) {
    return text;
  }
  const unique: Map<string, string> = uniquePathsByName(knownAbsolutePaths);
  if (unique.size === 0) {
    return text;
  }

  const names: string[] = [];
  unique.forEach((value: string, name: string): void => {
    names.push(name);
  });
  // 长名优先：`a.md` 不能抢在 `report-a.md` 前面命中。
  names.sort((a: string, b: string): number => b.length - a.length);

  let result: string = text;
  for (let i: number = 0; i < names.length; i++) {
    const name: string = names[i];
    if (result.indexOf(name) < 0) {
      continue;
    }
    const pattern: RegExp = new RegExp(
      '(?<![\\w./\\-()\\[\\]])' + escapeRegExp(name) + '(?![\\w/\\-()\\[\\]])');
    const absolutePath: string = unique.get(name) as string;
    // 用函数替换，避免路径里的 `$` 被当成替换模式的特殊序列（`$&`、`$1` 之类）。
    result = result.replace(pattern, (): string => `[${name}](${absolutePath})`);
  }
  return result;
}

/**
 * 把**相对路径**拼到会话工作目录上 —— 对位源工程 `ui/chat/ChatLinkHandlers.kt` 里
 * 「拿会话 cwd 当基准」那条分支（源 v2.2.44 补的）。
 *
 * 模型正文里的链接常写成 `docs/report.md` 这种相对路径，源工程的处置是
 * 「拼上 cwd 再走绝对路径那一条路」；拿不到 cwd 时才告诉用户这个链接打不开。
 *
 * 三条与源工程一致的细节：
 *
 * - cwd 末尾的 `/` 只留一个（两边都带斜杠时不出现 `//`）；
 * - 相对路径开头的 `/` 去掉（`/docs/x.md` 拼出来不该是 `/cwd//docs/x.md`）；
 * - cwd 为 `"/"`（根目录）时结果仍是 `/docs/x.md` —— 这是拼接的自然结果，
 *   不需要为它开特例，但不这么写就会出现 `"//docs/x.md"`。
 */
export function joinCwd(cwd: string, raw: string): string {
  let base: string = cwd;
  while (base.endsWith('/')) {
    base = base.substring(0, base.length - 1);
  }
  let rest: string = raw;
  while (rest.startsWith('/')) {
    rest = rest.substring(1);
  }
  return `${base}/${rest}`;
}
