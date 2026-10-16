# 当前状态

- **日期**：2026-10-16
- **阶段**：**1.0.2 已打包**，待上传 AGC（1.0.0 送审被驳回；1.0.1 因改名而作废，未上传）
- **版本**：1.0.2 / `versionCode` 1000002
- **bundleName**：`com.dsh.westanke`
  > 2026-10-16 换掉：旧的 `com.Deepseek_Harness_client.westanke` 因**含 DeepSeek 字样**被判「与
  > DeepSeek 应用名称相似、无商标权属证明」。拿不到授权，只能在 AGC **重建应用**并改
  > bundleName。bundleName 一变，**调试 / 发布 Profile 与证书必须重新签发**（见 `signing/README.txt`）。
- **应用名**：包内 `app_name` = 「DSH 伴侣」（中文）/ 「DSH Companion」（英文）；
  连接页标题去品牌化为「连接服务端」。**应用信息、应用介绍中不得再出现第三方品牌名**。
- **仓库**：[GitHub](https://github.com/westanke/dsh-companion-harmony)（`origin`，主）·
  [Gitee](https://gitee.com/westanke/dsh-companion-harmony)（`gitee`，镜像）·
  [AtomGit](https://atomgit.com/westanke/dsh-companion-harmony)（`atomgit`，镜像；**仓库待创建**）。
  因本机到 `github.com:443` 不稳，新增 `.github/workflows/sync-from-mirrors.yml`
  让镜像**快进回补** GitHub（详见 PORT-MAP 收尾十一）。
- **兼容**：HarmonyOS 6.0 及以上（`compatibleSdkVersion` = 5.1.0(18)）
- **设备类型**：phone / tablet / 2in1
- **插件基线**：`dsh-remote-bridge` **≥ 2.0.4**（旧名 `dsh-workspace`）
- **最近验证**：`531 用例全绿`（`cd test && npm test`）+ `BUILD SUCCESSFUL`
- **真机**：ICL-AL10（API 26，HarmonyOS 7.0）已装 1.0.2 调试签名包，
  `bm dump` 实测 `versionCode = 1000002`；改名后界面（标题「DSH 伴侣」）、
  连接页「连接服务端」、助手消息底部「内容由 AI 生成」标识**均已真机确认**。
- **发布产物**（2026-10-16 出 **1.0.2**，含改名去品牌 + 换 bundleName + AI 生成内容显式标识；
  内外层均 `verify-app` → `Verify success`）：

  | 产物 | 说明 |
  |---|---|
  | `dsh-companion-harmony-1.0.2-release-signed.app` | 里外双签，**上架 AGC 用** |
  | `dsh-companion-harmony-1.0.2-release-signed.hap` | 发布证书签的内部 hap（`.app` 内层） |
  | `dsh-companion-harmony-1.0.2-release-debugsigned.hap` | 调试签名，**装真机用** |
  | `dsh-companion-harmony-1.0.2-demo-walkthrough.mp4` | 遍历使用的演示录屏，**AGC「自测文件」用** |

  > 前两者与真机包**代码完全相同**，只差签名来源；发布证书签的 hap 无法 `hdc install`
  > （设备只信任调试证书）。
  > **`1.0.0` / `1.0.1` 的包全部作废**：1.0.0 图标为 216×216 单层图；1.0.1 仍带旧 bundleName
  > 与 DeepSeek 品牌名，且 Profile 已随旧应用失效。
- **产物校验**（2026-10-16，`stat` / `sha256sum` 实测回填）：

  | 产物 | 字节 | SHA-256 |
  |---|---|---|
  | `…-1.0.2-release-signed.app` | 443 616 | `1b20c68ecd4068fa297b19babff2a91ce2d2997b3f27c9325337f208c70f8494` |
  | `…-1.0.2-release-signed.hap` | 1 281 651 | `60bf528184c3cca713239fec0271012202533803bd17364949e93ef1bff9ceb6` |
  | `…-1.0.2-release-debugsigned.hap` | 1 281 739 | `87e5dcd211724ace6d517ccb37a0b4caec463472184e14cf86054de81606b9f5` |
  | `…-1.0.2-demo-walkthrough.mp4` | 7 834 275 | `05abc796cfdd963c82bb5bc16bd7e88624190f426fd4f08c22ca508d1f740954` |
- **应用图标**：**分层资源**（前景透明 PNG + 背景纯色、背景不含透明像素），两层均 1024×1024 正方形、
  无圆角、无内间距；`AppScope/app_layered_image.json`（`app_foreground` / `app_background`）与
  `entry/layered_image.json`（`foreground` / `background`）刻意用**不同资源名**避免同名覆盖；
  `startWindowIcon` 仍为独立单层图 `startIcon`。真机桌面渲染正常。
- **权限**：仅 `ohos.permission.INTERNET` + `GET_NETWORK_INFO`（`READ_PASTEBOARD` 已移除）
- **上架材料**（`docs/screenshots/`）：
  - 应用介绍截图 6 张（1080×1920，9:16）：`01-sessions` / `02-chat` / `03-files` /
    `04-plugins` / `05-models` / `06-settings`，**全部为 1.0.2 真机重拍**（旧 6 张已删：
    其中 `01-connect.png` 带旧品牌标题）
  - `ai-generated-label-evidence.png`（1080×2440 原图，**AI 生成内容显式标识证据**）
  - 演示录屏见上表第 4 项
- **阻塞项**：**无代码阻塞**。AGC 侧待办（非代码）：
  ①「分发 > 版本信息 > **AI 功能声明**」改正为「涉及 AI 生成合成服务」；
  ②「应用审核信息 > **自测文件**」上传演示录屏；
  ③「应用截图」换成 1.0.2 新图；
  ④ 实名认证口径：本应用**自身不运营生成服务**（生成发生在用户自建服务端），
     走申诉说明还是补手机号认证，**待用户拍板**。
- **本轮改动**：①**改名去 DeepSeek** + 换 bundleName + 全部签名材料重签（详见 PORT-MAP 坑 26）；
  ②助手消息底部新增「内容由 AI 生成」显式标识；
  ③录制遍历演示录屏（连接管理 / 会话浏览 / 交互操作 / 文件查看）；
  ④重拍上架截图 6 张
- **下一步**：上传 `dsh-companion-harmony-1.0.2-release-signed.app` 到 AGC，
  并按上「AGC 侧待办」补材料
