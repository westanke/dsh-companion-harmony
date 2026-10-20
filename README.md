# DSH 伴侣（HarmonyOS 版）

把运行在电脑上的 [DeepSeek Harness](https://github.com/hakunm/deepseek-harness)
带到手机上：连接自建服务端，随时随地查看会话进度、继续对话、处理审批。

> 本仓库是 Android 版 DSH Companion 的 HarmonyOS 原生移植（ArkTS / ArkUI），
> 不使用 WebView，聊天页为原生重写。

**仓库**：[GitHub](https://github.com/westanke/dsh-companion-harmony) ·
[Gitee](https://gitee.com/westanke/dsh-companion-harmony) ·
[AtomGit](https://atomgit.com/westanke163/dsh-companion-harmony)（镜像，内容同源）

> GitHub 主站国内常不可达，仓库内 `.github/workflows/sync-from-mirrors.yml` 会由 GitHub 侧的
> Runner 定时把 Gitee / AtomGit 镜像**快进回补**到 GitHub（详见 `docs/RELEASE.md` ⑦）。

## 功能

- **连接管理**：局域网 / 虚拟网 / 公网多地址并存与切换，配置导入与一次性配对码
- **会话**：列表、详情、实时消息流、AI 思考过程、工具调用记录与待审批交互
- **工作区文件**：浏览与编辑、会话内文件预览（HTML 结构预览、二进制降级）
- **模型与插件**：供应商管理、会话模型切换、插件清单与启停
- **Markdown 渲染**：标题 / 列表 / 引用 / 代码块 / GFM 表格 / 分隔线，行内样式
- **界面**：深色模式跟随系统主题，中文界面（预留英文接口）

## 环境要求

- HarmonyOS 6.0 及以上（`compatibleSdkVersion` = 5.1.0(18)）
- 构建：`hvigorw`（DevEco Studio 或独立工具链）
- 签名：`hap-sign-tool.jar`（hvigor 拒明文口令，需手动签名）
- 真机调试：`hdc`

## 自己安装（应用尚未上架应用市场）

**先说清现状**：本应用**尚未上架华为应用市场**，市场里搜不到，因此没有「点一下就能装」的入口
（上架进度见 [docs/STATUS.md](docs/STATUS.md)）。而 HarmonyOS 设备**只信任两类安装包**：

- 应用市场（AppGallery）签名分发的包；
- **把本机 UDID 写进 Profile 白名单**的调试证书签名的包。

所以**源码、未签名的 hap、发布证书签的 hap 都装不上** —— 设备会因签名校验不过直接拒装
（发布证书签的包只用于上架，不走 `hdc install`，见 [docs/RELEASE.md](docs/RELEASE.md) ④）。
下面两条路线，按你的身份选一条。

### 路线 A：你是开发者 —— 自己构建、自己签名

需要：一台 **HarmonyOS 6.0 及以上**的设备、**DevEco Studio**（自带 SDK 与 `hdc`）、
一个已实名认证的华为开发者账号。

1. 克隆仓库：`git clone https://github.com/westanke/dsh-companion-harmony.git`
   （国内网络可从 [Gitee 镜像](https://gitee.com/westanke/dsh-companion-harmony) 克隆）
2. DevEco Studio「Open」打开工程目录 `dsh-companion-harmony/`
3. `File → Project Structure → Signing Configs` 勾选 **Automatically generate signature**，
   按提示登录华为账号。DevEco 会把**当前 USB 连着的那台设备**的 UDID 自动登记进它签发的
   调试 Profile，并生成密钥与证书 —— **这一步不需要你手工准备任何签名材料**。
4. 点工具栏 ▶ Run 直接装到设备；或 `Build → Build HAP(s)`，到
   `entry/build/default/outputs/default/` 取包按路线 B 的安装命令手工装。

> 想脱离 DevEco、纯命令行构建与签名（`hvigorw` + `hap-sign-tool.jar`），命令与易错点见
> [docs/RELEASE.md](docs/RELEASE.md) ④。注意 hvigor **拒明文口令**，必须用
> `hap-sign-tool.jar` 手动签。

### 路线 B：你不是开发者 —— 由维护者给你一个已签好的包

这条路**必须交换一份材料：你的设备 UDID**。调试证书签发的 Profile 是**按设备白名单**签的，
不在名单里的手机装不上，且**一个包只对名单内的设备有效**。

- **你要提供什么**：设备 UDID（取法见下）
- **怎么提供**：把那一行 UDID，连同**设备型号与系统版本**，通过仓库 Issue 或维护者给你的
  私下联系方式发过来

**怎么取 UDID**：

1. 手机上先开开发者选项：`设置 → 关于本机 → 连续点击「版本号」7 次`，
   再到 `设置 → 系统与更新 → 开发者选项` 打开 **USB 调试**
2. 用**能传数据的数据线**（纯充电线不行）连到电脑，手机弹窗选**允许** USB 调试
3. 电脑上执行（`hdc` 在 DevEco Studio 安装目录的
   `sdk/default/openharmony/toolchains/` 下，也可单独下载 Command Line Tools）：

```bash
hdc list targets          # 能列出设备才说明连上了
hdc shell bm get --udid   # 输出一行 UDID（旧版 hdc 用 -u）
```

> UDID 是**设备标识**、不是密钥，可以公开；但它唯一指向你的设备，建议只发给维护者。

**之后会发生什么**：维护者在 AGC 把该 UDID 加进调试 Profile 白名单 → 重新签发 Profile →
用调试证书重签一个 hap → 把 hap 发给你。

**你怎么装**（同样需要电脑 + 数据线，手机端按上面第 1、2 步开好 USB 调试）：

```bash
hdc install -r dsh-companion-harmony-<版本>-debugsigned.hap
```

装完桌面出现「DSH 伴侣」。三点注意：

- 调试签名的包**受 Profile 有效期约束**，到期后必须重新签发、重新安装；
  想长期使用只有等本应用上架华为应用市场
- **换签名来源**（例如从别人的调试包换成你自己账号签的包）通常要先卸载旧包，
  而卸载会**清掉已保存的连接与配对数据**，需要重新配对
- 包里只是**客户端**，它要连**你电脑上运行的服务端**
  （[DeepSeek Harness](https://github.com/hakunm/deepseek-harness)），不是自带云端；
  首次打开到「连接服务端」页填地址，或用一次性配对码导入配置

## 快速开始

### 构建

```bash
source ./_toolchain/env.sh
hvigorw assembleHap --no-daemon
```

产物：`entry/build/default/outputs/default/entry-default-unsigned.hap`

### 签名与安装

```bash
# 调试签名：需在 AGC 绑定设备 UDID 的调试证书与 Profile
java -jar "$DEVECO_SDK_HOME/default/openharmony/toolchains/lib/hap-sign-tool.jar" sign-app \
  -mode localSign -keyAlias <alias> -keyPwd <pwd> \
  -appCertFile signing/<cert>.cer -profileFile signing/<profile>.p7b -profileSigned 1 \
  -inFile entry/build/default/outputs/default/entry-default-unsigned.hap \
  -signAlg SHA256withECDSA \
  -keystoreFile signing/<keystore>.p12 -keystorePwd <pwd> \
  -outFile entry/build/default/outputs/default/entry-default-signed.hap \
  -compatibleVersion 18 -signCode 1

# 安装
hdc install -r entry/build/default/outputs/default/entry-default-signed.hap
```

### 运行单元测试

```bash
cd test && npm test
```

## 工程结构

```
dsh-companion-harmony/
├── entry/src/main/ets/
│   ├── core/        # 纯逻辑（可单元测试）：Markdown 解析、连接存储、会话模型等
│   └── ui/          # ArkUI 页面与组件
├── test/            # 单元测试（jest，独立 npm 项目）
├── signing/         # 签名材料（不含密钥，.gitignore 已排除）
└── docs/
    ├── PORT-MAP.md       # Android → HarmonyOS 移植对照与坑点
    ├── CHANGELOG.md      # 变更日志（Keep a Changelog）
    ├── store-listing.md  # 中英文上架文案
    └── screenshots/      # 上架截图（1080×1920）
```

## 文档

- [AGENTS.md](AGENTS.md) — 工程宪法（命令、契约、铁律、坑位索引），每会话必读
- [docs/README.md](docs/README.md) — 文档索引
- [docs/STATUS.md](docs/STATUS.md) — 当前状态
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 架构
- [docs/RELEASE.md](docs/RELEASE.md) — 发版流程与签名
- [docs/TESTING.md](docs/TESTING.md) — 测试记录
- [docs/SECURITY.md](docs/SECURITY.md) — 安全
- [docs/PORT-MAP.md](docs/PORT-MAP.md) — 移植对照与坑点
- [docs/PARITY.md](docs/PARITY.md) — 能力对等矩阵
- [docs/ROADMAP.md](docs/ROADMAP.md) — 任务台账
- [docs/TECH-DEBT.md](docs/TECH-DEBT.md) — 技术债务台账
- [docs/decisions/](docs/decisions/) — 架构决策记录（ADR）
- [docs/CHANGELOG.md](docs/CHANGELOG.md) — 变更日志
- [docs/store-listing.md](docs/store-listing.md) — 上架文案（中英文）
- [artifacts/RELEASE_NOTES_v1.0.0.md](artifacts/RELEASE_NOTES_v1.0.0.md) — 1.0.0 发版说明

## 开发约定

- 核心逻辑放 `core/`，必须配套单元测试；UI 放 `ui/`
- 每次改动先在 `docs/CHANGELOG.md` 的 `## [未发布]` 段追加条目
- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/)

## 许可

见 [LICENSE](./LICENSE)。
