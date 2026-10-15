/**
 * 文件分节的共享常量与纯函数 —— 从 `ui/FilesScreen.ets` 拆出。
 *
 * ## 为什么单独成文件
 *
 * 这一批常量与两个纯函数（`isMarkdown` / `clampScale`）被拆分后的**多个结构体共用**：
 * `NumberedTextEditor` 用编辑器字号/行高/上下留白与最长行上限，`EditorPane` 用文字缩放
 * 区间与 Markdown 判定，`FilesScreen` 用分栏宽度与回收站列表高度。它们若留在任一个 UI
 * 文件里，别的文件就会反向依赖那个 UI 文件；抽成独立的 `.ts` 后谁都能单向 `import`，
 * 依赖方向不会绕回 UI 层。
 *
 * **值一个字都没动**：所有常量与两个函数的实现（含 `coerceIn` 的夹取语义、Markdown 后缀
 * 集合）与拆分前逐字一致，只是加了 `export` 以便跨文件引用。
 *
 * ## 行号编辑器的一处已知代价（真机验证点）
 *
 * 为了让行号与代码**逐行对齐**，两边必须用同一个 `lineHeight`；而 `TextArea` 在 ArkUI 里
 * **是会自动折行的**，一旦某行被折成两行，行号就错位。所以这里给 `TextArea` 按「最长行字符数」
 * 算宽度（横向滚动，见 `NumberedTextEditor.editorTextWidth`），并在字符数上设了
 * `LONGEST_LINE_CHAR_CAP` 上限 —— 超过上限的超长单行仍会折行、行号在那一段会错位。
 * 这个上限是刻意留的：不设上限时一份压缩过的 JSON（几十万字符一行）会把宽度撑到布局算不出来。
 */

/** 宽屏时左侧目录栏的宽度（对位 `Modifier.width(360.dp)`）。 */
export const BROWSER_WIDTH_VP: number = 360;

/** 文字缩放的三条常量，与源工程逐字一致。 */
export const MIN_TEXT_SCALE: number = 0.75;
export const MAX_TEXT_SCALE: number = 2.5;
export const TEXT_SCALE_STEP: number = 0.25;

/** 编辑器基准字号与行高（缩放前的值）：字号对位 `bodyMedium`，行高按等宽字体的舒适值取 20。 */
export const EDITOR_FONT_VP: number = 14;
export const EDITOR_LINE_VP: number = 20;

/** 编辑器上下留白（与源工程的 `padding(vertical = 12.dp)` 一致）。 */
export const EDITOR_PAD_VP: number = 12;

/**
 * 按「最长行字符数」算宽度时的上限。
 *
 * 见文件头「行号编辑器的一处已知代价」：超长单行（压缩过的 JSON 常在十万字符量级）不设上限
 * 会把宽度撑到布局算不出来。400 个字符已经覆盖绝大多数真实代码行。
 */
export const LONGEST_LINE_CHAR_CAP: number = 400;

/** 等宽字符宽度的粗略比例：`ch` 在多数等宽字体里约为字号的 0.6 倍，留一点余量给 0.62。 */
export const MONO_CHAR_RATIO: number = 0.62;

/** 回收站面板里列表的最大高度（对位 `height(360.dp)`）。 */
export const TRASH_LIST_MAX_HEIGHT_VP: number = 360;

/** 文件名是否为 Markdown（对位源工程 `isMarkdown`，后缀集合一字不改）。 */
export function isMarkdown(name: string): boolean {
  const dot: number = name.lastIndexOf('.');
  const ext: string = dot < 0 ? '' : name.substring(dot + 1).toLowerCase();
  return ext === 'md' || ext === 'markdown' || ext === 'mdown' || ext === 'mkd';
}

/** 夹在区间内（对位 Kotlin `coerceIn`）。 */
export function clampScale(value: number): number {
  if (value < MIN_TEXT_SCALE) {
    return MIN_TEXT_SCALE;
  }
  if (value > MAX_TEXT_SCALE) {
    return MAX_TEXT_SCALE;
  }
  return value;
}
