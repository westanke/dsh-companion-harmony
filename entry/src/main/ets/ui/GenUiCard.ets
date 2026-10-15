/**
 * 渲染一份 dsh-ui spec —— 移植自原工程 `ui/GenUiCard.kt`（604 行）。
 *
 * 设计取舍，按重要性排序（与源工程文件头一致）：
 *
 * 1. **未知组件整条丢弃，不留半截**。词表有 40 多种，手机上全实现不现实也没必要。
 *    这里只画 `core/GenUiBlocks.ts` 的 `SUPPORTED` 认得的那批，认不得的直接跳过 ——
 *    与网页版「坏组件被丢弃、其余照常」一致。画一个空壳比不画更让人以为界面坏了。
 *
 * 2. **交互组件真的能点，且点了会回话**。`radio`/`submit` 的选择记在本地，
 *    点下去把答案**作为一条普通用户消息**发进会话（`onAnswer`）。这是整个功能的意义：
 *    网页版弹出的问题，手机上也该能答。
 *
 * 3. **卡片只给并排项与数据对象用**，单段文字不加卡 —— 否则满屏都是圆角矩形，比网页版更像模板。
 *
 * ## 平台适配（三处，都是因为鸿蒙没有 Material 的 container 色阶）
 *
 * a. **语气色只能用「左侧竖条 + 标题着色」表达**。源工程给 `callout` / `badge` 用
 *    `tertiaryContainer` / `errorContainer` 这类**成对**的容器色（前景色保证在其上可读），
 *    而鸿蒙的语义色只有单支（`ohos_id_color_warning` 之类），拿它当底色就得自己猜前景色，
 *    猜错就是「黄底白字」这种读不了的情况。所以底色统一用
 *    `ohos_id_color_sub_background`，语气色只用在竖条与标题上 —— 两种主题下都可读。
 * b. **没有成对的 container 色**，`stat` 的涨跌色改用 `ohos_id_color_connected`（正）/`alert`（负）。
 * c. **`chart` 的 bars / line / donut 一律用横条 + 文字呈现**：源工程用 Canvas 手绘（三维度：
 *    柱高、折线、圆环），ArkUI 这边直接给 `Progress` 横条。手机上要读的是「谁的柱子高」，
 *    横条 + 数值同样读得出来，而且**天然跟随主题**（自绘颜色要自己管深浅色）。
 *
 * ## 三条照抄源工程、不许简化的点
 *
 * 1. `table` 的**横向滚动容器必须套在表格外面**，列宽由 `genUiTableColumnWidthVp` 定死。
 *    源工程注释里记着网页版 2.2.4 的旧账：把 `overflow-x` 写在 table 自己身上会让表格脱离
 *    表格布局算法、列宽算不出来、几列叠成一团。表头与正文每格拿同一个宽度，行与行才对得齐。
 * 2. `button` **不带 `action` 就是禁用态**（照网页版），否则用户点了没反应，只能理解成 App 坏了。
 * 3. `radio`/`submit` 的默认选中项按 `desc == node.selected` 找（源工程就是拿 `desc` 存 value）。
 */

import { JsonAccess, JsonMap } from '../core/JsonAccess';
import {
  GenUiListItem, GenUiNode, GenUiSpec, genUiChildren, genUiInlineText, genUiInt, genUiLabel,
  genUiListItems, genUiNumber, genUiStr, genUiTableColumnWidthVp, genUiTitle, inlineMarkup,
} from '../core/GenUiBlocks';

// ————————————————————————— 渲染辅助数据类型 —————————————————————————
//
// ArkUI 的 `ForEach` 只能遍历「对象数组」，而源工程里那几处数据在 JSON 里是
// `[["a","b"]]` 这种**原始数组的数组**（表格行）、或者 `[{key,value}]`。这里统一收成类。

/** `keyvalue` 的一行。 */
class GenUiPair {
  key: string;
  value: string;

  constructor(key: string, value: string) {
    this.key = key;
    this.value = value;
  }
}

