/**
 * 设置页的可复用组件 —— 从 `SettingsScreen.ets` 拆出，控制单文件行数。
 *
 * 包含：
 * - `SettingRow` / `SwitchRow` / `ChoicePill`：基础行组件（原住在 SettingsScreen）
 * - `AppearanceGroup`：外观组（字号 / 主题 / 配色）
 * - `SettingsSchemaGroup`：bridge ≥ 2.6.0 的 schema 驱动动态设置
 *
 * ## 状态传参
 *
 * - 下行数据（标题、选中态等）用 `@Prop`；
 * - 回调用普通函数成员（`@Prop` 不允许函数类型）。
 */

import { HarnessState, HarnessViewModel } from '../core/HarnessViewModel';
import {
  SettingsFieldDef, SettingsFieldType, SettingsSchema, buildSettingsOps, settingsSchemaIsDirty,
} from '../core/SettingsSchema';
import {
  FONT_SCALE_MAX, FONT_SCALE_MIN, FONT_SCALE_STEP,
  effectiveFontScale, formatFontScale, normalizeFontScale,
} from '../core/FontScale';
import { THEME_MODE_DARK, THEME_MODE_LIGHT, THEME_MODE_SYSTEM } from '../core/ThemeMode';
import {
  THEME_PALETTE_INK, THEME_PALETTE_MIST, THEME_PALETTE_PAPER, THEME_PALETTE_WARM,
  getPalette,
} from '../core/ThemePalettes';
import { common, ConfigurationConstant } from '@kit.AbilityKit';

/** 小节标题（源工程 `SettingsHeading`）。 */
@Builder
export function SettingsHeading(title: ResourceStr) {
  Text(title)
    .fontSize(13)
    .fontColor($r('sys.color.ohos_id_color_text_secondary'))
    .width('100%')
    .margin({ bottom: 8 })
}

/**
 * 一行「图标 + 标题 + 副标题 +（可选）尾部内容」。
 *
 * `trailing` 是 `@BuilderParam`：调用方用尾随 lambda 决定尾部画什么。
 */
@Component
export struct SettingRow {
  glyph: string = '';
  @Prop title: ResourceStr = '';
  @Prop subtitle: string = '';
  @BuilderParam trailing: () => void = this.noTrailing;
  onTap: () => void = (): void => {};

  @Builder
  noTrailing() {
  }

  build() {
    Row() {
      Text(this.glyph)
        .fontSize(19)
        .width(26)
        .textAlign(TextAlign.Center)
        .margin({ right: 10 })
      Column() {
        Text(this.title)
          .fontSize(15)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
        if (this.subtitle.length > 0) {
          Text(this.subtitle)
            .fontSize(12)
            .fontColor($r('sys.color.ohos_id_color_text_secondary'))
            .maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .width('100%')
        }
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      this.trailing()
    }
    .width('100%')
    .padding({ top: 12, bottom: 12 })
    .alignItems(VerticalAlign.Center)
    .onClick((): void => {
      this.onTap();
    })
  }
}

/** 一行「标题 + 说明 + 开关」。 */
@Component
export struct SwitchRow {
  @Prop title: ResourceStr = '';
  @Prop description: ResourceStr = '';
  @Prop checked: boolean = false;
  onCheckedChange: (value: boolean) => void = (): void => {};

  build() {
    Row() {
      Column() {
        Text(this.title)
          .fontSize(15)
          .width('100%')
        Text(this.description)
          .fontSize(12)
          .fontColor($r('sys.color.ohos_id_color_text_secondary'))
          .width('100%')
      }
      .layoutWeight(1)
      .alignItems(HorizontalAlign.Start)

      Toggle({ type: ToggleType.Switch, isOn: this.checked })
        .onChange((isOn: boolean): void => {
          this.onCheckedChange(isOn);
        })
    }
    .width('100%')
    .padding({ top: 6, bottom: 6 })
    .alignItems(VerticalAlign.Center)
  }
}

/** 一个药丸选项：选中项强调色填充 + 白字，未选中项透明底 + 描边。 */
@Component
export struct ChoicePill {
  label: ResourceStr = '';
  @Prop selected: boolean = false;
  onTap: () => void = (): void => {};
  /** 可选色样（hex，如 '#FFF5E8F0'）：配色药丸用它一眼展示这套主题长什么样。 */
  swatch: string = '';

