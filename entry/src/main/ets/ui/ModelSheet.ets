/**
 * 会话配置面板 —— 移植自原工程 `ui/ChatScreen.kt` 的
 * `ModelSheet` / `AgentPresetRow` / `ModelRow`（约 3056–3255 行）。
 *
 * 名字虽然叫"模型面板"，实际内容是**三件事**，所以这里用"会话配置"这个名字：
 * 1. Agent 预设（决定这个会话用什么 agent 人格与工具集）；
 * 2. 模型（provider + model）；
 * 3. 思考强度（只在选中的模型支持时出现）。
 *
 * ## 三条判据照抄源工程
 *
 * 1. **Agent 只在会话还空着时可改**（`session.blank == true`）。这条不是 UI 洁癖 ——
 *    服务端在第一条消息之后就锁死了 agent 配置，手机上让用户点一个必然失败的东西
 *    比不让点更糟。所以不可点，并且在下方用一句话说明**为什么**不能点
 *    （`agent_change_before_first_message` / `agent_locked_after_start` 两句）。
 * 2. **切换模型时把思考强度一起重置成该模型的默认值**（`model.reasoning?.defaultEffort`）。
 *    不带这个字段的话，从「支持高强度思考的模型」切到另一个模型时，
 *    服务端会收到一个它不认识的 effort 值。
 * 3. **思考强度只在"选中的那个模型"下面展开**。给每个模型都画一排强度按钮，
 *    列表会长到找不到目标；而用户实际只会调当前在用的那一个。
 *
 * ## 两处平台差异
 *
 * 1. **`FlowRow` → 换行 `Flex`**。源工程用 Material3 的 `FlowRow` 排列强度按钮；
 *    ArkUI 的对应物是 `Flex({ wrap: FlexWrap.Wrap })`，行为一致（按宽度自动换行）。
 * 2. **选中底色用 `ohos_id_color_secondary` 的浅色替代**。鸿蒙的语义色里没有与
 *    `secondaryContainer` 成对的容器色，这里用 `component_normal`（系统定义的
 *    浅色填充）+ 一个勾选符号共同表达"选中"，不靠底色单独承担语义 ——
 *    深色模式下容器色缺失时，只靠底色会看不出选没选。
 */

import { AgentPreset, ModelProviderGroup, ModelReasoningEffort, ModelSelection, ModelView,
  SessionModels } from '../core/Models';
import { ChatSession } from '../core/Models';
import { HarnessState } from '../core/HarnessViewModel';
import { harnessState } from './AppRuntime';

/** 面板列表占屏高的比例，与源工程 `fillMaxHeight(0.72f)` 一致。 */
const LIST_HEIGHT: string = '72%';

/** 会话配置面板需要的全部状态。集中成一个类，避免组件字段堆到十几项。 */
export class SessionConfigState {
  models: SessionModels | null = null;
  agentPresets: AgentPreset[] = [];
  /** 当前选中的会话；没有选中会话时给 null。 */
  session: ChatSession | null = null;
  /** 宿主是否支持写操作（`chat.write` 在 scopes 里）。 */
  canWrite: boolean = false;
  busy: boolean = false;

  constructor(models: SessionModels | null = null, agentPresets: AgentPreset[] = [],
    session: ChatSession | null = null, canWrite: boolean = false, busy: boolean = false) {
    this.models = models;
    this.agentPresets = agentPresets;
    this.session = session;
    this.canWrite = canWrite;
    this.busy = busy;
  }
}

/**
 * 当前生效的 Agent 预设 id。
 *
 * 会话自己记了的优先用它；没记（老会话、或服务端没回这个字段）就回退到
 * 「第一个可用且是默认的预设」—— 与服务端的实际行为一致。
 */
export function currentAgentPresetId(session: ChatSession | null, presets: AgentPreset[]): string | null {
  if (session !== null && session.agentPreset !== null) {
    return session.agentPreset;
  }
  for (let i = 0; i < presets.length; i++) {
    if (presets[i].isDefault && presets[i].available) {
      return presets[i].id;
    }
  }
  return null;
}

