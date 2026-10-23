/**
 * 模型分节 —— 移植自原工程 `ui/ModelsScreen.kt`（463 行）的
 * `ModelsScreen` / `CustomProviderEditor` / `ProviderRow` / `ProviderEditor`。
 *
 * ## 为什么这一块从设置页拆出来单独成一个分节
 *
 * 源工程的文件头写过理由，这里照抄：**「换模型」是高频动作，「改语言/看版本」是低频动作**，
 * 两者不该抢同一个入口 —— 原来设置页把「模型供应商」放在最顶部，用户每次想换模型都得先进设置。
 * 所以本页只放**模型供应商**（列表 / 新建自定义供应商 / 单条编辑），设置页保留设备、语言、
 * 发送模式、聊天实现、调试与关于。
 *
 * ## 五条判据照抄源工程，不许"优化"
 *
 * 1. **`settings.read` 是准入、`settings.write` 才是可改**。两个 scope 分工不同：
 *    没 `settings.read` 连列表都读不到（顶部 `WarningBanner` 说明原因）；
 *    有 `settings.read` 但没 `settings.write` 时列表照常显示，只是每一行都不可点。
 * 2. **`canEdit` 是三个条件同时成立**：`settings.write in scopes` && `providerSettings.writable`
 *    && `provider.configurable`。三个都要 —— 前两个是「你有没有权限 / 服务器让不让你改」，
 *    第三个是「这个供应商本身是不是可配置的」（内置供应商的 baseURL 由 DSH 自己管，不给改）。
 * 3. **点开编辑之前先 `clearDiscoveredModels()`**。上一次「发现模型」的结果不能带到下一个供应商，
 *    否则在新供应商的编辑器里会看到上一个供应商发现的模型列表，一按「使用发现结果」就写错了模型。
 * 4. **`provider_secret_note` 必须显示**。它说明「API 密钥只写入服务器凭据库，App 不会读取或显示
 *    已保存的密钥」—— 少了这句，用户会以为「凭据已配置」那一行能点开看密钥，然后找不到。
 * 5. **改动模型列表时要区分「继承」与「覆盖」**：`modelsInherited` 为真且用户没动过模型列表时，
 *    patch 里**不带** `models` 字段（`null`），保持继承；一旦用户真的改了，才写成固定覆盖。
 *    写成「总是提交当前列表」会让所有继承供应商统统变成硬覆盖 —— 用户以后在电脑上改模型目录，
 *    手机上再也跟不上了。
 *
 * ## 四处平台差异
 *
 * 1. **两个 `ModalBottomSheet`（编辑 / 新建）合成一个 `bindSheet` 宿主 + `sheetKind`**，
 *    与详情页、文件页同一套做法（ArkUI 的 `bindSheet` 一次只挂一个 builder）。
 *    高度：源工程分别给屏高的 0.9 / 0.92，ArkUI 只有 `MEDIUM` / `LARGE` / `FIT_CONTENT` 三档，
 *    取 **`SheetSize.LARGE`** 最接近（这两个表单加起来十来个输入框，`MEDIUM` 装不下）。
 * 2. **协议下拉用 `bindMenu(MenuElement[])`**（与详情页 `⋯` 菜单同一套数据形式），
 *    源工程是 `OutlinedButton` + `DropdownMenu`。
 * 3. **密码框用 `InputType.Password`**（对位 `PasswordVisualTransformation`），
 *    地址栏用 `InputType.URL`（对位 `KeyboardType.Uri`）。
 * 4. **`OutlinedTextField` 的 `label` / `supportingText` 没有对应概念**：
 *    字段名改成输入框上方的 `Text`（12vp 次要色），提示句改成 `placeholder`；
 *    需要同时给「占位」和「说明」两句话的地方（模型 ID 那两处）把说明放到输入框下方。
 *    校验失败用 `.border({ color: warning })` 而不是 `isError`（ArkUI 的 `TextInput` 没有 isError）。
 */

