# 当前状态

- **日期**：2026-10-20
- **阶段**：**1.0.3 已出包**（里外双签 + 真机调试包，均 `verify-app` 通过），**待上传 AGC**；
  2026-10-20 收到 AGC 对上架包（**1.0.2**）的稳定性驳回：**连接页「粘贴」按钮闪退**。
  根因已确证并修复（`getPrimaryText()` 声明 `string` 实到给 `undefined` → `text.length` 抛
  TypeError → ArkUI 回调未捕获异常**杀进程**；见 PORT-MAP 坑 41），
  已过 `BUILD SUCCESSFUL` + **783 用例全绿**，并**已上机复验确认修复有效**
  （2026-10-20，装 `13dbdea` 调试签名包实测，见 TESTING「真机验收记录」）。
  追平 Android 源工程 v2.2.42 的新增内容**已全部落盘**，
  已**编译 + 跑测通过**（`BUILD SUCCESSFUL` + `684 用例全绿`），并已**真机逐项验证**；
  真机验证中**新发现并修复**设置页说明文字不随字号档更新（`SwitchRow.title/description`
  缺 `@Prop`，坑 40），修后复跑编译 + 单测全绿。此前 **1.0.2 已打包并上传 AGC**
  （1.0.0 送审被驳回；1.0.1 因改名而作废，未上传）。见文末「2026-10-17 移植补齐」。
  **另**：源工程已从 v2.2.42 推进到 **v2.2.46**（+6 个提交），对标增量移植**进行中** ——
  已完成：**工具调用专用块**（数据层 `core/ToolBlocks.ts` + 界面 `ui/ToolBlockBody.ets`，端到端）、
  **正文文件链接化端到端**（`core/PathLinks.ts` + `core/InlineSegments.ts` + `ui/InlineText.ets`
  + `ui/MarkdownView.ets` / `ui/ChatMessage.ets` / `ui/ChatDetail.ets` 渲染与点击接入）、
  **权限档位 Pill**（`core/ModelsConfig.ts` `PermissionCatalog` + `core/DshClient.ts`
  `permissionPresets()` 独立候选目录接口 + `ui/ChatHeader.ets` 顶栏小胶囊）、
  **后台任务面板**（数据层 `core/JobViews.ts` + `core/HarnessViewModelJobs.ts` + 界面 `ui/JobsSheet.ets`
  + 能力位守卫 `job-list-v1`，端到端；另在 `DshClient` 拆传输层时**顺手修掉四处 POST 端点拼出双份基地址**）、
  文件链接识别补 autolink 尖括号剥壳；
  待做：会话页九条交互整改，
  以及错误文案 / 截断提示 / 连接导入面板 / 设置页等存量项（逐提交处置见 PORT-MAP 收尾十四）。
  以上新增能力中**正文文件链接化与权限档位 Pill 已于 2026-10-20 上机验**（部分子项受注入
  工具限制未单独触发，见 TESTING），**工具调用专用块与后台任务面板仍为「编译 + 单测通过、未上机」**（本轮新增坑 46–51 见 PORT-MAP）。
- **版本**：1.0.3 / `versionCode` 1000003（**剪贴板闪退修复尚未并入版本号** ——
  `[未发布]` 段已记录，版本号待定：1.0.3 未上传 AGC 则折进 1.0.3 重出包，
  已上传则升 1.0.4，**待用户拍板**）
- **bundleName**：`com.dsh.westanke`
  > 2026-10-16 换掉：旧的 `com.Deepseek_Harness_client.westanke` 因**含 DeepSeek 字样**被判「与
  > DeepSeek 应用名称相似、无商标权属证明」。拿不到授权，只能在 AGC **重建应用**并改
  > bundleName。bundleName 一变，**调试 / 发布 Profile 与证书必须重新签发**（见 `signing/README.txt`）。
- **应用名**：包内 `app_name` = 「DSH 伴侣」（中文）/ 「DSH Companion」（英文）；
  连接页标题去品牌化为「连接服务端」。**应用信息、应用介绍中不得再出现第三方品牌名**。