/** 切换 Agent 是否可用：空会话 + 预设可用 + 有写权限 + 不忙。四项缺一不可。 */
export function canSelectAgentPreset(session: ChatSession | null, preset: AgentPreset,
  canWrite: boolean, busy: boolean): boolean {
  if (session === null || !session.blank || !preset.available || !canWrite || busy) {
    return false;
  }
  return true;
}

/** 一行 Agent 预设。 */
@Component
struct AgentPresetRow {
  preset: AgentPreset = new AgentPreset();
  /**
   * 是否选中。**必须是 `@Prop`** —— 与 `ModelRowView.selected` 同因（见 PORT-MAP 坑 21）：
   * 普通成员只在初始化时赋值一次，而 `ForEach` 键是 `preset.id`（不含选中态），
   * 键不变就复用组件实例 → 换预设后勾号同样不动。
   */
  @Prop selected: boolean = false;
  /**
   * 是否可点（含 `!busy`、`chat.write` 等判据）。同理必须 `@Prop` —— 否则忙碌结束后
   * 整列会一直灰着（与坑 19b 的 `busy` 残留叠加时尤其难查）。
   */
  @Prop rowEnabled: boolean = true;
  onSelect: (id: string) => void = (): void => {};

  private titleText(): ResourceStr {
    return this.preset.isDefault
      ? $r('app.string.agent_default_format', this.preset.name)
      : this.preset.name;
  }

  private description(): string {
    const desc: string | null = this.preset.description;
    return desc === null ? '' : desc;
  }

  build() {
    Row() {
      Column() {
        Text(this.titleText())
          .fontSize(14)
          .fontWeight(FontWeight.Medium)
          .fontColor(this.rowEnabled || this.selected
            ? $r('sys.color.ohos_id_color_text_primary')
            : $r('sys.color.ohos_id_color_text_secondary'))
          .width('100%')
        if (this.description().length > 0) {
          Text(this.description())
            .fontSize(12)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
            .margin({ top: 2 })
        }
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      if (this.selected) {
        Text('✓')
          .fontSize(15)
          .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
      }
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 10, bottom: 10 })
    .borderRadius(8)
    .backgroundColor(this.selected
      ? $r('sys.color.ohos_id_color_component_normal')
      : Color.Transparent)
    .opacity(this.rowEnabled ? 1 : 0.55)
    .alignItems(VerticalAlign.Center)
    .onClick((): void => {
      if (this.rowEnabled) {
        this.onSelect(this.preset.id);
      }
    })
  }
}

/** 一行模型；选中时在下方展开思考强度。 */
@Component
struct ModelRowView {
  providerId: string = '';
  model: ModelView = new ModelView();
  /**
   * 本行是否选中。**必须是 `@Prop`**（见 PORT-MAP 坑 21）：普通成员只在初始化时赋值一次，
   * 而 `ForEach` 的键 `${group.id}:${model.id}` **不含选中态** —— 键不变就复用组件实例，
   * 普通成员于是永远停在首次渲染的那个值上。
   *
   * 真机证据链完整：点模型后①服务端回读 `current` 已切换（日志实证）②面板 `cfg()` 也重算了
   * （`rev` 递增日志实证）③勾号纹丝不动 —— 卡点就在这一行没同步。用户看到的
   * 「模型点击无响应」正是此因。`providerId` / `model` 可以留普通成员：它们的值由键锁定、
   * 行内不会再变。
   */
  @Prop selected: boolean = false;
  /**
   * 当前选中项，供思考强度区块判断「哪个 effort 选中」。同理必须是 `@Prop` ——
   * 否则换模型后强度选中态不刷新。
   */
  @Prop current: ModelSelection = new ModelSelection();
  onSelect: (selection: ModelSelection) => void = (): void => {};

  private description(): string {
    const desc: string | null = this.model.description;
    return desc === null ? '' : desc;
  }

