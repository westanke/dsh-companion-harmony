import { common } from '@kit.AbilityKit';
import { HarnessState, OpenDocument } from '../core/HarnessViewModel';
import { currentMainSection, initHarness, harnessState, harnessVm, requestUnsavedPrompt } from '../ui/AppRuntime';
import { ConnectScreen } from '../ui/ConnectScreen';
import { AppShell, MainSection } from '../ui/AppShell';

/**
 * 应用根页 —— 移植自原工程 `ui/App.kt`（369 行）的**页面判据**部分。
 *
 * ## 判据（与原工程逐字对齐）
 *
 * ```
 * 显示连接页  ⟺  !connectGatePassed || !state.connected
 * 显示主界面  ⟺  connectGatePassed && state.connected
 * ```
 *
 * 三个反直觉但必须保持的点：
 * 1. **不能只看 `connected`**。冷启动自动重连成功时 `connected` 会变成 true，而那时
 *    用户还没点头 —— 拿它当条件会直接跳过连接页，那正是源工程修过的毛病。
 * 2. **门闩是进程级的**（`HarnessViewModel.connectGate`），且 `HarnessState` 在 disconnect
 *    时会被整份重建；把门闩放进那份状态，连上之后就会被冲掉 —— 表现是「刚进主界面又被弹回连接页」。
 * 3. 也**不要**把 `restoring` 排在前面：冷启动自动重连要依次探活全部地址，可能持续好几秒，
 *    若先渲染转圈，这几秒里用户看到的就是转圈而不是连接页。
 *
 * 主界面已接到 `AppShell`（抽屉 / 分节 / 错误 toast），五个分节全部落地：
 * 会话 `ChatScreen`、文件 `FilesScreen`、插件 `PluginsScreen`、模型 `ModelsScreen`、
 * 设置 `SettingsScreen`（平台层自检的落点也在这里）。
 * 语言与主题跟随系统：全部文案走 `resources/base`（中文）与 `resources/en_US`（英文预留），
 * 颜色走 `sys.color.*`。
 */
@Entry
@Component
struct Index {
  @StorageLink('dshRevision') revision: number = 0;
  @State ready: boolean = false;

  aboutToAppear(): void {
    const context: common.Context | undefined = this.getUIContext().getHostContext();
    if (context === undefined) {
      return;
    }
    // 装配全 App 唯一的 HarnessViewModel（含 preferences / 加密 / HTTP / WS / 时区 / 语言）。
    initHarness(context);
    this.ready = true;
  }

  /** 当前状态；vm 未装配时给一个默认值，避免 build 里到处判空。 */
  private st(): HarnessState | null {
    return harnessState();
  }

  private showConnect(): boolean {
    const vm = harnessVm();
    const st: HarnessState | null = this.st();
    if (vm === null || st === null) {
      return true;
    }
    // 原工程的两个条件，一个都不能少。
    return !vm.connectGate || !st.connected;
  }

  build() {
    Column() {
      // 注意：ArkUI 的 build() 只能有一个根容器节点，**不能**在里面写局部变量声明
      // （会报「build method can have only one root node」）。所以 revision 的读取
      // 内联在条件里：`this.revision < 0` 恒假，但读它这一步会让 ArkUI 登记依赖，
      // 于是 vm 每次 `update()`（revision++ → AppStorage）都能触发本页重绘。
      if (!this.ready || this.revision < 0) {
        LoadingProgress().width(32).height(32)
      } else if (this.showConnect()) {
        ConnectScreen({
          onEnterApp: (): void => {
            const vm = harnessVm();
            if (vm !== null) {
              vm.passConnectGate();
            }
          },
        })
      } else {
        AppShell()
      }
    }
    .width('100%')
    .height('100%')
    .backgroundColor($r('sys.color.ohos_id_color_background'))
  }

  /**
   * 系统返回（返回键 / 手势侧滑）拦截。
   *
   * 会话详情开着时，返回应当是「退回会话列表」而不是直接退出应用 —— 用户真机反馈：
   * 「会话页从右向左滑动直接退出了，应该先返回到会话列表」。窄屏下详情是整页，侧滑即
   * 返回手势，系统按「出栈」处理；而本工程的分节切换**不是路由栈**（没有 Navigation /
   * NavPathStack），系统无从得知「还能往回退一步」，于是直接退到桌面。所以在这里显式接住：
   * 详情开着就清空选中并消费掉这次返回，否则返回 `false` 交还系统（正常退出）。
   *
   * 只清选中、**不断连接**：`selectSession(null)` 只重置会话相关状态（历史 / 审批 / 问答 /
   * 补全），连接与事件流照旧，退回列表是即时的。
   *
   * 第二段是**文件页的未保存改动**：顶栏返回箭头只是离开编辑器的其中一条路径，
   * 系统返回键是另一条；只拦一处，等于「不用点那个按钮就能绕过确认」。判定与面板
   * 都在文件分节里，这里只做「停在那且改过没存 → 请它弹面板」这一件事
   * （邮箱走法见 `AppRuntime.requestUnsavedPrompt`）。
   */
  onBackPress(): boolean {
    const vm = harnessVm();
    const st: HarnessState | null = this.st();
    if (vm === null || st === null) {
      return false;
    }
    // 先判文件页：`selectedSessionId` 跨分节存活，若先判它，用户停在文件分节按返回
    // 会莫名其妙地把后台那个会话的选清除掉，而不是处理眼前这份文档。
    if (currentMainSection() === MainSection.Files && this.documentDirty()) {
      requestUnsavedPrompt();
      // 消费掉这次返回：先让用户决定「留下 / 丢弃 / 保存」，而不是默默退出应用。
      return true;
    }
    if (st.selectedSessionId !== null) {
      void vm.selectSession(null);
      return true;
    }
    return false;
  }

  /** 文件页当前那份文档改过还没存（判定在数据层，见 `OpenDocument.hasUnsavedChanges`）。 */
  private documentDirty(): boolean {
    const st: HarnessState | null = this.st();
    const document: OpenDocument | null = st === null ? null : st.document;
    return document !== null && document.hasUnsavedChanges();
  }
}
