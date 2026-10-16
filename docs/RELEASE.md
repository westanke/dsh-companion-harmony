# 发版流程

> 本文件收敛散在 `CHANGELOG.md`、`STATUS.md`、`AGENTS.md` 里的发版口径。
> **用户既定规矩优先于本文**——冲突时以用户当次指示为准。

## 顺序（不可倒）

```
① 改代码
② 改文档与版本号     ← module.json5 versionCode +1、CHANGELOG、STATUS
③ 校验               ← hvigorw assembleHap + cd test && npm test
④ 签名打包           ← 先签 hap → 组装 .app → 再签 .app（里外双签）
⑤ 回填真实数据       ← 体积与 SHA-256 写回 STATUS
⑥ git 提交（不推送不发布）
⑦ 等用户发话 → 推送 / tag / 发 Release
```

**为什么 ② 必须在 ③/④ 之前**：先打包再改文档，文档会描述一个不存在的状态。

## ② 必改清单

| 文件 | 改什么 |
|---|---|
| `AppScope/app.json5` | `versionCode` +1、`versionName` —— **应用级版本在这里**，不在 `module.json5`（早期文档写错过，实测验证） |
| `AppScope/app.json5` + 两侧 `element/string.json` | 换 `bundleName` 或改应用名时：**三处必须同改**（AppScope `app_name`、entry `app_name`/`EntryAbility_desc`/`module_desc`），并同步 AGC 后台的版本信息与应用介绍。`bundleName` 一变，Profile 必须重新签发 —— 见 2026-10-16 的换名事件 |
| `AppScope/app.json5` + `entry/src/main/module.json5` | 若换过图标：**必须是 1024×1024 分层资源**（上架硬条件，见 PORT-MAP 坑 25），先过下面的自检 |
| `docs/CHANGELOG.md` | `[未发布]` 段整体挪到版本号下，补日期 |
| `docs/STATUS.md` | 日期、阶段、版本线 |
| `docs/TESTING.md` | 本轮用例数与门验结果 |

**上架前图标自检（1.0.0 就栽在这一条上）**：

```bash
cd entry/build/default/outputs/default
unzip -l entry-default-unsigned.hap | grep -E 'media/.*(foreground|background|layered_image)'
python3 -c "from PIL import Image as I; print('fg', I.open('../../../src/main/resources/base/media/foreground.png').size); print('bg', I.open('../../../src/main/resources/base/media/background.png').size)"
```

判据：包内必须**同时**出现「前景图 + 背景图 + `layered_image.json`」三者，且两张图都是 **1024×1024**，
**背景层不含透明像素**。只看到一张图标（哪怕它是 1024 的）就是**没分层** —— AGC 会驳
「未正确配置单层图」。`startWindowIcon` 用独立的单层图属正常，不算问题。

## ③ 校验

```bash
source ./_toolchain/env.sh
hvigorw assembleHap --no-daemon      # 构建
cd test && npm test                  # 全量单测
```

## ④ 签名打包

```bash
# 1. 签 hap
java -jar "$DEVECO_SDK_HOME/.../hap-sign-tool.jar" sign-app \
  -mode localSign -keyAlias dsh-companion-harmony -keyPwd dshharmony2026 \
  -appCertFile "signing/dsh伴侣-正式证书.cer" -profileFile "signing/dsh clientRelease.p7b" -profileSigned 1 \
  -inFile entry/build/default/outputs/default/entry-default-unsigned.hap \
  -signAlg SHA256withECDSA -keystoreFile signing/dsh-companion-harmony.p12 \
  -keystorePwd dshharmony2026 -outFile <signed>.hap -compatibleVersion 18 -signCode 1

# 2. 组装 .app：解包 hvigor 产出的未签名 .app，换成上一步的已签 hap，再 zip 回去
rm -rf /tmp/appbuild && mkdir -p /tmp/appbuild && cd /tmp/appbuild
unzip -o -q <项目>/build/outputs/default/dsh-companion-harmony-default-unsigned.app
rm entry-default.hap && cp <signed>.hap entry-default.hap
zip -X -q /tmp/app-out.app entry-default.hap pack.info   # 顺序：hap 在前、pack.info 在后

# 3. 再签 .app（同一套发布证书与 Profile）
#    输入是 zip，必须加 -inForm zip；且**不传** -compatibleVersion（那是 hap 专用）
java -jar "$DEVECO_SDK_HOME/.../hap-sign-tool.jar" sign-app \
  -mode localSign -keyAlias dsh-companion-harmony -keyPwd dshharmony2026 \
  -appCertFile "signing/dsh伴侣-正式证书.cer" -profileFile "signing/dsh clientRelease.p7b" -profileSigned 1 \
  -inFile /tmp/app-out.app -inForm zip \
  -signAlg SHA256withECDSA -keystoreFile signing/dsh-companion-harmony.p12 \
  -keystorePwd dshharmony2026 -outFile <signed>.app -signCode 1

# 4. 两层都要验
java -jar "$DEVECO_SDK_HOME/.../hap-sign-tool.jar" verify-app -inFile <signed>.app  -outCertChain /tmp/a.cer -outProfile /tmp/a.p7b
java -jar "$DEVECO_SDK_HOME/.../hap-sign-tool.jar" verify-app -inFile /tmp/appbuild/entry-default.hap -outCertChain /tmp/b.cer -outProfile /tmp/b.p7b
```