/** `steps` 的一步。 */
class GenUiStep {
  title: string;
  desc: string | null;

  constructor(title: string, desc: string | null) {
    this.title = title;
    this.desc = desc;
  }
}

/** `chart` 的一根柱子（bars / line / donut 共用）。 */
class GenUiBar {
  label: string;
  value: number;

  constructor(label: string, value: number) {
    this.label = label;
    this.value = value;
  }
}

/** `diff` 的一处改动。 */
class GenUiDiffEntry {
  path: string | null;
  oldText: string | null;
  newText: string | null;

  constructor(path: string | null, oldText: string | null, newText: string | null) {
    this.path = path;
    this.oldText = oldText;
    this.newText = newText;
  }
}

/**
 * 把 `JsonPrimitive` 家族折成字符串（与 core 的 `GenUiJson.str` 同一口径）：
 * 数字/布尔也能给字符串，`null` 给空串。
 */
function primitiveText(value: Object | null): string {
  if (value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value as string;
  }
  if (typeof value === 'number') {
    return `${value as number}`;
  }
  if (typeof value === 'boolean') {
    return (value as boolean) ? 'true' : 'false';
  }
  return '';
}

/** 一个 JSON 数组里的**标量**元素逐个转字符串（表格列、表格行、徽标等场合）。 */
function primitiveArray(value: Object | null): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const raw: Object[] = value as Object[];
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    out.push(primitiveText(raw[i]));
  }
  return out;
}

/** 数字格式化：整数不带小数，否则一位小数（对应源工程的 `formatNumber`）。 */
function formatNumber(value: number): string {
  if (Number.isInteger(value)) {
    return `${Math.trunc(value)}`;
  }
  return `${Math.round(value * 10) / 10}`;
}

// ————————————————————————— 交互组件：单选表单 —————————————————————————

/**
 * `radio` / `submit` 的本地状态（源工程的 `GenUiForm`）。
 *
 * 答案存在**组件里**而不是会话里：会话里放的是「用户选了 v2.0.0」这条消息本身，
 * 由 `onAnswer` 发出。选择状态随消息一起重建，符合「刷新后回到没选」的直觉。
 */
@Component
struct GenUiForm {
  /** 可选项（`node.listItems()`）。 */
  options: GenUiListItem[] = [];
  /** 提交按钮上的文字（`node.label() ?? "确认"`）——**也**是没选任何项时回带的内容。 */
  prompt: string = '';
  /** `node.str("selected")`：默认选中项的 `desc`（源工程就是拿 `desc` 存 value）。 */
  defaultSelected: string | null = null;
  onAnswer: (text: string) => void = (): void => {};

  /** `-1` 表示没选。 */
  @State selected: number = -1;

  aboutToAppear(): void {
    this.selected = this.options.findIndex(
      (option: GenUiListItem): boolean => option.desc === this.defaultSelected);
  }

