/**
 * 体积文案 —— 移植自原工程 `ui/ChatScreen.kt` 里那个 `formatFileSize`（会话文件面板在用）。
 *
 * 三档、没有 GB：会话里被 agent 提到的文件基本都在几十 MiB 以内，多一档只会让
 * 「1.0 GiB」这种极罕见的显示把 `.format` 的分支撑大。真要加档时记得**最后一档是开口的**
 * （`else`），否则超过 1024 MiB 的文件会掉进「没有分支」的空白。
 *
 * 十进制一位小数、单位用 KiB / MiB（二进制口径）：与源工程逐字一致，
 * 换单位会让用户对比「文件管理器里的 1.0 MB」时以为两边对不上。
 */
export function sessionFileSizeText(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${oneDecimal(size / 1024)} KiB`;
  }
  return `${oneDecimal(size / 1024 / 1024)} MiB`;
}

/**
 * 保留一位小数。
 *
 * 不能直接用 `toFixed(1)` 的替代品糊过去：`Math.round(x * 10) / 10` 对
 * 「1.05」这类值会和 `String.format("%.1f")` 有半档差异（银行家舍入 vs 四舍五入），
 * 而源工程用的是后者。这里用「先乘十、加半个 epsilon、再取整」模拟四舍五入，
 * 与 Kotlin 的 `%.1f` 在本工程出现的数值范围内一致。
 */
function oneDecimal(value: number): string {
  const scaled: number = Math.round(value * 10 + (value >= 0 ? 1e-9 : -1e-9));
  const whole: number = Math.floor(scaled / 10);
  const frac: number = scaled - whole * 10;
  return `${whole}.${frac}`;
}
