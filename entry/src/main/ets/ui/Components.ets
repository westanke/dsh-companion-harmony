/**
 * 可复用界面组件 —— 移植自原工程 `ui/Components.kt` 里被多个页面共用的那几件。
 *
 * 抽成公共组件的理由与原工程一致：「一处能看、另一处只有一行字」这种分歧在本项目里
 * 反复出现过，所以同一件事只留一份实现，谁都别再走偏。
 *
 * 主题：**全部走系统语义色**（`sys.color.ohos_id_color_*`），因此深浅色随手机自动切换，
 * 不需要本工程维护两套色板 —— 对应源工程「主题跟随系统」的要求。
 * 图标用**文字字形**（⚠ / ● / ⌄），避免为几个小图标去引入图片资源。
 */

import { EndpointKind } from '../core/ConnectionModels';
import { PreviewKind, binaryPreviewByteLimit } from '../core/PreviewKind';
import { formatBytes } from '../core/ChatContentParts';
import { decodeImageSync } from '../platform/ImageCodec';

/** 品牌标记：圆角方块 + DSH 字样。 */
@Component
export struct BrandMark {
  build() {
    Row() {
      Text('DSH')
        .fontSize(13)
        .fontWeight(FontWeight.Bold)
        .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
    }
    .width(40)
    .height(40)
    .borderRadius(10)
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
    .justifyContent(FlexAlign.Center)
  }
}

/**
 * 警示条。
 *
 * 用于「HTTP 明文」「这段文本等同于钥匙」「凭据已过期」这类**用户必须先看见**的提示。
 * 刻意用次背景色而不是红 —— 这些不是错误，是不该被忽略的前提条件。
 */
@Component
export struct WarningBanner {
  /** 已解析好的文案（调用方用 `$r` 的参数化形式或普通 `$r` 传进来）。 */
  message: ResourceStr = '';

  build() {
    Row() {
      Text('⚠')
        .fontSize(15)
        .fontColor($r('sys.color.ohos_id_color_warning'))
      Text(this.message)
        .fontSize(12)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .layoutWeight(1)
        .margin({ left: 8 })
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 10, bottom: 10 })
    .borderRadius(8)
    .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
    .alignItems(VerticalAlign.Top)
  }
}

/** 状态标签：一个小圆点 + 文案（已连接 / 运行中…）。 */
@Component
export struct StatusLabel {
  label: ResourceStr = '';
  active: boolean = false;

  build() {
    Row() {
      Circle()
        .width(7)
        .height(7)
        .fill(this.active ? $r('sys.color.ohos_id_color_text_primary_activated')
          : $r('sys.color.ohos_id_color_text_secondary'))
      Text(this.label)
        .fontSize(12)
        .margin({ left: 6 })
        .fontColor(this.active ? $r('sys.color.ohos_id_color_text_primary_activated')
          : $r('sys.color.ohos_id_color_text_secondary'))
    }
  }
}

/** 地址类型的中文名（局域网 / 虚拟网 / 公网 / 其他）。返回资源对象，交给 `Text` 渲染。 */
export function endpointKindLabel(kind: EndpointKind): Resource {
  if (kind === EndpointKind.LAN) {
    return $r('app.string.endpoint_kind_lan');
  }
  if (kind === EndpointKind.VIRTUAL_NET) {
    return $r('app.string.endpoint_kind_virtual');
  }
  if (kind === EndpointKind.WAN) {
    return $r('app.string.endpoint_kind_wan');
  }
  return $r('app.string.endpoint_kind_unknown');
}