import { common } from '@kit.AbilityKit';
import {
  CustomProviderCapability, CustomProviderCreate, ProviderModel, ProviderPatch, ProviderSettings,
  ProviderView,
} from '../core/Models';
import { HarnessState, HarnessViewModel } from '../core/HarnessViewModel';
import { harnessState, harnessVm } from './AppRuntime';
import { WarningBanner } from './Components';
import { supportsModelCatalog, supportsProviderSettings } from '../core/BridgeCapabilities';

/** 面板宿主的两态（`sheetKind` 只在本文件内使用，故用数字常量而非导出枚举）。 */
const SHEET_EDIT_PROVIDER: number = 0;
const SHEET_CREATE_PROVIDER: number = 1;

/** 内容最大宽度（对位源工程 `widthIn(max = 720.dp)`）。 */
const CONTENT_MAX_WIDTH: number = 720;

/** 模型 ID 输入区的高度（对位源工程 `.height(150.dp)`）。 */
const MODEL_IDS_HEIGHT: number = 150;

/** 供应商 ID 的合法形态：小写字母开头，可含数字与连字符（源工程同款正则）。 */
const PROVIDER_ID_PATTERN: string = '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$';

/**
 * 把多行/逗号分隔的模型 ID 文本切成模型列表（对位源工程 `parseModelIds`）。
 *
 * 按 `\n` 与 `,` 两种分隔符切、去首尾空白、丢掉空项、去重（保留首次出现的顺序）。
 * 两种分隔符都要认：从别处复制过来的模型列表经常是逗号分隔的一行。
 */
function parseModelIds(value: string): ProviderModel[] {
  const raw: string[] = value.split('\n').join(',').split(',');
  const out: ProviderModel[] = [];
  const seen: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const id: string = raw[i].trim();
    if (id.length === 0 || seen.includes(id)) {
      continue;
    }
    seen.push(id);
    const model: ProviderModel = new ProviderModel();
    model.id = id;
    out.push(model);
  }
  return out;
}

/** 两个模型列表的 id 序列是否一致（判据 5 的「用户没动过」比较用）。 */
function sameModelIds(a: ProviderModel[], b: ProviderModel[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) {
      return false;
    }
  }
  return true;
}

/** 模型列表 → 每行一个 id 的文本（编辑器初值）。 */
function modelIdsText(models: ProviderModel[]): string {
  const lines: string[] = [];
  for (let i = 0; i < models.length; i++) {
    lines.push(models[i].id);
  }
  return lines.join('\n');
}

/**
 * 表单里的一行：字段名 + 输入框 + 可选说明。
 *
 * 抽成 `@Builder` 而不是 `@Component`：它只画静态骨架，输入框本体由调用方传进来 ——
 * `@Builder` 支持尾随 lambda（`trailing closure`）形式的子内容。
 */
@Builder
function fieldLabel(text: ResourceStr) {
  Text(text)
    .fontSize(12)
    .fontColor($r('sys.color.ohos_id_color_text_secondary'))
    .width('100%')
    .margin({ bottom: 4 })
}

/** 一条供应商（列表行）。 */
@Component
struct ProviderRow {
  provider: ProviderView = new ProviderView();
  canEdit: boolean = false;
  onOpen: (provider: ProviderView) => void = (): void => {};

  private credentialLine(): ResourceStr {
    return this.provider.credential.configured
      ? $r('app.string.credential_configured')
      : $r('app.string.credential_missing');
  }

  build() {
    Row() {
      // 圆形徽标：源工程用 ModelTraining 图标，这里用字形代替（省一份图片资源）。
      // 启用中的供应商用强调色、未启用的用常色。
      Text('🧠')
        .fontSize(17)
        .width(38)
        .height(38)
        .textAlign(TextAlign.Center)
        .borderRadius(19)
        .backgroundColor(this.provider.active
          ? $r('sys.color.ohos_id_color_emphasize')
          : $r('sys.color.ohos_id_color_component_normal'))

      Column() {
        Row() {
          Text(this.provider.displayName)
            .fontSize(15)
            .fontWeight(FontWeight.Medium)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1)
          if (this.provider.active) {
            Text($r('app.string.active'))
              .fontSize(11)
              .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
              .margin({ left: 8 })
          }
        }
        .width('100%')
        .alignItems(VerticalAlign.Center)

        Text(this.credentialLine())
          .fontSize(12)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .width('100%')
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)
      .margin({ left: 12, right: 8 })

      if (this.provider.credential.configured) {
        Text('✓')
          .fontSize(15)
          .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
      }
      // 不可编辑时**不画那个箭头**：画了箭头就是"这里能点进去"，点不动会让人以为卡了。
      if (this.canEdit) {
        Text('›')
          .fontSize(17)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .margin({ left: 8 })
      }
    }
    .width('100%')
    .padding({ left: 2, right: 2, top: 14, bottom: 14 })
    .alignItems(VerticalAlign.Center)
    .opacity(this.canEdit ? 1 : 0.6)
    .onClick((): void => {
      if (this.canEdit) {
        this.onOpen(this.provider);
      }
    })
  }
}

