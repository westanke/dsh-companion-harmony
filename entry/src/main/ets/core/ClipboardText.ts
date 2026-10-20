/**
 * 剪贴板文本的归一化。
 *
 * ## 为什么单独一个文件（而不是直接写在 platform/Clipboard.ets 里）
 *
 * `pasteboard.PasteData.getPrimaryText()` 的**类型声明**是 `string`，但运行时并不保证：
 * 剪贴板里没有文本记录、或应用没有读权限、或系统只拿到一条空记录时，它给回的是 `undefined`。
 * 声明与运行时不一致，是这一层唯一无法靠静态检查发现的东西 ——
 * 而 `platform/` 层按工程约定**不做离线单测**（它真跑在设备上，见 `docs/TESTING.md`
 * 的「平台层自检」），所以这个判断必须落在一个能被 `node --test` 直接读到的纯函数里，
 * 否则「修好了」这句话就只能靠人眼保证。
 *
 * ## 这个 `undefined` 曾经把应用整进程杀掉
 *
 * 2026-10-20 AGC 上架驳回原文：
 *
 *   TypeError: Cannot read property length of undefined
 *       at anonymous (entry|entry|1.0.0|src/main/ets/ui/ConnectScreen.ts:993:1)
 *       at (entry/src/main/ets/pages/Index.ets:71:9)
 *
 * 触发链是**触摸事件** → 连接页「粘贴」按钮的 `onClick`：
 *
 *   const text: string = readClipboardText();   // 实到拿到 undefined
 *   if (text.length > 0) { ... }                // ← 这里抛 TypeError
 *
 * ArkUI 回调里的未捕获异常不是「这次操作失败」，是**直接杀进程** —— 用户看到的是闪退。
 * 设备日志在异常前一行还能看到框架自己的抱怨：`GetPrimaryText# Get GetPrimaryText failed`。
 *
 * ## 兜法为什么用运行时 `typeof` 而不是类型收窄
 *
 * 类型在这个调用上**本身就是错的**（声明 `string`、实际 `string | undefined`），
 * 顺着它写分支等于承认声明是对的，只会把真正的兜底判成「不可能发生」而被删掉。
 */

/**
 * 把平台返回的剪贴板文本归一为**一定是字符串**：非字符串一律当「没有文本」。
 *
 * 返回空串而不是 undefined/null，是为了让调用方的 `text.length > 0` 这类
 * 「先看长度再决定」的写法天然安全 —— 崩的那一版问题就出在这句上。
 */
export function normalizePrimaryText(raw: string): string {
  if (typeof raw !== 'string') {
    return '';
  }
  return raw;
}