  build() {
    Column() {
      ForEach(this.options, (option: GenUiListItem, index: number) => {
        Row() {
          Radio({ value: `${index}`, group: 'genui-radio' })
            .checked(this.selected === index)
            .onChange((isChecked: boolean): void => {
              if (isChecked) {
                this.selected = index;
              }
            })
          Text(option.title)
            .fontSize(15)
            .layoutWeight(1)
            .margin({ left: 6 })
        }
        .width('100%')
        .padding({ top: 3, bottom: 3 })
        .alignItems(VerticalAlign.Center)
        .onClick((): void => {
          this.selected = index;
        })
      }, (option: GenUiListItem, index: number) => `${index}-${option.title}`)

      Button(this.prompt)
        .type(ButtonType.Capsule)
        .height(38)
        .margin({ top: 8 })
        .enabled(this.selected >= 0)
        .onClick((): void => {
          // 没选任何项时回带提示语本身 —— 与源工程一致（`onAnswer(if (index >= 0) options[index].title else prompt)`）。
          const index: number = this.selected;
          this.onAnswer(index >= 0 ? this.options[index].title : this.prompt);
        })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}

// ————————————————————————— 主组件 —————————————————————————

/** 渲染一份 dsh-ui spec。`onAnswer` 收到的是「用户点了哪个」的文本，由调用方当普通消息发出。 */
@Component
export struct GenUiCard {
  spec: GenUiSpec = new GenUiSpec();
  /** 交互组件回话：调用方把它当一条普通用户消息发进会话。 */
  onAnswer: (text: string) => void = (): void => {};
  /** 卡片可用宽度（vp）。表格列宽要用它；不传则退回列宽下限。 */
  availableWidth: number = 0;

  build() {
    Column() {
      if (this.spec.title !== null && this.spec.title.length > 0) {
        Text(inlineMarkup(this.spec.title))
          .fontSize(15)
          .fontWeight(FontWeight.Medium)
          .width('100%')
          .margin({ bottom: 6 })
      }
      ForEach(this.spec.items, (node: GenUiNode, index: number) => {
        this.nodeView(node, index)
      }, (node: GenUiNode, index: number) => `${index}-${node.type}`)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  // ————————————————— 文本与排版 —————————————————

  /** `text` 节点的字号。对位源工程的 `typography` 映射。 */
  private textSizeOf(node: GenUiNode): number {
    const size: string | null = genUiStr(node, 'size');
    if (size === 'h1') {
      return 26;
    }
    if (size === 'h2') {
      return 22;
    }
    if (size === 'h3') {
      return 18;
    }
    if (size === 'muted') {
      return 15;
    }
    if (size === 'caption') {
      return 12;
    }
    return 15;
  }

  /** `muted` / `caption` 用次级文字色，其余用主文字色。 */
  private textColorOf(node: GenUiNode): ResourceColor {
    const size: string | null = genUiStr(node, 'size');
    if (size === 'muted' || size === 'caption') {
      return $r('sys.color.ohos_id_color_text_secondary');
    }
    return $r('sys.color.ohos_id_color_text_primary');
  }

  /**
   * 语气色（`callout` / `badge` 共用）。
   *
   * 见文件头「平台适配 a」：鸿蒙只有单支语义色，没有 Material 那种成对容器色，
   * 所以语气色只用在竖条与标题上，底色一律 `sub_background`。
   */
  private toneColorOf(tone: string | null, forBadge: boolean): ResourceColor {
    if (tone === 'error' || tone === 'danger') {
      return $r('sys.color.ohos_id_color_alert');
    }
    if (tone === 'warning' || tone === 'warn') {
      return $r('sys.color.ohos_id_color_warning');
    }
    if (tone === 'success') {
      return $r('sys.color.ohos_id_color_connected');
    }
    // 源工程 badge 的兜底是 primaryContainer，callout 的兜底是 surfaceVariant —— 都归到强调色。
    return forBadge ? $r('sys.color.ohos_id_color_emphasize')
      : $r('sys.color.ohos_id_color_text_secondary');
  }

  // ————————————————— 各节点的数据准备 —————————————————

  private pairRowsOf(node: GenUiNode): GenUiPair[] {
    const out: GenUiPair[] = [];
    const pairs: JsonMap[] = JsonAccess.objArr(node.value, 'pairs');
    for (let i = 0; i < pairs.length; i++) {
      const key: string | null = JsonAccess.str(pairs[i], 'key');
      if (key === null) {
        continue;
      }
      out.push(new GenUiPair(key, JsonAccess.str(pairs[i], 'value') ?? ''));
    }
    return out;
  }

  private tableColumnsOf(node: GenUiNode): string[] {
    return primitiveArray(JsonAccess.raw(node.value, 'columns'));
  }

  private tableRowsOf(node: GenUiNode): string[][] {
    const raw: Object[] = JsonAccess.arr(node.value, 'rows');
    const out: string[][] = [];
    for (let i = 0; i < raw.length; i++) {
      out.push(primitiveArray(raw[i]));
    }
    return out;
  }

  private stepsOf(node: GenUiNode): GenUiStep[] {
    const out: GenUiStep[] = [];
    for (const step of JsonAccess.objArr(node.value, 'steps')) {
      out.push(new GenUiStep(JsonAccess.str(step, 'title') ?? '', JsonAccess.str(step, 'desc')));
    }
    return out;
  }

  private barsOf(node: GenUiNode): GenUiBar[] {
    const out: GenUiBar[] = [];
    for (const entry of JsonAccess.objArr(node.value, 'data')) {
      const label: string = JsonAccess.str(entry, 'label') ?? '';
      // 读不出数字的项丢弃 —— 与源工程 `toDoubleOrNull() ?: return@mapNotNull null` 一致。
      const value: number | null = JsonAccess.num(entry, 'value');
      if (value === null) {
        continue;
      }
      out.push(new GenUiBar(label, value));
    }
    return out;
  }

  private diffsOf(node: GenUiNode): GenUiDiffEntry[] {
    const out: GenUiDiffEntry[] = [];
    for (const diff of JsonAccess.objArr(node.value, 'diffs')) {
      out.push(new GenUiDiffEntry(JsonAccess.str(diff, 'path'), JsonAccess.str(diff, 'oldText'),
        JsonAccess.str(diff, 'newText')));
    }
    return out;
  }

  /** 条形/圆环图的基准：最大值的正数，取不到就给 1（避免除零让所有条都一样长）。 */
  private barsMaxOf(node: GenUiNode): number {
    const bars: GenUiBar[] = this.barsOf(node);
    let max: number = 0;
    for (let i = 0; i < bars.length; i++) {
      if (bars[i].value > max) {
        max = bars[i].value;
      }
    }
    return max > 0 ? max : 1;
  }

  private barsTotalOf(node: GenUiNode): number {
    const bars: GenUiBar[] = this.barsOf(node);
    let total: number = 0;
    for (let i = 0; i < bars.length; i++) {
      total += bars[i].value;
    }
    return total > 0 ? total : 1;
  }

  /** 一列该占多宽（vp）：装得下就铺满卡片，装不下退回下限、交给外层横向滚。 */
  private tableColumnWidthOf(node: GenUiNode): number {
    return genUiTableColumnWidthVp(this.availableWidth, this.tableColumnsOf(node).length);
  }

  private tableWidthOf(node: GenUiNode): number {
    return this.tableColumnWidthOf(node) * this.tableColumnsOf(node).length;
  }

  private codeOf(node: GenUiNode): string {
    const code: string | null = genUiStr(node, 'code');
    return code !== null ? code : genUiInlineText(node);
  }

  private promptOf(node: GenUiNode): string {
    const label: string | null = genUiLabel(node);
    return label !== null ? label : '确认';
  }

  // ——— 可空取值的「非空化」小助手 ———
  //
  // `@Builder` 里不能声明局部变量，所以「先判非空、再用值」这种窄化在 `@Builder` 里
  // 写不出来（写两遍 `genUiXxx(node)`，编译器不认第二遍非空）。一律走方法。

  private titleOf(node: GenUiNode): string {
    const title: string | null = genUiTitle(node);
    return title !== null ? title : '';
  }

  private labelOf(node: GenUiNode): string {
    const label: string | null = genUiLabel(node);
    return label !== null ? label : '';
  }

  /** 步骤条的当前步。缺字段时按 0 —— 那就是「一步都还没走完」，与源工程口径一致。 */
  private currentOf(node: GenUiNode): number {
    const current: number | null = genUiInt(node, 'current');
    return current !== null ? current : 0;
  }

  private deltaOf(node: GenUiNode): string {
    const delta: string | null = genUiStr(node, 'delta');
    return delta !== null ? delta : '';
  }

  // ————————————————— 递归渲染 —————————————————

  /**
   * 画一个节点。
   *
   * 递归的：`card` / `row` / `col` / `grid` 里还有子节点。ArkUI 的 `@Builder` 允许自递归。
   *
   * `indexKey` 只用于 `ForEach` 的键；`@Builder` 多参是值语义（不会随源对象更新），
   * 但 dsh-ui 卡片的内容是**一份静态快照**——正是「刷新后回到没选」的语义，所以无碍。
   */
  @Builder
  nodeView(node: GenUiNode, indexKey: number) {
    if (node.type === 'text') {
      Text(genUiInlineText(node))
        .fontSize(this.textSizeOf(node))
        .fontColor(this.textColorOf(node))
        .lineHeight(26)
        .width('100%')
    } else if (node.type === 'list') {
      this.listView(node)
    } else if (node.type === 'keyvalue') {
      this.keyValueView(node)
    } else if (node.type === 'table') {
      this.tableView(node)
    } else if (node.type === 'callout') {
      this.calloutView(node)
    } else if (node.type === 'steps') {
      this.stepsView(node)
    } else if (node.type === 'stat') {
      this.statView(node)
    } else if (node.type === 'badge') {
      this.badgeView(node)
    } else if (node.type === 'progress') {
      this.progressView(node)
    } else if (node.type === 'chart') {
      this.chartView(node)
    } else if (node.type === 'code') {
      this.codeView(node, genUiStr(node, 'lang'))
    } else if (node.type === 'json') {
      this.codeView(node, 'json')
    } else if (node.type === 'diff') {
      this.diffView(node)
    } else if (node.type === 'divider') {
      Divider()
        .strokeWidth(1)
        .color($r('sys.color.ohos_id_color_list_separator'))
    } else if (node.type === 'spacer') {
      // 源工程是固定 8dp 的空档；换成带高度的空 Column，行为一致。
      Column().height(8)
    } else if (node.type === 'card') {
      this.layoutView(node, 'col')
    } else if (node.type === 'row' || node.type === 'col' || node.type === 'grid') {
      this.layoutView(node, node.type)
    } else if (node.type === 'button') {
      this.buttonView(node)
    } else if (node.type === 'radio' || node.type === 'submit') {
      this.formView(node, indexKey)
    }
    // 其余类型整条跳过（见文件头第 1 条）：画一个空壳比不画更让人以为界面坏了。
  }

  /**
   * `card` / `row` / `col` / `grid` 的共同外皮：次级底色 + 圆角 + 内边距。
   *
   * `row` 才是真的横排；`grid` 在源工程里也是**竖排**（不是真网格）—— 手机上窄，两列会挤成
   * 每格两个字，照抄这个取舍，别自作主张改成两列。
   */
  @Builder
  layoutView(node: GenUiNode, kind: string) {
    if (kind === 'row') {
      Row() {
        ForEach(genUiChildren(node), (child: GenUiNode, index: number) => {
          this.nodeView(child, index)
        }, (child: GenUiNode, index: number) => `${index}-${child.type}`)
      }
      .width('100%')
      .padding(10)
      .borderRadius(12)
      .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
      .alignItems(VerticalAlign.Top)
    } else {
      Column() {
        if (kind === 'card' && this.titleOf(node).length > 0) {
          Text(inlineMarkup(this.titleOf(node)))
            .fontSize(15)
            .fontWeight(FontWeight.Medium)
            .width('100%')
            .margin({ bottom: 6 })
        }
        ForEach(genUiChildren(node), (child: GenUiNode, index: number) => {
          this.nodeView(child, index)
        }, (child: GenUiNode, index: number) => `${index}-${child.type}`)
      }
      .width('100%')
      .padding(10)
      .borderRadius(12)
      .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
      .alignItems(HorizontalAlign.Start)
    }
  }

  @Builder
  listView(node: GenUiNode) {
    Column() {
      if (this.titleOf(node).length > 0) {
        Text(inlineMarkup(this.titleOf(node)))
          .fontSize(15)
          .fontWeight(FontWeight.Medium)
          .width('100%')
          .margin({ bottom: 4 })
      }
      ForEach(genUiListItems(node), (item: GenUiListItem, index: number) => {
        Row() {
          Text('·')
            .fontSize(15)
            .width(14)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          Column() {
            Text(item.title)
              .fontSize(15)
              .width('100%')
            if (item.desc !== null && item.desc.length > 0) {
              Text(item.desc)
                .fontSize(12)
                .width('100%')
                .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            }
          }
          .layoutWeight(1)
          .alignItems(HorizontalAlign.Start)
        }
        .width('100%')
        .margin({ bottom: 6 })
        .alignItems(VerticalAlign.Top)
      }, (item: GenUiListItem, index: number) => `${index}-${item.title}`)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  keyValueView(node: GenUiNode) {
    Column() {
      ForEach(this.pairRowsOf(node), (pair: GenUiPair, index: number) => {
        Row() {
          Text(pair.key)
            .fontSize(15)
            .width(120)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          Text(pair.value)
            .fontSize(15)
            .layoutWeight(1)
        }
        .width('100%')
        .padding({ top: 2, bottom: 2 })
        .alignItems(VerticalAlign.Top)
      }, (pair: GenUiPair, index: number) => `${index}-${pair.key}`)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  tableView(node: GenUiNode) {
    if (this.tableColumnsOf(node).length > 0) {
      Column() {
        if (this.titleOf(node).length > 0) {
          Text(inlineMarkup(this.titleOf(node)))
            .fontSize(15)
            .fontWeight(FontWeight.Medium)
            .width('100%')
            .margin({ bottom: 4 })
        }
        // 横向滚动**只加在最外层**（见文件头第 1 条）：套在表格外面才不破坏列宽计算。
        Scroll() {
          Column() {
            Row() {
              ForEach(this.tableColumnsOf(node), (column: string, index: number) => {
                Text(column)
                  .fontSize(14)
                  .fontWeight(FontWeight.Medium)
                  .width(this.tableColumnWidthOf(node))
                  .padding(8)
              }, (column: string, index: number) => `h-${index}-${column}`)
            }
            .width(this.tableWidthOf(node))
            .backgroundColor($r('sys.color.ohos_id_color_sub_background'))

            // 宽度必须显式给：横向滚动的子级拿到的是**无界**宽度约束，
            // 而 Divider 默认铺满 —— 无界下它会塌成 0 宽，这条分割线整个不见。
            Divider()
              .strokeWidth(1)
              .width(this.tableWidthOf(node))
              .color($r('sys.color.ohos_id_color_list_separator'))

            ForEach(this.tableRowsOf(node), (cells: string[], rowIndex: number) => {
              Row() {
                ForEach(this.tableColumnsOf(node), (column: string, columnIndex: number) => {
                  Text(columnIndex < cells.length ? cells[columnIndex] : '')
                    .fontSize(12)
                    .width(this.tableColumnWidthOf(node))
                    .padding(8)
                }, (column: string, columnIndex: number) => `c-${rowIndex}-${columnIndex}`)
              }
              .width(this.tableWidthOf(node))
            }, (cells: string[], rowIndex: number) => `r-${rowIndex}`)
          }
          .alignItems(HorizontalAlign.Start)
        }
        .scrollable(ScrollDirection.Horizontal)
        .width('100%')
        .align(Alignment.TopStart)
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
  }

  /**
   * 语气块：左侧竖条 + 标题着色（见文件头「平台适配 a」）。
   *
   * 源工程给整块上容器色，鸿蒙没有成对容器色 —— 底色用 `sub_background`（两种主题都可读），
   * 语气色只作竖条与标题，语义没丢。
   */
  @Builder
  calloutView(node: GenUiNode) {
    Row() {
      Column()
        .width(3)
        .height('100%')
        .borderRadius(2)
        .backgroundColor(this.toneColorOf(genUiStr(node, 'tone'), false))
      Column() {
        if (this.titleOf(node).length > 0) {
          Text(inlineMarkup(this.titleOf(node)))
            .fontSize(15)
            .fontWeight(FontWeight.Medium)
            .width('100%')
            .fontColor(this.toneColorOf(genUiStr(node, 'tone'), false))
        }
        Text(genUiInlineText(node))
          .fontSize(15)
          .width('100%')
          .margin({ top: genUiTitle(node) !== null ? 4 : 0 })
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
      .margin({ left: 10 })
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 12, bottom: 12 })
    .borderRadius(10)
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
    .alignItems(VerticalAlign.Top)
  }

  @Builder
  stepsView(node: GenUiNode) {
    Column() {
      ForEach(this.stepsOf(node), (step: GenUiStep, index: number) => {
        Row() {
          // 已走过的步骤（`index < current`）用强调色实心，其余用次级底色 —— 对位源工程那两个分支。
          Text(`${index + 1}`)
            .fontSize(12)
            .width(22)
            .height(22)
            .textAlign(TextAlign.Center)
            .borderRadius(11)
            .backgroundColor(index < this.currentOf(node)
              ? $r('sys.color.ohos_id_color_emphasize')
              : $r('sys.color.ohos_id_color_component_normal'))
            .fontColor(index < this.currentOf(node)
              ? $r('sys.color.ohos_id_color_foreground_contrary')
              : $r('sys.color.ohos_id_color_text_secondary'))
          Column() {
            Text(step.title)
              .fontSize(15)
              .fontWeight(FontWeight.Medium)
              .width('100%')
            if (step.desc !== null && step.desc.length > 0) {
              Text(step.desc)
                .fontSize(12)
                .width('100%')
                .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            }
          }
          .layoutWeight(1)
          .alignItems(HorizontalAlign.Start)
          .margin({ left: 10 })
        }
        .width('100%')
        .margin({ bottom: 8 })
        .alignItems(VerticalAlign.Top)
      }, (step: GenUiStep, index: number) => `${index}-${step.title}`)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  statView(node: GenUiNode) {
    Column() {
      if (genUiStr(node, 'label') !== null) {
        Text(genUiStr(node, 'label'))
          .fontSize(12)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
      }
      Row() {
        Text(genUiStr(node, 'value') ?? '')
          .fontSize(26)
          .fontWeight(FontWeight.Medium)
        if (genUiStr(node, 'delta') !== null) {
          Text(this.deltaOf(node))
            .fontSize(15)
            .margin({ left: 6, bottom: 2 })
            // 源工程：不以 "-" 开头算正面（涨），用绿；否则用错误色（跌）。
            .fontColor((this.deltaOf(node).startsWith('-'))
              ? $r('sys.color.ohos_id_color_alert')
              : $r('sys.color.ohos_id_color_connected'))
        }
      }
      .alignItems(VerticalAlign.Bottom)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  badgeView(node: GenUiNode) {
    // `icon` 与 `label` 用空格接起来 —— 对位源工程的 `listOfNotNull(icon, label).joinToString(" ")`。
    Text(genUiStr(node, 'icon') !== null
      ? `${genUiStr(node, 'icon')} ${genUiStr(node, 'label') ?? ''}`
      : (genUiStr(node, 'label') ?? ''))
      .fontSize(12)
      .padding({ left: 10, right: 10, top: 4, bottom: 4 })
      .borderRadius(20)
      .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
      .fontColor(this.toneColorOf(genUiStr(node, 'tone'), true))
  }

  @Builder
  progressView(node: GenUiNode) {
    // 读不出 value 就整条不画（源工程 `?: return`）—— 一个 0% 的条会让人以为任务没开始。
    if (genUiNumber(node, 'value') !== null) {
      Column() {
        if (genUiStr(node, 'label') !== null) {
          Text(genUiStr(node, 'label'))
            .fontSize(15)
            .width('100%')
        }
        Progress({ value: genUiNumber(node, 'value'), total: 100, type: ProgressType.Linear })
          .width('100%')
          .margin({ top: 4 })
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
  }

  @Builder
  chartView(node: GenUiNode) {
    Column() {
      if (this.titleOf(node).length > 0) {
        Text(inlineMarkup(this.titleOf(node)))
          .fontSize(15)
          .fontWeight(FontWeight.Medium)
          .width('100%')
          .margin({ bottom: 6 })
      }
      ForEach(this.barsOf(node), (bar: GenUiBar, index: number) => {
        Column() {
          Row() {
            Text(bar.label)
              .fontSize(12)
              .layoutWeight(1)
            Text(genUiStr(node, 'kind') === 'donut'
              ? `${Math.trunc(bar.value / this.barsTotalOf(node) * 100)}%  ·  ${formatNumber(bar.value)}`
              : formatNumber(bar.value))
              .fontSize(12)
              .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          }
          .width('100%')
          // 见文件头「平台适配 c」：bars / line / donut 统一用横条 + 文字。
          Progress({ value: bar.value, total: this.barsMaxOf(node), type: ProgressType.Linear })
            .width('100%')
            .margin({ top: 2 })
        }
        .width('100%')
        .margin({ bottom: 5 })
        .alignItems(HorizontalAlign.Start)
      }, (bar: GenUiBar, index: number) => `${index}-${bar.label}`)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  codeView(node: GenUiNode, lang: string | null) {
    // 空代码不画（源工程 `if (code.isBlank()) return`）。
    if (this.codeOf(node).trim().length > 0) {
      Column() {
        if (lang !== null && lang.length > 0) {
          Text(lang)
            .fontSize(11)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        }
        Scroll() {
          Text(this.codeOf(node))
            .fontSize(12)
            .fontFamily('monospace')
            .width('100%')
        }
        .scrollable(ScrollDirection.Horizontal)
        .width('100%')
        .align(Alignment.TopStart)
      }
      .width('100%')
      .padding(10)
      .borderRadius(8)
      .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
      .alignItems(HorizontalAlign.Start)
    }
  }

  @Builder
  diffView(node: GenUiNode) {
    Column() {
      ForEach(this.diffsOf(node), (diff: GenUiDiffEntry, index: number) => {
        Column() {
          if (diff.path !== null) {
            Text(diff.path)
              .fontSize(12)
              .fontFamily('monospace')
              .width('100%')
          }
          if (diff.oldText !== null && diff.oldText.trim().length > 0) {
            Text(`− ${diff.oldText}`)
              .fontSize(12)
              .fontFamily('monospace')
              .width('100%')
              .fontColor($r('sys.color.ohos_id_color_alert'))
          }
          if (diff.newText !== null && diff.newText.trim().length > 0) {
            Text(`+ ${diff.newText}`)
              .fontSize(12)
              .fontFamily('monospace')
              .width('100%')
              .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
          }
        }
        .width('100%')
        .margin({ bottom: 6 })
        .alignItems(HorizontalAlign.Start)
      }, (diff: GenUiDiffEntry, index: number) => `${index}-${diff.path}`)
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  buttonView(node: GenUiNode) {
    if (this.labelOf(node).length > 0) {
      Button(this.labelOf(node))
        .type(ButtonType.Capsule)
        .height(38)
        .backgroundColor(Color.Transparent)
        .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
        .borderWidth(1)
        .borderColor($r('sys.color.ohos_id_color_text_primary_activated'))
        // 不带 `action` 就是禁用态（见文件头第 2 条）：否则用户点了没反应，只能理解成 App 坏了。
        .enabled(genUiStr(node, 'action') !== null)
        .onClick((): void => {
          this.onAnswer(this.labelOf(node));
        })
    }
  }

  @Builder
  formView(node: GenUiNode, indexKey: number) {
    if (genUiListItems(node).length > 0) {
      GenUiForm({
        options: genUiListItems(node),
        prompt: this.promptOf(node),
        defaultSelected: genUiStr(node, 'selected'),
        onAnswer: (text: string): void => {
          this.onAnswer(text);
        },
      })
    }
  }
}
