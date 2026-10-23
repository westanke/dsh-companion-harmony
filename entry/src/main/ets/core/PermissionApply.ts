/**
 * 新建会话时「是否该应用权限档」的纯函数判定 —— 对位 Android
 * `HarnessSessionsViewModel.applyPermissionPreset` 的空值不发纪律。
 *
 * ## 为什么需要
 *
 * 新建会话面板允许用户在 Agent 预设之外再选一个权限档；但：
 * - 默认「不指定」（空串）时必须保持现状行为，不发任何命令；
 * - 用户只输入了空白字符也要视为「不指定」。
 *
 * 判定逻辑集中在此，UI 层与 ViewModel 层共用同一份纪律，避免两处各写一遍
 * `permission !== null && permission.trim().length > 0` 导致行为漂移。
 *
 * ## 纯函数、可 node 单测
 *
 * 不碰平台 API，只做字符串判定。
 */

/** 空白字符串（只含空格/制表/换行）视为「不指定」。 */
export function isBlankPermission(value: string | null | undefined): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  return value.trim().length === 0;
}

/**
 * 新建会话后是否该调用 `selectPermissionPreset` 应用权限档。
 *
 * - `null` / `undefined` / 空串 / 全空白 → false（保持现状，不发命令）
 * - 非空白 → true
 *
 * @param permission 用户在新建面板选的权限档 id。
 */
export function shouldApplyPermission(permission: string | null | undefined): boolean {
  return !isBlankPermission(permission);
}

/** 规范化权限档 id：null/undefined/空白 → ''，否则 trim 后原值。 */
export function normalizePermissionId(permission: string | null | undefined): string {
  if (permission === null || permission === undefined) {
    return '';
  }
  const trimmed: string = permission.trim();
  return trimmed.length === 0 ? '' : trimmed;
}