/**
 * 单条供应商的编辑器（源工程 `ProviderEditor`）。
 *
 * 表单值全部是**本地草稿**（`form*` 前缀）：源工程用 `remember(provider.id)`，
 * 等价物是「组件实例随 provider 重建」，所以每个供应商打开时都是它的当前配置。
 * 字段名统一带 `form` 前缀还有个用意：避开 ArkUI 通用属性方法名（见 PORT-MAP §1b 坑 7）。
 */
@Component
struct ProviderEditor {
  provider: ProviderView = new ProviderView();
  discovered: ProviderModel[] = [];
  busy: boolean = false;
  onClose: () => void = (): void => {};
  onSubmit: (providerId: string, patch: ProviderPatch) => void = (): void => {};
  onDiscover: (providerId: string, baseURL: string, protocol: string, apiKey: string) => void =
    (): void => {};
  onResetModels: (providerId: string) => void = (): void => {};
  onDelete: (providerId: string) => void = (): void => {};
  /** provider-settings-v1 能力位；false 时「重置模型列表 / 删除此供应商」入口隐藏。 */
  providerWritable: boolean = false;
  /** model-catalog-v1 能力位；false 时「发现模型」入口隐藏。 */
  modelCatalog: boolean = false;

  @State formName: string = '';
  @State formBaseUrl: string = '';
  @State formProtocol: string = '';
  @State formApiKey: string = '';
  @State formModels: string = '';

  aboutToAppear(): void {
    // 显示名回落到 id 之外的名字：`config.displayName` 为空时用服务器给的 `displayName`，
    // 与源工程 `provider.config.displayName ?: provider.displayName` 一致。
    const configName: string | null = this.provider.config.displayName;
    this.formName = configName === null ? this.provider.displayName : configName;
    this.formBaseUrl = this.provider.config.baseURL ?? '';
    this.formProtocol = this.provider.config.api ?? '';
    this.formModels = modelIdsText(this.provider.config.models);
  }

  private credentialLine(): ResourceStr {
    if (this.provider.credential.configured) {
      return $r('app.string.credential_reference', this.provider.credential.ref);
    }
    return $r('app.string.credential_missing');
  }

  /**
   * 提交。
   *
   * 模型列表那一栏按判据 5 处理：**继承且没动过 → 不带 `models`**（保持继承），
   * 真的改了才写成固定的 id 列表。
   */
  private submit(): void {
    const parsed: ProviderModel[] = parseModelIds(this.formModels);
    const unchanged: boolean = this.provider.config.modelsInherited
      && sameModelIds(parsed, this.provider.config.models);
    const patch: ProviderPatch = new ProviderPatch();
    patch.displayName = this.formName.trim();
    patch.baseURL = this.formBaseUrl.trim();
    patch.api = this.formProtocol.trim();
    patch.apiKey = this.formApiKey.trim().length === 0 ? null : this.formApiKey;
    patch.models = unchanged ? null : parsed;
    this.onSubmit(this.provider.id, patch);
    this.onClose();
  }

  private resText(res: Resource): string {
    const ctx: common.Context | undefined = this.getUIContext().getHostContext();
    if (ctx === undefined) {
      return '';
    }
    return ctx.resourceManager.getStringSync(res.id);
  }

  private hasDiscovered(): boolean {
    return this.discovered.length > 0;
  }