  /** 有没有思考强度可调：只有 efforts 非空才算有。 */
  private hasEfforts(): boolean {
    const reasoning = this.model.reasoning;
    return reasoning !== null && reasoning.efforts.length > 0;
  }

  /** 可调的强度列表；没有 reasoning 时给空数组（`ForEach` 需要非空表达式）。 */
  private efforts(): ModelReasoningEffort[] {
    const reasoning = this.model.reasoning;
    return reasoning === null ? [] : reasoning.efforts;
  }

  /**
   * 点模型行 = 换模型，并且**把思考强度重置为这个模型的默认值**
   * （见文件头判据 2：不重置会把另一个模型不认识的 effort 发上去）。
   */
  private pickModel(): void {
    const reasoning = this.model.reasoning;
    const effort: string | null = reasoning === null ? null : reasoning.defaultEffort;
    this.onSelect(new ModelSelection(this.providerId, this.model.id, effort));
  }

  private effortActive(effortId: string): boolean {
    return this.current.reasoningEffort === effortId;
  }

  @Builder
  effortChip(effortId: string, effortName: string) {
    Text(effortName)
      .fontSize(12)
      .padding({ left: 12, right: 12, top: 7, bottom: 7 })
      .borderRadius(14)
      .border(this.effortActive(effortId)
        ? { width: 0, color: Color.Transparent }
        : { width: 1, color: $r('sys.color.ohos_id_color_list_separator') })
      .backgroundColor(this.effortActive(effortId)
        ? $r('sys.color.ohos_id_color_emphasize')
        : $r('sys.color.ohos_id_color_background'))
      .fontColor(this.effortActive(effortId)
        ? $r('sys.color.ohos_id_color_foreground_contrary')
        : $r('sys.color.ohos_id_color_text_primary'))
      .margin({ right: 7, bottom: 7 })
      .onClick((): void => {
        this.onSelect(new ModelSelection(this.providerId, this.model.id, effortId));
      })
  }

  build() {
    Column() {
      Row() {
        Column() {
          Text(this.model.name)
            .fontSize(15)
            .width('100%')
          if (this.description().length > 0) {
            Text(this.description())
              .fontSize(12)
              .fontColor($r('sys.color.ohos_id_color_text_secondary'))
              .maxLines(2)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .width('100%')
              .margin({ top: 2 })
          }
        }
        .layoutWeight(1)
        .alignItems(HorizontalAlign.Start)

        if (this.selected) {
          Text('✓')
            .fontSize(15)
            .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
        }
      }
      .width('100%')
      .alignItems(VerticalAlign.Center)

      if (this.selected && this.hasEfforts()) {
        Text($r('app.string.reasoning_effort'))
          .fontSize(11)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .width('100%')
          .margin({ top: 12, bottom: 7 })
        Flex({ wrap: FlexWrap.Wrap }) {
          ForEach(this.efforts(), (effort: ModelReasoningEffort) => {
            this.effortChip(effort.id, effort.name)
          }, (effort: ModelReasoningEffort) => effort.id)
        }
        .width('100%')
      }
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 12, bottom: 12 })
    .borderRadius(8)
    .backgroundColor(this.selected
      ? $r('sys.color.ohos_id_color_component_normal')
      : Color.Transparent)
    .alignItems(HorizontalAlign.Start)
    .onClick((): void => {
      this.pickModel();
    })
  }
}

