/**
 * 应用内检查更新（平台受限版）—— 对位 Android 源工程 `data/AppUpdate.kt`。
 *
 * ## 鸿蒙侧关键约束（已有定论）
 *
 * 鸿蒙第三方应用平台层面**不能自安装** —— 应用内上限是「查新版 + 给下载/跳转入口」，
 * 安装必须人完成（AGC 更新或 hdc/文件侧载）。详见仓库外层版本更新路径研究文档。
 *
 * 因此七态 UI 中去掉「下载后拉起安装器」，改为：
 *   - 同版 → 显示「已是最新」
 *   - 有新版 → 展示版本 + 说明 + 跳转浏览器 Release 页
 *   - 断网/限流 → 诚实文案
 *
 * ## 渠道分流
 *
 * 与 Android / 桌面端同一口径 —— 按界面语言分流：zh* → Gitee、其他 → GitHub。
 *
 * 架构纪律：本文件**只放纯逻辑**，不碰平台 API。界面语言 tag 由 UI 层调用
 * `platform/Platform.ets` 的 `systemLanguageTag()` 拿到后再传给 `channelForLanguage()`。
 */

/** 渠道枚举 —— 鸿蒙侧只需要 Gitee/GitHub 两个发布平台。 */
export enum UpdateChannel {
  GITEE = 'gitee',
  GITHUB = 'github',
}

/**
 * 按界面语言分流渠道 —— zh* → Gitee，其他 → GitHub。
 *
 * 复用既有 `Platform.systemLanguageTag()`（不是 AppStorage 的语言设置，
 * 因为 App 本身也没给用户切换语言的入口 —— 系统语言就是界面语言）。
 */
export function channelForLanguage(languageTag: string | null): UpdateChannel {
  if (languageTag === null) {
    // 语言未知 → 默认 GitHub（更广泛可用）。
    return UpdateChannel.GITHUB;
  }
  const tag: string = languageTag.toLowerCase();
  // zh-CN / zh-TW / zh-HK 等都是 zh 开头
  return tag.startsWith('zh') ? UpdateChannel.GITEE : UpdateChannel.GITHUB;
}

/** 渠道对应的 Release 页 URL —— 点击跳转浏览器。组织名与 `git remote -v` 对齐（westanke）。 */
export function releasePageUrl(channel: UpdateChannel): string {
  switch (channel) {
    case UpdateChannel.GITEE:
      return 'https://gitee.com/westanke/dsh-companion-harmony/releases';
    case UpdateChannel.GITHUB:
      return 'https://github.com/westanke/dsh-companion-harmony/releases';
  }
}

/**
 * 语义化版本比较 —— 对位 Android 源工程 `compareVersions()`。
 *
 * 返回正数表示 a > b（更新），负数表示 a < b，0 相等。
 *
 * 支持 x.y.z 格式，忽略前缀 'v' / 'V' / 'version' 等非数字字符。
 * 兼容预发布标签（-alpha / -beta 等）—— 预发布版本号小于同版本号的正式版。
 */
export function compareVersions(a: string, b: string): number {
  const pa: ParsedVersion = parseVersion(a);
  const pb: ParsedVersion = parseVersion(b);
  // 主版本
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  // 预发布标签：没有标签（正式版）> 有标签
  if (!pa.isPreRelease && pb.isPreRelease) return 1;
  if (pa.isPreRelease && !pb.isPreRelease) return -1;
  // 同为预发布或同为正式版 → 相等
  return 0;
}

/** 某版本是否比当前版本更新。 */
export function isUpdateAvailable(current: string, latest: string): boolean {
  return compareVersions(latest, current) > 0;
}

// ——— 内部工具 ———

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  isPreRelease: boolean;
}

/**
 * 解析版本号 —— 宽容解析，解析失败回落 0.0.0（不抛异常）。
 *
 * 示例：'1.2.3' → { major: 1, minor: 2, patch: 3 }
 *       'v2.1.0-beta' → { major: 2, minor: 1, patch: 0, isPreRelease: true }
 *       'v1.0' → { major: 1, minor: 0, patch: 0 }
 */
function parseVersion(raw: string): ParsedVersion {
  let cleaned: string = raw.trim();
  // 剥前缀：v/V/version/VER- 等
  const prefixMatch = cleaned.match(/^[vV]?(?:ersion)?[\s._\-]*(.+)$/);
  if (prefixMatch !== null) {
    cleaned = prefixMatch[1];
  }
  // 剥预发布标签
  let isPreRelease: boolean = false;
  const preIdx: number = cleaned.indexOf('-');
  if (preIdx >= 0) {
    cleaned = cleaned.substring(0, preIdx);
    isPreRelease = true;
  }
  const parts: string[] = cleaned.split(/[.\-]/);
  const major: number = parseInt(parts[0], 10);
  const minor: number = parts.length >= 2 ? parseInt(parts[1], 10) : 0;
  const patch: number = parts.length >= 3 ? parseInt(parts[2], 10) : 0;
  const safeMajor: number = isNaN(major) ? 0 : major;
  const safeMinor: number = isNaN(minor) ? 0 : minor;
  const safePatch: number = isNaN(patch) ? 0 : patch;
  return { major: safeMajor, minor: safeMinor, patch: safePatch, isPreRelease };
}