> **两个易错点**（实测踩过）：
> - 只签外层 → 内部 hap 仍 `signature not found`，上架有被拒风险，**必须里外双签**。
> - `.app` 的输入是 **zip**，要 `-inForm zip`，且 **`-compatibleVersion` 是 hap 专用**，
>   给 `.app` 传它没意义（工具会忽略）；同理 hap 必须传 `-compatibleVersion 18`，漏了会报错。
>
> **两产物必须同源于同一次构建**：先 `assembleApp` 再分别签两份，别拿上一次构建的 hap 去签
> 真机包 —— 那样「代码完全相同」这句话就不成立了（本轮即为此重签了一遍）。

> **2026-10-16 起材料名**：调试证书 `signing/dsh伴侣-调试证书.cer` + Profile `signing/ds clientDebug.p7b`；发布证书 `signing/dsh伴侣-正式证书.cer` + Profile `signing/dsh clientRelease.p7b`。
> 这些文件名**含空格与中文**，命令行里必须加引号（上例已加）。
>
> **真机调试包**用**调试证书 + 调试 Profile**（受设备白名单限制，`hdc` 可装）；
> **上架包**用**发布证书 + 发布 Profile**（白名单 0 条，`hdc` 装不了，必须走应用市场）。
> 两者**代码完全相同**，只差签名来源。

## ⑤ 回填真实数据

```bash
stat -c '%s' <产物>      # 字节数
sha256sum <产物>         # 摘要
```

把真实值写回 `docs/STATUS.md`。**不许抄上一版的数字**。

## ⑥ 提交纪律

- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/)。
- **提交 ≠ 可发布**。对外区分「已合并」「已发布」「用户吃到了」三态。

## ⑦ 推送与发布（必须用户点头）

- 禁止 `--force`。
- 推送 / tag / 发 Release 必须用户明确同意。
- **三远端**：`origin` = GitHub（主，`master` 跟踪它）、`gitee` = Gitee（镜像）、
  `atomgit` = AtomGit（镜像）。每个都推，推完**逐远端核验**：
  `git ls-remote --heads <远端> master` 必须等于本地 `HEAD` —— 只看本地 `git log` 是自欺
  （本地领先时它照样显示新提交）。
- **GitHub 间歇不可达**（国内网络常见：`github.com:443` 被断，但 `api.github.com` 通）。两手准备：

  - **常规（推荐）**：本地只推 Gitee / AtomGit，让 GitHub Actions 反向拉回 ——
    `.github/workflows/sync-from-mirrors.yml`（每 30 分钟或手动触发）。Runner 跑在 GitHub
    服务器上、出网正常，能访问 `gitee.com` / `atomgit.com`，**彻底绕开本地到 GitHub 的网络问题**。
    只做快进（`git merge --ff-only`）：镜像落后就拉齐，镜像与 GitHub 分叉则跳过、**绝不强推**。
    > 前提：仓库 Actions 已启用、workflow 里声明 `permissions: contents: write`（本仓默认
    > workflow 权限是 `read`，不显式提权会推不回去）。
    > **workflow 里 `actions/checkout` 已改用 `token: ${{ secrets.SYNC_PAT || github.token }}`**：
    > `GITHUB_TOKEN` 天生没有 `workflows` 权限，待推送区间一旦含 `.github/workflows/` 下的文件，
    > GitHub 直接拒绝
    > （`refusing to allow a GitHub App to create or update workflow ... without 'workflows' permission`），
    > 提权到 `contents: write` 也没用，**且会一直卡住**（后续快进都包含那一笔）。
    > 故按 2026-10-16 用户「写凭据」授权，往仓库 secret `SYNC_PAT` 写入带 `workflow` 权限的令牌，
    > checkout 用它拉取 —— 如此**含 workflow 改动的提交也能由镜像链自愈**。
    > secret 未配置时表达式退回 `github.token`：普通提交仍能推，只是 workflow 提交会失败。
    > 兜底仍是下面第 ④ 步的 REST 补推（用户令牌带 `workflow` scope 即可，本账号有）。
  - **应急重试阶梯**（Actions 未跑或不可用时手动补齐）：
    ① 重试并强制 `-c http.version=HTTP/1.1`（`gnutls_handshake failed` 多为 HTTP/2 问题）；
    ② 探测本机代理（7890 / 1080 / 8118…），命中则 `-c http.proxy=…` **一次性**推送、不改全局配置；
    ③ 试 `ssh -T -p 443 git@ssh.github.com`（该端口常通；**需账号已挂 SSH 公钥**，
       未挂会 `Permission denied (publickey)`）；
    ④ 仍不通 → 用 GitHub REST API 补推（**2026-10-16 已实战跑通**）：
       `POST /git/blobs`（每个新增/修改文件，base64）→ `POST /git/trees`
       （`base_tree` 取父提交的 tree；删除的路径写 `"sha": null`）→ `POST /git/commits` →
       `PATCH /git/refs/heads/master`。
       关键：commit 必须**复刻本地提交的 tree / parent / author / committer / message 五要素**，
       否则算出的 SHA 与本地不同 → 远端与本地**分叉**，后续正常 `push` 会被拒。两个必踩的点：
       ① `message` 必须按 `git cat-file commit HEAD` 取**原始字节** —— `git log --format=%B`
          经命令替换会**吃掉结尾换行**，实测就因这一字节导致 SHA 对不上；
       ② 每步都用 `git rev-parse` 期望值断言，**blob / tree / commit 三层 SHA 都要等于本地**，
          最后再回查 `<远端> master` 确认等于本地 `HEAD`。
  ⛔ 不要为此阻塞收尾：Gitee 已全量同步时，如实说明「GitHub 仅差一笔，待网络恢复重推」即可。