  build() {
    Row() {
      if (this.swatch.length > 0) {
        Column()
          .width(10)
          .height(10)
          .borderRadius(5)
          .backgroundColor(this.swatch)
          .border({ width: 0.5, color: $r('sys.color.ohos_id_color_text_secondary') })
          .margin({ right: 6 })
      }
      Text(this.label)
        .fontSize(13)
        .fontColor(this.selected
          ? $r('sys.color.ohos_id_color_foreground_contrary')
          : $r('sys.color.ohos_id_color_text_primary'))
    }
    .justifyContent(FlexAlign.Center)
    .alignItems(VerticalAlign.Center)
    .layoutWeight(1)
    .padding({ top: 9, bottom: 9 })
    .backgroundColor(this.selected
      ? $r('sys.color.ohos_id_color_emphasize')
      : Color.Transparent)
    .borderRadius(20)
    .border({
      width: 1,
      color: this.selected ? $r('sys.color.ohos_id_color_emphasize') : $r('sys.color.ohos_id_color_component_normal'),
    })
    .margin({ right: 8 })
    .onClick((): void => {
      this.onTap();
    })
  }
}

// ——— 外观组 ———

/**
 * 外观组：字号跟随系统开关 + 步进器 + 主题三档 + 配色四档。
 *
 * 从 `SettingsScreen` 拆出，所有动态值与回调显式传入。
 */
@Component
export struct AppearanceGroup {
  @Prop fontFollowsSystem: boolean = false;
  @Prop fontScale: number = 1.0;
  @Prop themeMode: string = '';
  @Prop paletteName: string = '';
  onFontFollowsSystemChange: (value: boolean) => void = (): void => {};
  onStepFontScale: (delta: number) => void = (): void => {};
  onSetThemeMode: (mode: string) => void = (): void => {};
  onSetPaletteName: (name: string) => void = (): void => {};

  private atScaleBound(delta: number): boolean {
    const next: number = normalizeFontScale(this.fontScale + delta * FONT_SCALE_STEP);
    return next === this.fontScale;
  }

  private scaleText(): string {
    return `${formatFontScale(effectiveFontScale(this.fontScale, this.fontFollowsSystem))}×`;
  }

  /** 开关下方的说明：跟随系统时换一句，否则报当前倍数（随状态现算，不能是静态值）。 */
  private fontScaleDesc(): ResourceStr {
    if (this.fontFollowsSystem) {
      return $r('app.string.font_scale_follows_desc');
    }
    return $r('app.string.font_scale_desc', this.scaleText());
  }

  /** 当前是否深色阶 —— 配色药丸的色样要按当前色阶取。 */
  private isDarkMode(): boolean {
    const context: common.Context | undefined = this.getUIContext().getHostContext();
    if (context === undefined) {
      return false;
    }
    // COLOR_MODE_DARK = 0，别按直觉记反（PORT-MAP 坑 20）。
    return (context as common.UIAbilityContext).config.colorMode
      === ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
  }

  /** 某套配色在当前色阶下的导航栏底色 —— 给药丸上的色样点用。 */
  private paletteSwatch(name: string): string {
    return getPalette(name, this.isDarkMode()).navBarBg;
  }

