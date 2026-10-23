/**
 * 聊天详情页的全屏覆盖层（从 `ChatDetail.ets` 拆出，见 `docs/TECH-DEBT.md`）。
 *
 * - `ImageViewer`：图片全屏查看器（对位源工程 `ui/chat/ChatImageViewer.kt`）。
 * - `TrajectoryCover`：执行轨迹页（`TrajectoryScreen` 的薄包装，理由见其文件头）。
 *
 * `bindContentCover` 的 `isShow` 仍只有一个来源（住在 `ChatDetail`），
 * 这里只负责**画什么**，不负责**何时显示**。
 */

import { TrajectoryScreen } from './TrajectoryScreen';
import { OVERLAY_MASK_DARK, OVERLAY_MASK_LIGHT } from '../core/ThemePalettes';

/**
 * 图片全屏查看器。
 *
 * 用 `bindContentCover` 挂在宿主根节点上时，返回键与底部系统手势区由系统接管。
 */
@Component
export struct ImageViewer {
  /** 已解码位图；null 时不画图片（宿主在解码失败时不会打开此组件）。 */
  pixelMap: PixelMap | null = null;
  onClose: () => void = (): void => {};
  onSave: () => void = (): void => {};

  build() {
    Column() {
      Stack({ alignContent: Alignment.TopEnd }) {
        if (this.pixelMap !== null) {
          Image(this.pixelMap)
            .objectFit(ImageFit.Contain)
            .width('100%')
            .height('100%')
        }

        Text('✕')
          .fontSize(20)
          .width(40)
          .height(40)
          .textAlign(TextAlign.Center)
          .borderRadius(20)
          .fontColor(Color.White)
          .backgroundColor(OVERLAY_MASK_DARK)
          .margin({ top: 12, right: 12 })
          .onClick((): void => {
            this.onClose();
          })
      }
      .width('100%')
      .layoutWeight(1)
      // 点图片区域关闭；与右上 ✕ 两条路都通，用户不必去找那个小按钮。
      // 只挂在**图片区**而不是整页：整页的话，点「保存」时事件会先冒到父级把查看器关掉。
      .onClick((): void => {
        this.onClose();
      })

      Text($r('app.string.save'))
        .fontSize(15)
        .fontColor(Color.White)
        .padding({ left: 20, right: 20, top: 10, bottom: 10 })
        .borderRadius(20)
        .backgroundColor(OVERLAY_MASK_LIGHT)
        .margin({ top: 12, bottom: 20 })
        .onClick((): void => {
          this.onSave();
        })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(Color.Black)
    .justifyContent(FlexAlign.Center)
  }
}

/**
 * 执行轨迹页的薄包装。
 *
 * 不传 history：`TrajectoryScreen` 自订阅 vm（理由见其文件头）。
 */
@Component
export struct TrajectoryCover {
  onClose: () => void = (): void => {};

  build() {
    TrajectoryScreen({
      onClose: this.onClose,
    })
  }
}