/**
 * 二进制文件预览 —— 对位源工程 `Components.kt` 里的 `BinaryFilePreview`。
 *
 * 抽成公共组件（聊天详情页的会话文件面板、文件页的编辑器都用它）而不是各写一份，
 * 理由与源工程把这段放进 `Components.kt` 一样：解码方式、「跳过是因为太大」与
 * 「根本还没加载」的区分、以及失败文案，只有一处实现才不会两边走偏。
 *
 * 四个分支（与源工程同序）：
 * 1. `skippedForSize` → 说明「因为太大跳过」并给出**实际大小与上限两个数**；
 * 2. `kind == IMAGE` 且有字节 → 解码后显示（ArkUI 的 `Image` 只认 `PixelMap`）；
 * 3. `kind == PDF` → **平台降级**：ArkUI 没有 PDF 组件，只能如实说明并引导去文件页；
 * 4. 其余 → `fallbackMessage`（「这不是文本」这类）。
 *
 * 解码失败（`pixelMap == null`）**也走第 4 分支**，不显示空白 —— 否则用户会以为
 * 后端没返回字节，而实际上字节到了、只是这份图解不开。
 */
@Component
export struct BinaryFilePreview {
  kind: PreviewKind = PreviewKind.SOURCE;
  bytes: Uint8Array | null = null;
  sizeBytes: number = 0;
  /** 服务端因为太大而没下发字节（与「还没加载完」是两件不同的事）。 */
  skippedForSize: boolean = false;
  fallbackMessage: ResourceStr = '';
  /** 跳过预览时的补充说明（本工程两处用词不同：文件页引导下载、面板引导去文件页）。 */
  skippedHint: ResourceStr = '';
  /** 是否显示「下载」入口。用布尔量而不是可空回调，避免 ArkTS 对可空函数字段的类型纠结。 */
  showDownload: boolean = false;
  onDownload: () => void = (): void => {};

  @State pixelMap: PixelMap | null = null;

  aboutToAppear(): void {
    if (this.kind === PreviewKind.IMAGE && this.bytes !== null) {
      this.pixelMap = decodeImageSync(this.bytes);
    }
  }

  /** 该预览类型的字节上限；未定义时按 0（显示成「超过 0 B」，只在配置缺失时出现）。 */
  private limitBytes(): number {
    const limit: number | null = binaryPreviewByteLimit(this.kind);
    return limit === null ? 0 : limit;
  }

  @Builder
  notice(icon: string, text: ResourceStr) {
    Column() {
      Text(icon)
        .fontSize(30)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
      Text(text)
        .fontSize(13)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .textAlign(TextAlign.Center)
        .margin({ top: 8 })
    }
    .width('100%')
    .height('100%')
    .justifyContent(FlexAlign.Center)
  }

  build() {
    Column() {
      if (this.skippedForSize) {
        Column() {
          this.notice('⚠', $r('app.string.preview_skipped_too_large',
            formatBytes(this.sizeBytes), formatBytes(this.limitBytes())))
          if (this.showDownload) {
            Button($r('app.string.download'))
              .type(ButtonType.Capsule)
              .height(36)
              .margin({ top: 10 })
              .onClick((): void => {
                this.onDownload();
              })
          }
          if (this.skippedHint !== '') {
            Text(this.skippedHint)
              .fontSize(12)
              .fontColor($r('sys.color.ohos_id_color_text_secondary'))
              .textAlign(TextAlign.Center)
              .margin({ top: 8 })
          }
        }
        .width('100%')
        .height('100%')
        .justifyContent(FlexAlign.Center)
      } else if (this.kind === PreviewKind.IMAGE) {
        if (this.pixelMap !== null) {
          Image(this.pixelMap)
            .width('100%')
            .height('100%')
            .objectFit(ImageFit.Contain)
        } else {
          this.notice('🖼', this.fallbackMessage)
        }
      } else if (this.kind === PreviewKind.PDF) {
        // 平台降级：ArkUI 没有 PDF 组件（拉 WebView 或引三方库都会抬包体/权限）。
        // 如实标注成「这个平台做不到」，并把用户引到能真正打开它的地方。
        this.notice('📕', $r('app.string.session_file_pdf_unsupported'))
      } else {
        this.notice('📄', this.fallbackMessage)
      }
    }
    .width('100%')
    .height('100%')
  }
}