  private discoveredLine(): ResourceStr {
    return $r('app.string.discovered_models', this.discovered.length);
  }

  @Builder
  label(text: ResourceStr) {
    fieldLabel(text)
  }

  build() {
    Column() {
      Text(this.provider.displayName)
        .fontSize(20)
        .fontWeight(FontWeight.Medium)
        .width('100%')
      Text(this.provider.id)
        .fontSize(12)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .width('100%')
      Text(this.credentialLine())
        .fontSize(12)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .width('100%')
        .margin({ top: 2 })

      Column().height(13)

      this.label($r('app.string.provider_display_name'))
      TextInput({ text: this.formName })
        .width('100%')
        .onChange((value: string): void => {
          this.formName = value;
        })

      Column().height(13)

      this.label($r('app.string.base_url'))
      TextInput({ text: this.formBaseUrl, placeholder: this.resText($r('app.string.server_default')) })
        .type(InputType.URL)
        .width('100%')
        .onChange((value: string): void => {
          this.formBaseUrl = value;
        })

      Column().height(13)

      this.label($r('app.string.provider_protocol'))
      TextInput({ text: this.formProtocol, placeholder: this.resText($r('app.string.server_default')) })
        .width('100%')
        .onChange((value: string): void => {
          this.formProtocol = value;
        })

      Column().height(13)

      this.label($r('app.string.api_key'))
      TextInput({
        text: this.formApiKey,
        placeholder: this.provider.credential.configured
          ? this.resText($r('app.string.keep_existing_secret'))
          : this.resText($r('app.string.enter_api_key')),
      })
        .type(InputType.Password)
        .width('100%')
        .onChange((value: string): void => {
          this.formApiKey = value;
        })

      // 「发现模型」走 `POST .../discover`，按 model-catalog-v1 探测，老 bridge 不支持时隐藏。
      if (this.modelCatalog) {
        Row() {
          Row() {
            if (this.busy) {
              LoadingProgress().width(18).height(18).margin({ right: 8 })
            }
            Text('🧠').fontSize(14)
            Text($r('app.string.discover_models'))
              .fontSize(13)
              .margin({ left: 7 })
          }
          .padding({ left: 12, right: 12, top: 7, bottom: 7 })
          .borderRadius(18)
          .border({ width: 1, color: $r('sys.color.ohos_id_color_component_normal') })
          .alignItems(VerticalAlign.Center)
          .opacity(this.busy ? 0.4 : 1)
          .enabled(!this.busy)
          .onClick((): void => {
            this.onDiscover(this.provider.id, this.formBaseUrl, this.formProtocol, this.formApiKey);
          })
        }
        .width('100%')
        .justifyContent(FlexAlign.End)
        .margin({ top: 13 })
      }

      // 发现结果：一句「已发现 N 个模型」+ 一个「使用发现结果」。
      // 这两行只在真的发现了模型时出现（空列表时按「使用」会把用户的模型列表清空）。
      if (this.hasDiscovered()) {
        Text(this.discoveredLine())
          .fontSize(13)
          .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
          .width('100%')
          .margin({ top: 13 })
        Text($r('app.string.use_discovered_models'))
          .fontSize(13)
          .fontColor($r('sys.color.ohos_id_color_text_primary_activated'))
          .margin({ top: 4 })
          .onClick((): void => {
            this.formModels = modelIdsText(this.discovered);
          })
      }

      Column().height(13)

      this.label($r('app.string.model_ids'))
      TextArea({ text: this.formModels })
        .width('100%')
        .height(MODEL_IDS_HEIGHT)
        .onChange((value: string): void => {
          this.formModels = value;
        })
      // 提示句随「继承」与否切换：继承状态下用户不该以为必须把目录抄一遍。
      Text(this.provider.config.modelsInherited
        ? $r('app.string.inherited_model_ids_hint')
        : $r('app.string.model_ids_hint'))
        .fontSize(12)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .width('100%')
        .margin({ top: 4 })

      // 重置模型列表：把 `models` 恢复成供应商的默认集（服务端行为，本地不拼）。
      // 走 `PATCH {"models": null}`（unset 覆盖、回落继承），按 provider-settings-v1 探测。
      if (this.providerWritable) {
        Button($r('app.string.reset_models'))
          .width('100%')
          .height(44)
          .borderRadius(22)
          .backgroundColor($r('sys.color.ohos_id_color_sub_background'))
          .fontColor($r('sys.color.ohos_id_color_text_primary'))
          .margin({ top: 18 })
          .enabled(!this.busy)
          .onClick((): void => {
            this.onResetModels(this.provider.id);
          })
        Text($r('app.string.reset_models_hint'))
          .fontSize(12)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .width('100%')
          .margin({ top: 4 })
      }

      Button($r('app.string.save_provider'))
        .width('100%')
        .height(52)
        .borderRadius(26)
        .margin({ top: 18 })
        .enabled(!this.busy)
        .onClick((): void => {
          this.submit();
        })

      // 仅自定义供应商（removable）可删，且需 provider-settings-v1 支持（DELETE 端点）。
      if (this.provider.removable && this.providerWritable) {
        Button($r('app.string.delete_provider'))
          .width('100%')
          .height(44)
          .borderRadius(22)
          .backgroundColor(Color.Transparent)
          .fontColor($r('sys.color.ohos_id_color_warning'))
          .margin({ top: 10 })
          .enabled(!this.busy)
          .onClick((): void => {
            this.onDelete(this.provider.id);
          })
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}

/**
 * 新建自定义供应商（源工程 `CustomProviderEditor`）。
 *
 * 与编辑器分开成一个组件：字段集不同（多了 ID、少了「发现模型」，协议是**选项**而不是自由文本），
 * 而且这里要自己判「能不能按创建」——四条同时成立：ID 形态合法、地址非空、协议非空、至少一个模型。
 */
@Component
struct CustomProviderEditor {
  capability: CustomProviderCapability = new CustomProviderCapability();
  busy: boolean = false;
  onClose: () => void = (): void => {};
  onSubmit: (create: CustomProviderCreate) => void = (): void => {};

  @State newId: string = '';
  @State newName: string = '';
  @State newBaseUrl: string = '';
  @State newProtocol: string = '';
  @State newApiKey: string = '';
  @State newModels: string = '';

  aboutToAppear(): void {
    // 默认协议取服务器给的第一项，与源工程 `capability.protocols.firstOrNull()` 一致。
    this.newProtocol = this.capability.protocols.length === 0 ? '' : this.capability.protocols[0];
  }

  /** ID 形态合法（源工程用同样的正则）。空值不算「错」，所以只在非空时才画警告色。 */
  private idValid(): boolean {
    return new RegExp(PROVIDER_ID_PATTERN).test(this.newId);
  }

  private parsedModels(): ProviderModel[] {
    return parseModelIds(this.newModels);
  }

  private ready(): boolean {
    return this.idValid() && this.newBaseUrl.trim().length > 0
      && this.newProtocol.trim().length > 0 && this.parsedModels().length > 0;
  }

  private protocolItems(): MenuElement[] {
    const out: MenuElement[] = [];
    for (let i = 0; i < this.capability.protocols.length; i++) {
      const choice: string = this.capability.protocols[i];
      out.push({
        value: choice,
        action: (): void => {
          this.newProtocol = choice;
        },
      });
    }
    return out;
  }

  private protocolLabel(): ResourceStr {
    return this.newProtocol.trim().length > 0 ? this.newProtocol : $r('app.string.provider_protocol');
  }

  private submit(): void {
    const create: CustomProviderCreate = new CustomProviderCreate();
    create.id = this.newId;
    create.displayName = this.newName.trim().length === 0 ? null : this.newName.trim();
    create.baseURL = this.newBaseUrl.trim();
    create.api = this.newProtocol;
    create.apiKey = this.newApiKey.trim().length === 0 ? null : this.newApiKey.trim();
    create.models = this.parsedModels();
    create.expectedRevision = this.capability.revision;
    this.onSubmit(create);
    this.onClose();
  }

  @Builder
  label(text: ResourceStr) {
    fieldLabel(text)
  }

  build() {
    Column() {
      Text($r('app.string.add_custom_provider'))
        .fontSize(20)
        .fontWeight(FontWeight.Medium)
        .width('100%')
      Text($r('app.string.custom_provider_subtitle'))
        .fontSize(12)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .width('100%')
        .margin({ top: 2 })

      Column().height(13)

      this.label($r('app.string.provider_id'))
      TextInput({ text: this.newId })
        .width('100%')
        .border(this.newId.length > 0 && !this.idValid()
          ? { width: 1, color: $r('sys.color.ohos_id_color_warning') }
          : { width: 1, color: $r('sys.color.ohos_id_color_component_normal') })
        .onChange((value: string): void => {
          // 源工程在输入时就 `trim().lowercase()`：ID 会被写进服务器路由，大写与非 ASCII 一律不接受，
          // 与其等到提交时报错，不如边打边规范。
          this.newId = value.trim().toLowerCase();
        })
      Text($r('app.string.provider_id_hint'))
        .fontSize(12)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .width('100%')
        .margin({ top: 4 })

      Column().height(13)

      this.label($r('app.string.provider_display_name'))
      TextInput({ text: this.newName })
        .width('100%')
        .onChange((value: string): void => {
          this.newName = value;
        })

      Column().height(13)

      this.label($r('app.string.base_url'))
      TextInput({ text: this.newBaseUrl })
        .type(InputType.URL)
        .width('100%')
        .onChange((value: string): void => {
          this.newBaseUrl = value;
        })

      Column().height(13)

      // 协议是「从服务器给的候选里挑一个」，不是自由文本 —— 所以这里画一个带菜单的按钮，
      // 而不是输入框：写一个服务器不认的协议名，创建必然失败。
      Row() {
        Text(this.protocolLabel())
          .fontSize(15)
          .layoutWeight(1)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text('›')
          .fontSize(17)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 12, bottom: 12 })
      .borderRadius(6)
      .border({ width: 1, color: $r('sys.color.ohos_id_color_component_normal') })
      .alignItems(VerticalAlign.Center)
      .bindMenu(this.protocolItems())

      Column().height(13)

      this.label($r('app.string.api_key_optional'))
      TextInput({ text: this.newApiKey })
        .type(InputType.Password)
        .width('100%')
        .onChange((value: string): void => {
          this.newApiKey = value;
        })

      Column().height(13)

      this.label($r('app.string.model_ids'))
      TextArea({ text: this.newModels })
        .width('100%')
        .height(MODEL_IDS_HEIGHT)
        .onChange((value: string): void => {
          this.newModels = value;
        })
      Text($r('app.string.model_ids_required_hint'))
        .fontSize(12)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .width('100%')
        .margin({ top: 4 })

      Button($r('app.string.create_provider'))
        .width('100%')
        .height(52)
        .borderRadius(26)
        .margin({ top: 18 })
        .enabled(this.ready() && !this.busy)
        .onClick((): void => {
          this.submit();
        })
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}

/** 模型分节的宿主：按权限/加载状态三态分派，并挂着编辑与新建两个面板。 */
@Component
export struct ModelsScreen {
  @StorageLink('dshRevision') revision: number = 0;

  /**
   * 正在编辑的供应商。
   *
   * 拿的是**列表里那个对象的引用**（源工程 `editedProvider = provider` 同款）：
   * 面板存活的这段时间里，表单值就是它的当前配置；保存或关闭时面板连同这份引用一起丢掉。
   * 保存成功后服务器会整块替换 `providerSettings`（新的对象），那时面板已经关了，
   * 不存在「面板还指着旧对象」的问题。
   */
  @State editedProvider: ProviderView | null = null;
  @State sheetOpen: boolean = false;
  @State sheetKind: number = SHEET_EDIT_PROVIDER;

  /** vm 还没装配时的兜底状态。 */
  private fallback: HarnessState = new HarnessState();
  /** 清单为 null 时的空对象（避免在 `@Builder` 里对可空取值做窄化，见 PORT-MAP §1b 坑 8）。 */
  private emptySettings: ProviderSettings = new ProviderSettings();

  private st(): HarnessState {
    // 读一次 revision：ArkUI 只把 **build 期间读过**的状态登记为依赖
    // （编译器把 build 体包在 `StartGetAccessRecordingFor` … `StopGetAccessRecording` 之间），
    // 只声明 `@StorageLink` 而不读它，vm 更新时这个组件不会重绘。见 PORT-MAP §1b 坑 12。
    // 恒真的比较：存在的意义就是让这次读取发生。
    const rev: number = this.revision;
    return rev >= 0 ? (harnessState() ?? this.fallback) : this.fallback;
  }

  private vm(): HarnessViewModel | null {
    return harnessVm();
  }

  private scopes(): string[] {
    const device = this.st().device;
    return device === null ? [] : device.scopes;
  }

  private canRead(): boolean {
    return this.scopes().includes('settings.read');
  }

  private canWrite(): boolean {
    return this.scopes().includes('settings.write');
  }

  /**
   * 服务端是否支持供应商写操作（`provider-settings-v1`，bridge 2.5.2 真实声明）。
   * 不支持时「重置模型列表 / 删除此供应商」入口隐藏 —— 老 bridge 上会 404。
   */
  private providerWritable(): boolean {
    return supportsProviderSettings(this.st().bridgeCapabilities);
  }

  /** 服务端是否支持模型目录（`model-catalog-v1`），不支持时「发现模型」入口隐藏。 */
  private modelCatalogSupported(): boolean {
    return supportsModelCatalog(this.st().bridgeCapabilities);
  }

  private hasSettings(): boolean {
    return this.st().providerSettings !== null;
  }

  private settings(): ProviderSettings {
    return this.st().providerSettings ?? this.emptySettings;
  }

  private busy(): boolean {
    return this.st().busy;
  }

  /** 「添加自定义供应商」整行只在宿主支持时渲染（源工程同款判据）。 */
  private customAvailable(): boolean {
    return this.settings().customProvider.available;
  }

  private addEnabled(): boolean {
    return this.canWrite() && this.settings().writable && !this.busy();
  }

  /** 某一行的 `canEdit`（判据 2）。 */
  private rowEditable(provider: ProviderView): boolean {
    return this.canWrite() && this.settings().writable && provider.configurable;
  }

  private openEditor(provider: ProviderView): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm === null) {
      return;
    }
    // 判据 3：切换供应商之前先清掉上一次的发现结果。
    vm.clearDiscoveredModels();
    this.editedProvider = provider;
    this.sheetKind = SHEET_EDIT_PROVIDER;
    this.sheetOpen = true;
  }

  private openCreate(): void {
    this.sheetKind = SHEET_CREATE_PROVIDER;
    this.sheetOpen = true;
  }

  private closeSheet(): void {
    this.sheetOpen = false;
    this.editedProvider = null;
  }

  private submitPatch(providerId: string, patch: ProviderPatch): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      void vm.updateProvider(providerId, patch);
    }
  }