/** 会话配置面板。 */
@Component
export struct SessionConfigSheet {
  /**
   * 面板数据快照 —— **由本组件自己从 vm 现算，不靠父组件传参**（真机踩坑，见 PORT-MAP 坑 21）。
   *
   * 起因：用户报「模型列表中模型点击无响应」。真机取证坐实：`pickModel` 日志确实打出来了
   * （`[DSH] pickModel agnes-ai-cn:agnes-3.0-flash`），但勾号纹丝不动 —— 点击没问题，
   * 是**面板内容冻结在打开那一刻**。修这个坑连错两次，记下来免得再犯：
   * ① 普通成员 `config`：只在初始化时赋值一次，父组件重绘不会同步给子组件；
   * ② 改成 `@Prop config`：`@Prop` 靠父组件更新驱动，而本组件是 `bindSheet` 的 content
   *    `@Builder` 造出来的 —— 那个 @Builder **不会**随父组件重绘重新执行，
   *    `@Prop` 于是永远拿不到新值（实测同样无效）。
   * 唯一可靠的路子是**组件自己订阅 `dshRevision`**（与 `AppShell.st()` / `ChatScreen.st()` 同款）：
   * vm 任何一次 `update()` 都让它重绘，重绘时 `cfg()` 重算快照。
   */
  @StorageLink('dshRevision') revision: number = 0;
  onSelectAgent: (id: string) => void = (): void => {};
  onSelectModel: (selection: ModelSelection) => void = (): void => {};

  /** 快照缓存：同一 revision 内多次调用只算一次（build 期间 `cfg()` 会被调很多次）。 */
  private cachedRevision: number = -1;
  private cachedConfig: SessionConfigState = new SessionConfigState();

  /**
   * 取当前快照。**读 `revision` 这个动作本身就是依赖登记**（坑 12）：ArkUI 只把 build 期间
   * 读过的状态算作依赖，不读就收不到更新 —— 少了这一读，整块面板就冻住了。
   */
  private cfg(): SessionConfigState {
    const rev: number = this.revision;
    if (rev !== this.cachedRevision) {
      this.cachedRevision = rev;
      this.cachedConfig = this.buildConfig();
    }
    return this.cachedConfig;
  }

  /** 从 vm 现算一份快照（对位 `ChatDetail.configState()`，判据一致）。 */
  private buildConfig(): SessionConfigState {
    const st: HarnessState | null = harnessState();
    if (st === null) {
      return new SessionConfigState();
    }
    const device = st.device;
    const canWrite: boolean = device !== null && device.scopes.includes('chat.write');
    return new SessionConfigState(st.sessionModels, st.agentPresets,
      this.sessionIn(st), canWrite, st.busy);
  }