- **仓库**：[Gitee](https://gitee.com/westanke/dsh-companion-harmony)（`gitee`，**主仓**）·
  [AtomGit](https://atomgit.com/westanke163/dsh-companion-harmony)（`atomgit`，备源）·
  [GitHub](https://github.com/westanke/dsh-companion-harmony)（`origin`，**从站，由 CI 自动同步**）。
  > AtomGit 与 GitHub 的**账号名不同**：AtomGit 是 `westanke163`（GitHub/Gitee 是 `westanke`）——
  > 写远端地址时别照抄 GitHub 的用户名。
  **2026-10-20 改为安卓版同构方案**：本地只推 Gitee / AtomGit，GitHub 由
  `.github/workflows/mirror-sync.yml`（每 3 小时 + 手动 `workflow_dispatch`）
  `clone --mirror` 后 `push --mirror`，并用 `scripts/ci/sync-releases.py` 回填 Release 资产。
  需要 secret `MIRROR_PAT`（`repo` + `workflow` scope）。详见 `docs/RELEASE.md` ⑦。
- **兼容**：HarmonyOS 6.0 及以上（`compatibleSdkVersion` = 5.1.0(18)）
- **设备类型**：phone / tablet / 2in1
- **插件基线**：`dsh-remote-bridge` **≥ 2.0.4**（旧名 `dsh-workspace`）
- **最近验证**：`787 用例全绿`（`cd test && npm test`，49 个用例文件）+ `BUILD SUCCESSFUL`
  （首跑 4 条红已全部修掉，其中 1 条是门禁抓出的真缺陷，详见文末）
- **真机**：ICL-AL10（HarmonyOS 7.0.0.109）已装 **1.0.3 调试签名包**（同调试签名
  **覆盖安装**，`wangke-PC` 配对数据**保住**——局域网 / 虚拟网两地址俱在）。
  **2026-10-20 又装 `13dbdea` 调试签名包复验本轮改动**：剪贴板闪退修复**有效**、
  正文文件名**点得开**、顶栏权限胶囊**渲染 / 候选 / 切换链路**均已验（胶囊弹窗行点击受注入
  工具限制未单独触发）—— 逐项见 TESTING「真机验收记录」。
  **最终签名包已复核**：`bm dump -n com.dsh.westanke` 报 `versionCode` 1000003 /
  `versionName` 1.0.3 / `appProvisionType` debug；设置页「关于」组显示
  **`v1.0.3 · 构建 835b3ba`** —— 水印精确等于出包所用提交（水印链路端到端可用）。
  已逐项上机确认：会话列表（最终包 49 个会话）、消息时间戳（`12:50` / `12:51`）、
  **合并后的会话级状态条**（底部单条「内容由 AI 生成」）+ 工具行（`🔧 执行了命令 · <命令名> ›`）
  与「滚动到底部」按钮、设置页**构建水印**行与**平台层自检**
  （`prefs:ok · aesgcm:ok · hosts:0 · send:queue · lang:zh-Hans-CN · tz:Asia/Shanghai`；
  `hosts:0` 是探针空表往返、**不是**真实主机库计数，符合设计）、
  **主题三档**点「深色」即时整页转深并持久化（重启仍 `dark`）、**字号档**步进并落盘
  （`hdc` 直读 `dsh_settings` 偏好核对 `font_scale`）。
  > **真机复查发现并修复**：设置页「完全跟随系统字号」那行说明文字不随字号档更新
  > （`SwitchRow.title/description` 缺 `@Prop`，坑 40）—— 同一帧里步进器已 `1.3×`、
  > 说明仍写「应用字号 1.2×」。修后在**最终签名包**上三向复验：`＋` `1.0×`→`1.1×`、
  > `−` `1.1×`→`1.0×`、**开关翻动**时说明同帧换成「打开后忽略上面的倍数，只用系统设置里的字号。」
  > 再翻回又同帧变回「应用字号 1.0×」—— 每步 `hdc` 直读偏好核对落盘同步；验完已复原设备偏好。
  > **措辞纪律**：**未上机的项不写成「真机通过」** —— 39 条新能力中**其余项仍为
  > 「编译 + 单测通过，未逐条上机」**。
- **发布产物**（**1.0.3**，2026-10-17 出；内外层均 `verify-app` → `Verify success`）：

  | 产物 | 说明 |
  |---|---|
  | `dsh-companion-harmony-1.0.3-release-signed.app` | 里外双签，**上架 AGC 用** |
  | `dsh-companion-harmony-1.0.3-release-signed.hap` | 发布证书签的内部 hap（`.app` 内层） |
  | `dsh-companion-harmony-1.0.3-release-debugsigned.hap` | 调试签名，**装真机用** |
  | `dsh-companion-harmony-1.0.2-demo-9x16.mp4` | 演示录屏（**沿用 1.0.2**），**AGC「自测文件」用** |

  > 三产物**同源于同一次构建**（`835b3ba` 提交，且均在**写入水印 `835b3ba` 后**构建 ——
  > 见 RELEASE「④-补 构建水印的时序」），只差签名来源；发布证书签的 hap 无法 `hdc install`
  > （设备只信任调试证书）。

- **历史产物**（**1.0.2**，2026-10-16 出，含改名去品牌 + 换 bundleName + AI 生成内容显式标识；
  内外层均 `verify-app` → `Verify success`）**均已被 1.0.3 取代**：

  | 产物 | 说明 |
  |---|---|
  | `dsh-companion-harmony-1.0.2-release-signed.app` | 里外双签，**上架 AGC 用** |
  | `dsh-companion-harmony-1.0.2-release-signed.hap` | 发布证书签的内部 hap（`.app` 内层） |
  | `dsh-companion-harmony-1.0.2-release-debugsigned.hap` | 调试签名，**装真机用** |
  | `dsh-companion-harmony-1.0.2-demo-9x16.mp4` | 遍历使用的演示录屏，**1080×1920（9:16）/ 117.4s**，**AGC「自测文件」用** |

  > 录屏规格是**硬约束**：AGC 驳回原文「当前视频文件时长：136 秒，要求：15 秒至 120 秒；
  > 当前视频文件宽高比：120:271，要求：9:16」。用户自录的 720×1626 / 136.34s 原始录屏因此不合格；
  > 旧产物 `…-1.0.2-demo-walkthrough.mp4`（1080×2440，宽高比 27:61）同样不合格，**已作废**。
  > 合规化**无需重录**：模糊铺底 + 居中满高（不裁掉任何界面元素）+ 1.16 倍变速，一次 ffmpeg 转码即达标，
  > 详见 PORT-MAP 收尾十二。

  > 前两者与真机包**代码完全相同**，只差签名来源；发布证书签的 hap 无法 `hdc install`
  > （设备只信任调试证书）。
  > **`1.0.0` / `1.0.1` 的包全部作废**：1.0.0 图标为 216×216 单层图；1.0.1 仍带旧 bundleName
  > 与 DeepSeek 品牌名，且 Profile 已随旧应用失效。
- **产物校验**（**1.0.3**，2026-10-20 22:13 重建后 `stat` / `sha256sum` 实测回填）：

  | 产物 | 字节 | SHA-256 |
  |---|---|---|
  | `…-1.0.3-release-signed.app` | 533 154 | `02d6e3eb403dac1121b70ec556916baae3240485c3f71055e1da4cadb15824fb` |
  | `…-1.0.3-release-signed.hap` | 1 543 442 | `6606333aa07851667bd80ab36371d0f7d4d8b2d6bdbdbf68f6d7f54fa1ad3492` |
  | `…-1.0.3-release-debugsigned.hap` | 1 543 533 | `91698c1f87488028c02bd83902d6c88df894d950cde90cd019021abad8d61bd2` |

  > **10-17 那批 1.0.3 包全部作废**：不含本轮 AI 上标与轨迹页 / 文件面板 / 连接页修复，
  > 字节数与上面三行对不上的一律不是本版。
  > `.app` 内层 hap 与 `…-1.0.3-release-signed.hap` 是**同一文件**（SHA 实测相等）。
  > 演示录屏沿用 1.0.2 的 `…-1.0.2-demo-9x16.mp4`：37 415 192 字节，
  > `5be2680aacba5770379d847b2c71a29f02570af55e932943cd411591bd7e38bc`。

- **历史产物校验**（2026-10-16）：

  | 产物 | 字节 | SHA-256 |
  |---|---|---|
  | `…-1.0.2-release-signed.app` | 446 829 | `f2ac9d3632ff3623a5e2ba003a6f0e0c62e7e8e39590601ecaa0fbbbcd748741` |
  | `…-1.0.2-release-signed.hap` | 1 287 513 | `2530349380dd1aec93760ea14ccc3427cb5df82c3e06d28afee1e8abac56e5da` |
  | `…-1.0.2-release-debugsigned.hap` | 1 287 602 | `aadb2ebd128fb50889cd5ad11b0deddaa43eefff3ddfd75f6b83fda05b8ed759` |
  | `…-1.0.2-demo-9x16.mp4` | 37 415 192 | `5be2680aacba5770379d847b2c71a29f02570af55e932943cd411591bd7e38bc` |

  > 前三项在 2026-10-16 修复「设置页药丸不刷新」（坑 27）后**重新出包**，故哈希已更新。
  > 第 4 项为合规化转码后的演示录屏（源为用户自录 `8c848cac491bdc15f947b0022293e1ce.mp4`，
  > 720×1626 / 136.34s / 数字静音 → 1080×1920 / 117.367s / 无音轨）。
- **应用图标**：**分层资源**（前景透明 PNG + 背景纯色、背景不含透明像素），两层均 1024×1024 正方形、
  无圆角、无内间距；`AppScope/app_layered_image.json`（`app_foreground` / `app_background`）与
  `entry/layered_image.json`（`foreground` / `background`）刻意用**不同资源名**避免同名覆盖；
  `startWindowIcon` 仍为独立单层图 `startIcon`。真机桌面渲染正常。
- **权限**：仅 `ohos.permission.INTERNET` + `GET_NETWORK_INFO`（`READ_PASTEBOARD` 已移除）
- **上架材料**（`docs/screenshots/`）：
  - 应用介绍截图 6 张（1080×1920，9:16）：`01-sessions` / `02-chat` / `03-files` /
    `04-plugins` / `05-models` / `06-settings`，**全部为 1.0.3 真机重拍**（2026-10-17 在
    装 1.0.3 调试签名包的 ICL-AL10 上重拍；取图方式见下）
  - `ai-generated-label-evidence.png`（1080×2440 原图，**AI 生成内容显式标识证据**，2026-10-17 重截）
  - **取图方式**：真机 `uitest` 驱动 + `snapshot_display`（原图 1080×2440），再按
    `crop(0,120,1080,2040)` 裁成 1080×1920（9:16）。该偏移是对旧图逐偏移滑动比对实测出来的
    —— 偏移 120 处像素差为 0，119/121 处均为 1.4，因此固定 120。
  - 演示录屏见上表第 4 项
- **阻塞项**：**无代码阻塞**。AGC 侧待办（非代码）：
  ⓪「**稳定性体验**」：AGC 上架检测对 **1.0.2** 报「应用运行过程中存在稳定性崩溃问题」
     —— **连接页「粘贴」按钮闪退**。**根因已确证并修复**（见文首阶段说明与 PORT-MAP 坑 41），
     且**已在真机确认修复有效**（2026-10-20，`13dbdea` 调试签名包：点「粘贴」弹提示不退出、
     进程 pid 不变、`faultlogger` 无新增 jscrash，见 TESTING）；
     但**修复尚未进任何上架包**：下一版包必须带上它再送审，否则同一项会被再驳一次；
  ①「分发 > 版本信息 > **AI 功能声明**」改正为「涉及 AI 生成合成服务」；
  ②「应用审核信息 > **自测文件**」上传演示录屏；
  ③「应用截图」：**已按 1.0.3 真机重拍**（2026-10-17，6 张 1080×1920 + `ai-generated-label-evidence.png`
     1080×2440 原图），见 `docs/screenshots/`；原 1.0.2 旧图因界面变化（设置页新增「外观」组、
     会话级状态条合并）作废；
  ④ 实名认证口径：本应用**自身不运营生成服务**（生成发生在用户自建服务端），
     走申诉说明还是补手机号认证，**待用户拍板**。
- **本轮改动（2026-10-20，未出包，真机体感四修）**：依据真机反馈修四处**接线层**缺陷 ——
  ①会话文件面板「点文件只弹路径、再点一次才出内容」（面板靠父组件传状态，而 `bindSheet`
  的 content builder 不随 vm 重绘，永远停在首帧的 `loading` 占位；改为面板自订阅，
  坑 52）；②同一面板下方大留白（**两层**：`FIT_CONTENT` 里写 `height('72%')` 百分比按整屏算，
  改 `constraintSize` 上限；且宿主根容器写着 `height('100%')`，只改内层无效 —— 第二层是真机上
  复验后才逮到的，坑 53）；③连接页失败时一片「连接」（`state.error` 只在
  `AppShell` 报，而未连接时 `AppShell` 根本没挂载；抽出 `ui/ErrorText.ets` 供两处共用，
  并给主机按钮加「重试连接」第三档，坑 54）；④思考条展开后没有收回入口（展开态把整行标题
  换成了正文，可见凭据一起消失；改为标题行常驻 + `⌄`/`⌃` 箭头 + 全文接在下面，
  `onClick` 收到标题行上，坑 55）。`BUILD SUCCESSFUL` + **787 用例全绿**
  （新增 `cases/ui-wiring-guard.test.ts` 四条源码形状门禁，第 2 例现同时查面板内部与宿主根容器）。
  **①③④ 已上机验通**（2026-10-20 断网态验 ③、复网后验 ①④）；**②第二层修复已上机验通**；
  真机体感四修**全部上机验收完毕**（明细见 TESTING 真机验收表）。
- **本轮改动（2026-10-20 晚，未出包，轨迹页两修）**：
  ①真机反馈「轨迹页一片空白」。**根因**：`ui/TrajectoryScreen.ets` 的节点行为画左侧时间轴
  写了一个 `height('100%')` 的竖条，而那一行**高度由内容撑开**（无定值）—— 百分比没有参照，
  按**整屏**算，于是每个节点占掉一整屏，一屏只看到一个 `job/registered #1492`，其余全白。
  **修法**：竖线**直接删除**（源工程没有这条装饰），节点行由内容撑开。同版真机还逮到第二处：
  `bindContentCover` 内容不吃安全区，标题压在状态栏时钟上、`✕` 压在电池图标上 ——
  补 `TYPE_SYSTEM` 顶部高度的 `topInset` 内边距。真机复验：修前一屏 1 个节点 →
  修后一屏 18 个节点、面板与状态栏互不遮挡（截帧 `z1-traj-safe.jpeg`）。坑 56。
  ②真机反馈「能显示了，不认识」。**根因**：第一版把节点渲染成「emoji + 事件原名」且不做类型过滤，
  真机满屏 `job/registered`、`step/start`、`session-log-*`；源工程 `ChatTrajectorySheet.kt`
  的口径是「第 N 轮 + N 个工具调用 + 耗时」+「`#seq` + 本地化类型名 + 工具名」+ 点击展开缩进 JSON。
  **修法**：数据层补噪音过滤（`step/start`、`step/end`、`turn/start`、`tool/result`、
  `session-log-*`、`agent/inbox/*`）并把未知轮次垫底；新增 `prettyPayload()`；
  渲染层类型名全部走 `trajectory_*` 本地化资源（中英各一套），仅 `OTHER` 退回事件原名；
  改为**自订阅 vm**（不再由 `ChatDetail` 传 `history`）。坑 57。
  两修合计：`BUILD SUCCESSFUL` + **794 用例全绿**（`ui-wiring-guard` 第 5 例钉住呈现口径，
  `trajectory.test.ts` 覆盖过滤 / 垫底 / `prettyPayload`）。真机复验：`#1739 助手消息`、
  `第 1 轮 · 47 个工具调用`，点击后 JSON 缩进完整、右侧不裁切（截帧 `v13-traj-final.jpeg`）。
- **本轮改动（1.0.3）**：①**追平 Android v2.2.42 的 39 条新能力**（第 1 / 2 / 3 / 4 批 +
  主题三档，代码全部落盘，见文末「2026-10-17 移植补齐」）；
  ②**真机逐项验证**并**修复**设置页说明文字不随字号档更新（`SwitchRow.title/description`
  缺 `@Prop`，坑 40）；同类审计另修 3 处（`SessionRow` / `ArchivedSessionRow` / `WarningBanner`
  成员补 `@Prop`）；③补 `base` 缺 33 个界面引用键的中文取值（`base` / `en_US` 各 392 键）。
  > 前序 **1.0.2 的本轮改动**（改名去 DeepSeek + 换 bundleName + AI 生成内容标识 +
   > 重录演示录屏 + 重拍截图 6 张 + 修设置页药丸不刷新，详见 PORT-MAP 坑 26 / 坑 27）见 CHANGELOG。
- **下一步**（顺序不可倒）：
  1. **用户拍板版本号**（1.0.3 若尚未上传 AGC → 折进 1.0.3 重出包；已上传 → 升 1.0.4）；
  2. ~~测试机设备侧验证~~ **已完成**（2026-10-20，`13dbdea` 调试签名包）：粘贴按钮**不闪退**已验、
     正文文件名**点得开**已验、顶栏权限胶囊**渲染与候选**已验、**切换链路**服务端双证已验
     （胶囊弹窗行点击受注入工具限制未单独触发，见 TESTING）；
  3. 出上架包（先签 hap → 组装 `.app` → 里外双签 → `verify-app` 双层验）与真机调试包；
  4. 回填体积与 SHA-256 → 上传 `.app` 到 AGC，并按上「AGC 侧待办」补材料

---

## 2026-10-17 移植补齐（追平 Android v2.2.42）

**一句话**：把源工程 v2.2.42 相对本工程的全部新增内容补齐。按「纯增益 → 体感 → 功能 → 工程」
分 4 批推进，外加第 5 批「主题三档」；**四批 + 第 5 批代码已全部落盘，无剩余代码项**
（架构守卫单测 / 中英资源门禁 / 请求代际隔离 / 目录事件去抖 / 投影缓存 / 断档检测 / 订阅基线 /
交付物实时事件 / 会话统计 / 轨迹页 / Clock 接缝 / 连接即重放 / 主题三档）。

> ✅ **本轮改动已于 2026-10-17 编译 + 跑测通过**（工具链恢复后实测）：
> `bash scripts/package.sh` → **`BUILD SUCCESSFUL`**，产出未签名 HAP
> `dist/entry-default-unsigned.hap`（3 004 508 字节，SHA-256
> `ef3ecbbe84147d4a4fdb8c7fd0f4ad864a85e6453c0e19df9a17a480b7b78e9e`；
> `SignHap` 因无 `signingConfigs` 跳过 —— 本工程按 `signing/README.txt` 手工签名，属预期）；
> `cd test && npm test` → **684 用例全绿**（43 个用例文件）。
> 首跑 **4 条红**：2 条是用例自身写错（哨兵值 `0` 误当起点时间戳）、1 条是门禁
> `strings-parity` 抓出的真缺陷（`base` 缺 33 个界面引用键的中文取值）—— 全部修掉后复跑全绿。
> **真机验证已于 2026-10-17 补做**（真机中途断开后重连）：本批**已上机的项**见主表
> 「真机」一节；真机复查**新发现并修复**坑 40（`SwitchRow.title/description` 缺 `@Prop`），
> 修后**复跑编译 + 单测全绿**。**未上机的项仍记为「编译 + 单测通过，未逐条上机」** ——
> 措辞纪律照旧：**没上过真机的，不说「真机通过」**。

**第 1 批（纯增益、低风险）**

| 项 | 落点 | 状态 |
|---|---|---|
| 构建水印（版本 / 构建时间显示在关于处） | `ui/SettingsScreen.ets` | 已验证（编译 + 单测，未真机） |
| 消息时间戳 | `core/ChatTimeLabel.ts` + `ChatDisplayItem.time` 接缝 | 已验证（编译 + 单测，未真机） |
| 字号缩放 | `MarkdownView(textScale)` 全链路 | 已验证（编译 + 单测，未真机） |
| 失败行重试 | `TurnFailureRow` + `onRetry` | 已验证（编译 + 单测，未真机） |

**第 2 批（体感）**

| 项 | 落点 | 状态 |
|---|---|---|
| 思考条与 AI 标识**合并为会话级状态条** | `ui/ChatStatusBar.ets`（新） | 已验证（编译 + 单测，未真机）。**注意**：AGC 已提交的 `ai-generated-label-evidence.png` 因形态变化而**过期，需重截** |
| 过程分组（工具/上下文/思考折叠成组）+ 组级耗时 | `core/ChatDisplayGroups.ts`（新）+ `ui/ProcessGroupRow.ets`（新） | 已验证（编译 + 单测，未真机） |
| 表格「像一张表」（边框 + 列间竖线 + 表头深底） | `ui/MarkdownView.ets` | 已验证（编译 + 单测，未真机） |
| 代码块高亮（零依赖，逐字符原文不变） | `core/CodeHighlight.ts`（新）+ `ui/MarkdownView.ets` | 已验证（编译 + 单测，未真机） |
| 滚动中冻结列表（不再跟着流式乱跳） | `ui/ChatDetail.ets`（`onScrollStarted` / `onScrollStopped`） | 已验证（编译 + 单测，未真机） |

**第 3 批（功能）**

| 项 | 落点 | 状态 |
|---|---|---|
| 消息内图片全屏查看 + 保存（**零权限**，不写相册） | `ui/MessageParts.ets` + `ui/ChatDetail.ets`（`imageViewer` / `bindContentCover`）+ `core/ImageSave.ts`（新） | 已验证（编译 + 单测，未真机） |
| 消息级 `atSeq` 分叉（入口在时间戳那一行、二次确认） | `core/ChatFork.ts`（新）+ `ui/ChatMessage.ets` + `ui/ChatDetail.ets` | 已验证（编译 + 单测，未真机） |
| 已归档会话入口（**按能力位守卫**，明说不能恢复） | `ui/ArchivedSessionRow.ets`（新）+ `ui/ChatScreen.ets` + `HarnessState.archivedSessions` + `DshClient.sessions(archived)` | 已验证（编译 + 单测，未真机） |
| 服务端能力位 / 版本读入（归档入口的前置） | `core/BridgeCapabilities.ts`（新）+ `HarnessViewModelConnection` 的 `connection.ready` | 已验证（编译 + 单测，未真机） |

**第 4 批（工程 / 客户端侧数据管线）**

| 项 | 落点 | 状态 |
|---|---|---|
| 请求代际隔离（切会话 / 重连 / 断开时作废旧请求） | `core/RequestGate.ts`（新）+ `HarnessViewModelBase` / `Sessions` / `Connection` | 已验证（编译 + 单测，未真机） |
| 目录事件去抖（`file.*` 风暴 → 安静 500ms 后一次） | `core/EventDebouncer.ts`（新，`TimerPort` 接缝）+ `HarnessViewModelConnection` + `Files.refreshDirectoryNow()` | 已验证（编译 + 单测，未真机） |
| 历史投影缓存 + 展示口径抽取 | `core/ChatVisibleItems.ts`（新）+ `ui/ChatDetail.ets`（`renderItems()` 改名） | 已验证（编译 + 单测，未真机） |
| 断档检测 + 订阅基线 | `core/ChatSeqMonitor.ts`（新）+ `HarnessViewModelConnection`（`chat.*` / `chat.session.snapshot`） | 已验证（编译 + 单测，未真机） |
| 交付物实时事件（`chat.deliverables.presented`） | `HarnessViewModelConnection` | 已验证（编译 + 单测，未真机） |
| 执行统计面板（**不显示 Token / 上下文占用**，如实说明原因） | `core/SessionStats.ts`（新）+ `ui/SessionStatsSheet.ets`（新）+ `ui/ChatHeader.ets` 菜单 | 已验证（编译 + 单测，未真机） |
| 执行轨迹页（按轮次分组、`OTHER` 显示事件类型原名） | `core/Trajectory.ts`（新）+ `ui/TrajectoryScreen.ets`（新）+ `ui/ChatDetail.ets` 覆盖层 | 已验证（编译 + 单测，未真机） |
| 服务端能力位 / 版本读入的界面侧（过旧警告横幅） | `ui/SettingsScreen.ets` + `core/BridgeCapabilities.ts` | 已验证（编译 + 单测，未真机） |
| **Clock·Transport 接缝**（延迟测量可注入，清源工程 `DEBT-007` 那类 flaky） | `core/ConnectionCoordinator.ts`（构造参数 `clock: () => number`）+ `test/cases/connection-coordinator.test.ts` | 已运行（单测全绿） |
| **连接即重放**（重连成功即补拉断线期间错过的状态） | `HarnessViewModelConnection.handleConnection` | 已验证（编译 + 单测，未真机） |
| **架构纪律可执行门禁**（行数预算 + 台账 / 唯一网络边界 / `ui/` 不读偏好 / 展示单一出口） | `test/cases/architecture-guard.test.ts`（新） | 已运行（单测全绿） |
| **中英资源一致性门禁**（键集一一对应 / 占位符一致 / 无重复键） | `test/cases/strings-parity.test.ts`（新） | 已运行（单测全绿） |
| **修复 `base` 缺 33 个界面引用键** | `entry/src/main/resources/base/element/string.json` | 已补齐（`base` / `en_US` 各 **392** 键），`strings-parity` 门禁复跑通过 |

> 第 4 批**已全部落盘**：**Clock·Transport 接缝**的落点是 `core/ConnectionCoordinator.ts` 的构造
> 参数 `clock: () => number`（默认 `Date.now` 包装），单测注入「手动推进的假时钟」⇒ 那三条依赖
> 精确延迟比较的用例**不再等待真实时间**，源工程 `DEBT-007` 那类 flaky 在结构上消失
> （详见 `docs/CHANGELOG.md` 新增条目 9、`docs/PORT-MAP.md` 坑 37）；**「连接即重放」**落在
> `handleConnection`：`connected = true` 时补拉当前会话历史 + 会话列表 + 待审批 + 待答问题 +
> 命令清单（与 `resumeEvents` 同一条链，详见 CHANGELOG 条目 10）。

**第 5 批（主题三档，= 源工程「设置页外观选项合并」的样式一档）**

| 项 | 落点 | 状态 |
|---|---|---|
| 主题三档：跟随系统 / 浅色 / 深色 | `core/ThemeMode.ts`（已有）+ `AppPreferences.themeMode` + vm `setThemeMode` + `ui/SettingsScreen.ets`（`themeSelector`）+ `platform/Platform.ets`（`applyAppThemeMode`）+ `ui/AppRuntime.ets` | 已验证（编译 + 单测，未真机） |
| 取值三处归一化（`ThemeMode` / 偏好 / 平台） | 同上 | 已验证（编译 + 单测，未真机） |

> 对位源工程 v2.2.42 的 `data/InterfaceStyle`。存的是**线上取值** `'system'`/`'light'`/`'dark'`，
> 不是枚举序数（升级安全）；认不出的取值一律回落「跟随系统」；**原样传给 `setColorMode`
> 会在点击回调里抛参数错误（表现为「点一下就闪退」）**，故必须归一化。详见 CHANGELOG 条目 11。

**新增单测**（**已跑**）：`test/cases/chat-display-groups.test.ts`、
`test/cases/code-highlight.test.ts`、`test/cases/chat-fork.test.ts`、
`test/cases/bridge-capabilities.test.ts`、`test/cases/image-save.test.ts`；
第 4 批再增 `test/cases/request-gate.test.ts`、`test/cases/event-debouncer.test.ts`、
`test/cases/chat-seq-monitor.test.ts`、`test/cases/session-stats.test.ts`、
`test/cases/trajectory.test.ts`、`test/cases/chat-visible-items.test.ts`，以及两条**文档门禁**
`test/cases/architecture-guard.test.ts`、`test/cases/strings-parity.test.ts`；
收口再补 `test/cases/appearance-preferences.test.ts`（对位源工程 `AppearancePreferencesTest.kt`，
覆盖字号边界 / 非法值兜底 / 主题三档判定与回落 / 偏好读写往返）。
用例总数**已从 531 增至 684（43 个用例文件）并全绿**，数字已回填
`TESTING.md` 的「用例数演进」表；首跑 4 条红的原因与修法见该文件。

**新增 / 修改的平台坑**：PORT-MAP 坑 29（`List` 回收 ⇒ 组展开态必须住父组件）、
坑 30（组 id 撞列表 key；`setTimeout` 无取消 ⇒ 冻结解冻需代际校验）、
坑 31（全屏态用 `bindContentCover`，自绘浮层拿不到系统返回键）、
坑 32（写相册是受限权限 ⇒ 图片保存改走零权限系统面板）、
坑 33（能力位「未知」≠「缺失」）、
坑 34（消息级确认框 / 查看器状态必须住父组件）、
坑 35（`resources/base` 资源文件在本机写入会被覆盖、工具回显不可信 ⇒ 一律以 `Read` 复核取真相；
**更深一层**：本机 `Edit` 每次从**冻结的原始快照**重写整文件、且文件末尾锚点检索不到 ⇒ 多次追加必须
**合并在同一次编辑**里。本轮据此补齐了 `base` 缺失的 **33 个**界面引用键，见「修复」段）、
坑 37（**接缝只替换「最容易飘的那一维」，保命逻辑不许被替身绕过** —— Clock 接缝只换「怎么读时间」，
超时 / 关闭 / 取消语义仍由协调器负责）、
坑 38（`/tmp` 被写满自动清除 ⇒ 直连 `Shell` 整条通道失效：任何命令都报 `entity not found`，
**换通道** `Exec` 内 `await tools.Shell(...)` 一次即通；顺带记「管道会吃掉退出码」的判成败纪律）、
坑 39（两处只有**真编译**才报的 ArkTS 硬错：`arkts-no-func-apply-call` 禁 `Function.call/apply`；
`config` 只声明在 `UIAbilityContext` 上、不在基类 `Context` 上）。

**剩余代码项：无。** 编译 + 单测已真实通过（见上 ✅ 块）；真机验证已补做（部分项上机，
未上机项如实标注）。待办剩两件：①**把两个超 900 行预算的文件拆回线内**
（`ui/ChatDetail.ets`(1207) / `ui/SettingsScreen.ets`(979)），**必须在能编译的环境里做**，
理由见 `docs/TECH-DEBT.md`；②`@Prop` 审计中**拿不到真机时序证据**的几处分支内动态成员
（`DEBT-004`，待逐处造时序取证）。
> 源工程里的「上下文用量环」**有意不做**（见 CHANGELOG 里的说明）。
