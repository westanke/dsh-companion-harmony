# 设备身份上报：加一行请求头，让桥知道你是谁

> 来自 `dsh-remote-bridge` 的投单需求 · 2026-10-23
> 触发原因：鸿蒙手机在桥的设备表里被登记成「Android 设备」（见文末「背景」）

## 一句话

请在 HTTP 请求头里加一行 `X-Dsh-Device: <platform>/<model>`，桥就会自动把设备名
换成「平台 · 型号」，用户不必再手动改名。

## 桥这边已经做了什么（不需要你做）

- 桥在**认证路径**上顺带解析这个头，落库到 `devices.platform` / `devices.model`，
  并把配对时的占位名（`Mobile device`）自动改成「平台 · 型号」。
- 没有这个头时，桥会从 `User-Agent` 兜底判**平台**（认得 android / harmonyos /
  ios / ipados / web / windows / macos / linux）。
- 用户手工改过的名字永不被覆盖；自动生成的名字在设备上报新身份时仍会更新。
- 桥侧的 `devices/self` 会回传 `platform` / `model` / `nameSource` 三个字段。

## 你需要做的（客户端，约 1 行）

在所有**带鉴权**的请求上加一个头。桥的解析规则：

```
X-Dsh-Device: <platform>/<model>
```

- `platform` 必须是下列之一（大小写不敏感，桥会转小写）：
  `android` `harmonyos` `ios` `ipados` `web` `windows` `macos` `linux`
- `model` 可省。给了就原样保留（含空格），桥只做控制字符清洗与 60 字符截断。
- 不在白名单里的 `platform` 会被**整条丢弃**（自造的平台值会让界面显示一个
  不存在的标签，不如不显示）。

### 安卓侧（Kotlin / OkHttp）—— 精确改动点

文件 `app/src/main/java/io/github/westanke/dshcompanion/data/DshClient.kt`，
方法 `authenticated(builder: Request.Builder)`（当前约 623-631 行）：

```kotlin
private fun authenticated(builder: Request.Builder): Request.Builder =
    builder
        .header("Accept", "application/json")
        .header("Authorization", "Bearer ${requireNotNull(token)}")
        // 新增这一行：桥用它在认证路径上识别设备身份，把配对时的占位名
        // 「Mobile device」换成「Android · Pixel 9」。Build.MODEL 可能含空格，允许。
        .header("X-Dsh-Device", "android/${Build.MODEL}")
        .header("Accept-Language", interfaceLanguageTag())
```

`Build` 来自 `android.os.Build`（通常已 import，未 import 时补一行）。

### 鸿蒙侧（ArkTS）

文件 `entry/src/main/ets/core/DshClient.ts`，方法 `authHeaders()`（当前约 750-762 行）：

```ts
headers.set('X-Dsh-Device', `harmonyos/${deviceInfo.marketName || 'HarmonyOS'}`);
```

`deviceInfo` 来自 `@ohos.deviceInfo`。`marketName` 就是系统设置里显示的机型名
（例如 `ICL-AL10`）。

### 桌面侧（Kotlin / OkHttp，若用同一套客户端）

```kotlin
.header("X-Dsh-Device", "windows/${System.getProperty("os.name") ?: ""}")
// 按 System.getProperty("os.name") 分流 macos / linux
```

## 验收方式

1. 装上新桥（2.6.1 起，含本改动），重启桥。
2. App 连一次，然后在本机 WebUI 的「设备」页看：
   - 设备名变成 `Android · Pixel 9` / `HarmonyOS · ICL-AL10` 这类形式；
   - 名字旁边有「自动识别」徽标；
   - 副标题里能看到平台与型号。
3. 也可以直接打 API 验：

```sh
curl -H "Authorization: Bearer <token>" \
     -H "X-Dsh-Device: harmonyos/ICL-AL10" \
     http://127.0.0.1:3090/api/v1/devices/self
# → {"id":"…","name":"HarmonyOS · ICL-AL10","platform":"harmonyos","model":"ICL-AL10","nameSource":"detected",…}
```

## 兼容性

- **不加上这个头也完全能用**：桥的 UA 兜底仍能认出平台（鸿蒙的 UA 含
  `OpenHarmony` / `ArkWeb`，安卓的含 `Android`），只是拿不到型号。
- 老桥（< 2.6.1）会忽略这个未知头，不会报错。
- 桥的响应新增三个**可选**字段（`platform` / `model` / `nameSource`），
  Kotlin SDK 的 `DeviceView` 已同步为可空默认值，序列化兼容。

## 顺带说明：改名通道

桥新增了 `PATCH /manage/devices/{id}` 只改名（body `{"name":"…"}`）。这是本机
WebUI 的管理面接口，**不需要客户端实现**；提一下是因为它解释了「用户改过的名字
为什么不会被自动覆盖」：改名会把 `name_source` 置为 `declared`。

## 背景（为什么会有这个需求）

用户 2026-10-23 从鸿蒙侧反馈：手机在桥的设备表里显示成「Android 设备」，而且
表里躺着 8 条一模一样的「Android 设备」，谁也认不出谁。

根因不在 app —— app 内「输配对码」流程会上送真实机型名
（`deviceInfo.marketName`，兜底 `'HarmonyOS'`），那条路没问题。问题在桥的
**配置文本路径**：生成 `DSH1:` 文本时 `deviceName` 缺省落硬编码 `'Android 设备'`，
并立即登记入库。那时桥对「将来谁来用这个令牌」一无所知 —— 这是时序问题，不是
参数问题。所以桥改成「先有连接，再有身份」：配对时给平台无关的占位名，设备
第一次连上来时再识别。

桥侧改动已本地提交（`2c5893b`），未发版未部署。
