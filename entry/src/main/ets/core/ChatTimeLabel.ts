/**
 * 消息时间戳的展示文案 —— 移植自原工程 `data/ChatTimeLabel.kt`。
 *
 * 三档粒度，按「离现在多远」选：
 * - **今天** → 只给时刻（`14:03`）—— 同一天里日期是废话；
 * - **今年** → 月日 + 时刻（`10月16日 14:03`）；
 * - **更远** → 年月日 + 时刻（`2024年10月16日 14:03`）。
 *
 * 为什么要分档：一律只显示时刻的话，翻到上周的会话会看到一串 `14:03`，
 * 用户无法判断那是今天还是上个月 —— 时间戳的作用正是「知道这条是什么时候说的」。
 *
 * ## 两处与源工程不同的实现手段（结果一致）
 *
 * 1. **不用 `Intl.DateTimeFormat`，自己拼字符串**。源工程用 `SimpleDateFormat(pattern, locale)`，
 *    把月份名交给 locale；ArkTS 这边 `Intl` 在部分设备/预览器上不可靠，而这条路上一旦抛异常
 *    就是**整条消息渲染不出来**。所以这里只覆盖中英两种形态（与源工程单测实际跑出来的两种
 *    输出一致），其余语言按英文形态走 —— 宁可少一种语言形态，也不要一个会崩的日期。
 *    源工程自己也有同一取向的取舍：它放弃了 Android 的
 *    `DateFormat.getBestDateTimePattern` 改手工分中英两支，理由正是「那条 API 在纯 JVM
 *    单测里跑不到」。
 * 2. **时区不显式传参**，直接用 `Date` 的本地时间取值。源工程显式传 `TimeZone` 是为了单测
 *    能在任意时区下拿到固定结果；本工程改用「用 `new Date(y, m, d, h, mi)` 造时间戳」达到
 *    同样的目的（测试与实现共用同一套本地时区），少一个参数、少一处能传错的地方。
 *
 * 纯函数（`now` 与语言都从参数来）—— 因此可以拿固定时刻做断言，不依赖真实时钟。
 */

/** 英文月份名（只覆盖这一种非中文形态，见文件头取舍 1）。 */
const EN_MONTHS: string[] = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}

/** `zh` / `zh-Hans` / `zh-CN` 都算中文；其余一律走英文形态。 */
function isChinese(language: string): boolean {
  return language.toLowerCase().startsWith('zh');
}

function monthDayText(date: Date, chinese: boolean): string {
  if (chinese) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }
  return `${EN_MONTHS[date.getMonth()]} ${date.getDate()}`;
}

function yearMonthDayText(date: Date, chinese: boolean): string {
  if (chinese) {
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  }
  return `${date.getFullYear()} ${EN_MONTHS[date.getMonth()]} ${date.getDate()}`;
}

/**
 * 同一天（**本地时区**的「天」，跨零点就算另一天）。
 *
 * 比较年 + 月日，而不是「毫秒差 < 24h」：后者会把「昨天 23:50 与今天 00:10」算成同一天，
 * 而用户眼里的「今天」是日历上的那格。
 */
function sameDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

/**
 * 消息时间戳文案。
 *
 * @param millis 消息落盘时刻（毫秒）
 * @param now 当前时刻（毫秒），由调用方给 —— 纯函数才能测
 * @param language 界面语言标签（`zh-Hans` / `en-US` …）
 */
export function chatTimeLabel(millis: number, now: number, language: string): string {
  const stamp: Date = new Date(millis);
  const current: Date = new Date(now);
  const clock: string = `${pad2(stamp.getHours())}:${pad2(stamp.getMinutes())}`;
  const chinese: boolean = isChinese(language);
  if (sameDay(stamp, current)) {
    return clock;
  }
  if (stamp.getFullYear() === current.getFullYear()) {
    return `${monthDayText(stamp, chinese)} ${clock}`;
  }
  return `${yearMonthDayText(stamp, chinese)} ${clock}`;
}