  build() {
    Column() {
      SettingsHeading($r('app.string.appearance'))
      SwitchRow({
        title: $r('app.string.font_scale_follows_title'),
        description: this.fontScaleDesc(),
        checked: this.fontFollowsSystem,
        onCheckedChange: (value: boolean): void => {
          this.onFontFollowsSystemChange(value);
        },
      })
      // 字号步进器
      Row() {
        Text('−')
          .fontSize(18)
          .textAlign(TextAlign.Center)
          .width(38)
          .height(34)
          .borderRadius(8)
          .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
          .fontColor(this.atScaleBound(-1)
            ? $r('sys.color.ohos_id_color_text_secondary')
            : $r('sys.color.ohos_id_color_text_primary'))
          .enabled(!this.atScaleBound(-1))
          .onClick((): void => {
            this.onStepFontScale(-1);
          })
        Text(this.scaleText())
          .fontSize(15)
          .fontWeight(FontWeight.Medium)
          .textAlign(TextAlign.Center)
          .layoutWeight(1)
        Text('＋')
          .fontSize(18)
          .textAlign(TextAlign.Center)
          .width(38)
          .height(34)
          .borderRadius(8)
          .backgroundColor($r('sys.color.ohos_id_color_component_normal'))
          .fontColor(this.atScaleBound(1)
            ? $r('sys.color.ohos_id_color_text_secondary')
            : $r('sys.color.ohos_id_color_text_primary'))
          .enabled(!this.atScaleBound(1))
          .onClick((): void => {
            this.onStepFontScale(1);
          })
      }
      .width('100%')
      .margin({ top: 8 })
      Text($r('app.string.font_scale_footnote'))
        .fontSize(12)
        .fontColor($r('sys.color.ohos_id_color_text_secondary'))
        .margin({ top: 4, bottom: 20 })
        .width('100%')

      SettingRow({
        glyph: '🌓',
        title: $r('app.string.theme_title'),
        subtitle: '跟随系统 / 浅色 / 深色',
      })
      Row() {
        ChoicePill({
          label: $r('app.string.theme_system'),
          selected: this.themeMode === THEME_MODE_SYSTEM,
          onTap: (): void => { this.onSetThemeMode(THEME_MODE_SYSTEM); },
        })
        ChoicePill({
          label: $r('app.string.theme_light'),
          selected: this.themeMode === THEME_MODE_LIGHT,
          onTap: (): void => { this.onSetThemeMode(THEME_MODE_LIGHT); },
        })
        ChoicePill({
          label: $r('app.string.theme_dark'),
          selected: this.themeMode === THEME_MODE_DARK,
          onTap: (): void => { this.onSetThemeMode(THEME_MODE_DARK); },
        })
      }
      .width('100%')

      SettingRow({
        glyph: '🎨',
        title: $r('app.string.palette_title'),
        subtitle: '纸白 / 暖米 / 青灰 / 墨黑 · 作用于页面背景与系统导航栏',
      })
      Row() {
        ChoicePill({
          label: $r('app.string.palette_paper'),
          selected: this.paletteName === THEME_PALETTE_PAPER,
          swatch: this.paletteSwatch(THEME_PALETTE_PAPER),
          onTap: (): void => { this.onSetPaletteName(THEME_PALETTE_PAPER); },
        })
        ChoicePill({
          label: $r('app.string.palette_warm'),
          selected: this.paletteName === THEME_PALETTE_WARM,
          swatch: this.paletteSwatch(THEME_PALETTE_WARM),
          onTap: (): void => { this.onSetPaletteName(THEME_PALETTE_WARM); },
        })
        ChoicePill({
          label: $r('app.string.palette_mist'),
          selected: this.paletteName === THEME_PALETTE_MIST,
          swatch: this.paletteSwatch(THEME_PALETTE_MIST),
          onTap: (): void => { this.onSetPaletteName(THEME_PALETTE_MIST); },
        })
        ChoicePill({
          label: $r('app.string.palette_ink'),
          selected: this.paletteName === THEME_PALETTE_INK,
          swatch: this.paletteSwatch(THEME_PALETTE_INK),
          onTap: (): void => { this.onSetPaletteName(THEME_PALETTE_INK); },
        })
      }
      .width('100%')
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}

// ——— schema 驱动的动态设置组 ———

/**
 * schema 驱动的动态设置组（bridge ≥ 2.6.0）。
 *
 * 按 `SettingsSchema.fields` 的类型渲染控件：
 * - boolean → 开关
 * - enum → 药丸单选
 * - number → 步进器
 * - string → 输入框
 * - json → 文本域（只读显示）
 *
 * 密钥位（readOnly / isSecret）只读且永不进 PATCH ops。
 */
@Component
export struct SettingsSchemaGroup {
  @Prop schema: SettingsSchema | null = null;
  onSave: (draft: Map<string, Object>) => void = (): void => {};

  /** 草稿：field key → 新值。未触碰的字段不在草稿里。 */
  @State draft: Record<string, Object> = {};
  @State saving: boolean = false;

  private isDirty(): boolean {
    if (this.schema === null) {
      return false;
    }
    return settingsSchemaIsDirty(this.schema, this.buildDraftMap());
  }

  private buildDraftMap(): Map<string, Object> {
    const m: Map<string, Object> = new Map();
    const keys: string[] = Object.keys(this.draft);
    for (let i: number = 0; i < keys.length; i++) {
      m.set(keys[i], this.draft[keys[i]]);
    }
    return m;
  }

  /** schema 为 null 时给空数组 —— 避免 build 里对可空值做窄化（同 `PluginsScreen` 的 `inv()`）。 */
  private fields(): SettingsFieldDef[] {
    const schema: SettingsSchema | null = this.schema;
    return schema === null ? [] : schema.fields;
  }

  private fieldValue(key: string): Object | null {
    const schema: SettingsSchema | null = this.schema;
    if (schema === null) {
      return null;
    }
    const keys: string[] = Object.keys(this.draft);
    if (keys.indexOf(key) >= 0) {
      return this.draft[key];
    }
    return schema.get(key);
  }

  private valueText(key: string): string {
    const value: Object | null = this.fieldValue(key);
    return value === null ? '' : String(value);
  }

  private setDraft(key: string, value: Object): void {
    // ArkUI @State 只认整体赋值，逐 key 改不触发重绘。
    const next: Record<string, Object> = {};
    const oldKeys: string[] = Object.keys(this.draft);
    for (let i: number = 0; i < oldKeys.length; i++) {
      next[oldKeys[i]] = this.draft[oldKeys[i]];
    }
    next[key] = value;
    this.draft = next;
  }

  build() {
    Column() {
      // schema 为 null（老 bridge 无此端点）时 fields() 为空数组，整块不画 —— 视觉零变化。
      if (this.fields().length > 0) {
        SettingsHeading($r('app.string.server_settings'))
        ForEach(this.fields(), (field: SettingsFieldDef) => {
          Column() {
            Text(field.label)
              .fontSize(15)
              .width('100%')
            if (field.readOnly || field.isSecret) {
              // 只读 / 密钥位：只显示占位，不渲染可编辑控件（也永不进 ops）。
              Text(this.valueText(field.key).length > 0 ? '••••••' : '')
                .fontSize(12)
                .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                .width('100%')
            } else if (field.type === SettingsFieldType.BOOLEAN) {
              Toggle({ type: ToggleType.Switch, isOn: this.fieldValue(field.key) === true })
                .onChange((isOn: boolean): void => {
                  this.setDraft(field.key, isOn);
                })
            } else if (field.type === SettingsFieldType.ENUM) {
              Flex({ wrap: FlexWrap.Wrap }) {
                ForEach(field.options, (opt: string) => {
                  ChoicePill({
                    label: opt,
                    selected: this.valueText(field.key) === opt,
                    onTap: (): void => {
                      this.setDraft(field.key, opt);
                    },
                  })
                }, (opt: string): string => opt)
              }
              .width('100%')
            } else if (field.type === SettingsFieldType.NUMBER) {
              TextInput({ text: this.valueText(field.key) })
                .type(InputType.Number)
                .onChange((val: string): void => {
                  const n: number = Number(val);
                  if (!isNaN(n)) {
                    this.setDraft(field.key, n);
                  }
                })
            } else if (field.type === SettingsFieldType.JSON) {
              Text(JSON.stringify(this.fieldValue(field.key) ?? {}))
                .fontSize(12)
                .fontColor($r('sys.color.ohos_id_color_text_secondary'))
                .width('100%')
            } else {
              TextInput({ text: this.valueText(field.key) })
                .onChange((val: string): void => {
                  this.setDraft(field.key, val);
                })
            }
          }
          .width('100%')
          .padding({ top: 8, bottom: 8 })
        }, (field: SettingsFieldDef): string => field.key)

        if (this.isDirty()) {
          Button(this.saving ? $r('app.string.saving') : $r('app.string.save'))
            .type(ButtonType.Capsule)
            .width('100%')
            .height(44)
            .margin({ top: 12 })
            .enabled(!this.saving)
            .onClick((): void => {
              this.saving = true;
              this.onSave(this.buildDraftMap());
              this.saving = false;
            })
        }
      }
    }
    .width('100%')
    .alignItems(HorizontalAlign.Start)
  }
}