  /** 当前选中的会话（`selectedSessionId` 在会话列表里查出来）。 */
  private sessionIn(st: HarnessState): ChatSession | null {
    const id: string | null = st.selectedSessionId;
    if (id === null) {
      return null;
    }
    const list: ChatSession[] = st.sessions;
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id) {
        return list[i];
      }
    }
    return null;
  }

  private preset(): string | null {
    const cfg: SessionConfigState = this.cfg();
    return currentAgentPresetId(cfg.session, cfg.agentPresets);
  }

  /** Agent 区块下方那句说明：空会话说"还能改"，否则说"已被锁定"。 */
  private lockNote(): ResourceStr {
    // 必须先存进局部变量再判空：`cfg()` 是**方法调用**，ArkTS 的流分析不跨两次调用
    // 保持窄化（两次调用被当成两个不同对象），写成 `this.cfg().session !== null
    // && this.cfg().session.blank` 会报 "Object is possibly 'null'"（10605999）。
    // 原先 `this.config.session` 能编译，是因为属性访问不产生这个问题。
    const cfg: SessionConfigState = this.cfg();
    const blank: boolean = cfg.session !== null && cfg.session.blank;
    return blank
      ? $r('app.string.agent_change_before_first_message')
      : $r('app.string.agent_locked_after_start');
  }

  private groups(): ModelProviderGroup[] {
    const models: SessionModels | null = this.cfg().models;
    return models === null ? [] : models.groups;
  }

  private currentSelection(): ModelSelection {
    const models: SessionModels | null = this.cfg().models;
    return models === null ? new ModelSelection() : models.current;
  }

  /**
   * 模型已选中判据：**provider 与 model 都要对上**。
   *
   * 只比 `model.id` 是不够的 —— 不同 provider 下可以有同名模型（实测有
   * `deepseek-chat` 在两个 provider 里都出现），只比 id 会同时给两行打勾。
   */
  private modelSelected(groupId: string, modelId: string): boolean {
    const current: ModelSelection = this.currentSelection();
    return current.provider === groupId && current.model === modelId;
  }

  @Builder
  agentBlock() {
    Column() {
      Text($r('app.string.agent_mode'))
        .fontSize(13)
        .fontWeight(FontWeight.Medium)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .width('100%')
        .margin({ top: 4, bottom: 6 })

      ForEach(this.cfg().agentPresets, (preset: AgentPreset) => {
        AgentPresetRow({
          preset: preset,
          selected: preset.id === this.preset(),
          rowEnabled: canSelectAgentPreset(this.cfg().session, preset,
            this.cfg().canWrite, this.cfg().busy),
          onSelect: this.onSelectAgent,
        })
      }, (preset: AgentPreset) => `agent:${preset.id}`)

      Text(this.lockNote())
        .fontSize(12)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .width('100%')
        .margin({ top: 7, bottom: 10 })

      Divider()
        .strokeWidth(1)
        .color($r('sys.color.ohos_id_color_list_separator'))
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }

  @Builder
  modelBlock() {
    if (this.cfg().models === null) {
      Column() {
        LoadingProgress()
          .width(22)
          .height(22)
          .color($r('sys.color.ohos_id_color_text_secondary'))
      }
      .width('100%')
      .height(120)
      .justifyContent(FlexAlign.Center)
    } else {
      // —— 根因修复（真机 dump 取证，见 PORT-MAP §1b 坑 14）——
      //
      // 这里原来**没有外层 Column**：`ForEach` 生成的每一个子节点（provider 标题、
      // 每个 ModelRowView、Divider）都被直接挂在 `ListItem` 上。而 `ListItem` 是
      // **单子节点**容器 —— 挂多个子节点时它们会被层叠到同一位置，不是依次向下排。
      // 实测 dump（修复前）：所有 provider 标题的 origBounds 都是
      // `[124,1284][956,1332]`，所有模型行的 origBounds 都是 `[161,1268][919,1323]`，
      // 于是 20 多个模型挤在同一个点上 —— 用户看到的"模型挤到一堆"。
      //
      // 同一文件里的 `agentBlock()` 之所以显示正常，正是因为它外层包了 Column
      // （dump 里四行 Agent 预设的 y 坐标各不相同：526 / 647 / 760 / 873）。
      Column() {
        ForEach(this.groups(), (group: ModelProviderGroup) => {
          Text(group.name)
            .fontSize(13)
            .fontWeight(FontWeight.Medium)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .width('100%')
            .margin({ top: 14, bottom: 6 })

          ForEach(group.models, (model: ModelView) => {
            ModelRowView({
              providerId: group.id,
              model: model,
              selected: this.modelSelected(group.id, model.id),
              current: this.currentSelection(),
              onSelect: this.onSelectModel,
            })
            Divider()
              .strokeWidth(1)
              .color($r('sys.color.ohos_id_color_list_separator'))
          }, (model: ModelView) => `${group.id}:${model.id}`)
        }, (group: ModelProviderGroup) => group.id)
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
  }

  build() {
    Column() {
      Text($r('app.string.session_configuration'))
        .fontSize(20)
        .fontWeight(FontWeight.Medium)
        .width('100%')
      Text($r('app.string.session_configuration_subtitle'))
        .fontSize(13)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .width('100%')
        .margin({ top: 4, bottom: 18 })

      List() {
        if (this.cfg().agentPresets.length > 0) {
          ListItem() {
            this.agentBlock()
          }
        }
        ListItem() {
          this.modelBlock()
        }
      }
      .width('100%')
      .height(LIST_HEIGHT)
      .scrollBar(BarState.Auto)
    }
    .width('100%')
    .padding({ left: 22, right: 22, bottom: 28 })
    .alignItems(HorizontalAlign.Start)
  }
}