  private submitCreate(create: CustomProviderCreate): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm !== null) {
      void vm.createCustomProvider(create);
    }
  }

  private discover(providerId: string, baseURL: string, protocol: string, apiKey: string): void {
    const vm: HarnessViewModel | null = this.vm();
    if (vm === null) {
      return;
    }
    const url: string | null = baseURL.trim().length === 0 ? null : baseURL.trim();
    const api: string | null = protocol.trim().length === 0 ? null : protocol.trim();
    const key: string | null = apiKey.trim().length === 0 ? null : apiKey.trim();
    void vm.discoverModels(providerId, url, api, key);
  }

  /** 新建面板要用当次快照里的 `capability`（含 `protocols` 与 `revision`）。 */
  private capability(): CustomProviderCapability {
    return this.settings().customProvider;
  }

  build() {
    Scroll() {
      Column() {
        Column() {
          Text($r('app.string.model_providers'))
            .fontSize(24)
            .fontWeight(FontWeight.Medium)
            .width('100%')
          Text($r('app.string.models_subtitle'))
            .fontSize(13)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .margin({ top: 4, bottom: 26 })
            .width('100%')

          // 大标题已经用了 `model_providers`，这里不再重复同名小标题 ——
          // 只保留右侧的「添加自定义供应商」，且宿主不支持时整行不渲染。
          if (this.customAvailable()) {
            Row() {
              Row() {
                Text('+').fontSize(15)
                Text($r('app.string.add_custom_provider'))
                  .fontSize(13)
                  .margin({ left: 5 })
              }
              .padding({ left: 10, right: 10, top: 6, bottom: 6 })
              .alignItems(VerticalAlign.Center)
              .opacity(this.addEnabled() ? 1 : 0.4)
              .enabled(this.addEnabled())
              .onClick((): void => {
                this.openCreate();
              })
            }
            .width('100%')
            .justifyContent(FlexAlign.End)
          }

          this.providerSection()
        }
        .width('100%')
        .constraintSize({ maxWidth: CONTENT_MAX_WIDTH })
      }
      .width('100%')
      .padding({ left: 20, right: 20, top: 28, bottom: 28 })
      .alignItems(HorizontalAlign.Center)
    }
    .width('100%')
    .height('100%')
    .align(Alignment.TopStart)
    .bindSheet(this.sheetOpen, this.sheetContent(), {
      height: SheetSize.LARGE,
      dragBar: true,
      onDisappear: (): void => {
        this.closeSheet();
      },
    })
  }

  /** 三态分派（源工程 `when {}` 的顺序一字不改）。 */
  @Builder
  providerSection() {
    if (!this.canRead()) {
      WarningBanner({ message: $r('app.string.settings_permission_required') })
    } else if (!this.hasSettings()) {
      Row() {
        LoadingProgress().width(26).height(26)
      }
      .width('100%')
      .height(92)
      .justifyContent(FlexAlign.Center)
      .alignItems(VerticalAlign.Center)
    } else {
      Column() {
        ForEach(this.settings().providers, (provider: ProviderView, index: number) => {
          if (index > 0) {
            Divider().color($r('sys.color.ohos_id_color_list_separator'))
          }
          ProviderRow({
            provider: provider,
            canEdit: this.rowEditable(provider),
            onOpen: (target: ProviderView): void => {
              this.openEditor(target);
            },
          })
        }, (provider: ProviderView, index: number): string =>
          `${index}:${provider.id}:${provider.active}:${provider.configurable}:${provider.configured === true}`)

        // 判据 4：这句必须显示，否则「凭据已配置」会被误当成可以点开看密钥。
        Text($r('app.string.provider_secret_note'))
          .fontSize(12)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .width('100%')
          .margin({ top: 10 })
      }
      .width('100%')
      .alignItems(HorizontalAlign.Start)
    }
  }

  @Builder
  sheetContent() {
    Column() {
      if (this.sheetKind === SHEET_CREATE_PROVIDER) {
        CustomProviderEditor({
          capability: this.capability(),
          busy: this.busy(),
          onClose: (): void => {
            this.closeSheet();
          },
          onSubmit: (create: CustomProviderCreate): void => {
            this.submitCreate(create);
          },
        })
      } else if (this.editedProvider !== null) {
        ProviderEditor({
          provider: this.editedProvider as ProviderView,
          discovered: this.st().discoveredModels,
          busy: this.busy(),
          onClose: (): void => {
            this.closeSheet();
          },
          onSubmit: (providerId: string, patch: ProviderPatch): void => {
            this.submitPatch(providerId, patch);
          },
          onDiscover: (providerId: string, baseURL: string, protocol: string, apiKey: string): void => {
            this.discover(providerId, baseURL, protocol, apiKey);
          },
          onResetModels: (providerId: string): void => {
            const vm: HarnessViewModel | null = this.vm();
            if (vm !== null) {
              void vm.resetProviderModels(providerId);
            }
          },
          onDelete: (providerId: string): void => {
            const vm: HarnessViewModel | null = this.vm();
            if (vm !== null) {
              void vm.deleteProvider(providerId);
              this.closeSheet();
            }
          },
          providerWritable: this.providerWritable(),
          modelCatalog: this.modelCatalogSupported(),
        })
      }
    }
    .width('100%')
    .padding({ left: 22, right: 22, bottom: 30 })
    .alignItems(HorizontalAlign.Start)
  }
}
