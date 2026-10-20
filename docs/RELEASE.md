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

**构建水印另有一条时序**：先把代码与文档**提交**拿到 `HEAD`，再 stamp + 构建 + 签名
（否则包里水印指向上一笔提交）；那一次 `BuildStamp.ets` 的改动随 ⑤ 的回填提交入库。
详见下「④-补」。

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

## ④-补 构建水印的时序（与「⑥ 提交」的先后）

`scripts/build-stamp.sh` 把**当前 `HEAD` 的短哈希**写进**被 git 跟踪的源文件**
`entry/src/main/ets/core/BuildStamp.ets`，而这个值要**先于构建**写进去（`package.sh` 的第一步）。
于是它和「⑥ 提交」天然有个先后问题：**若先出包再提交**，水印指向的是**上一笔提交** ——
包里显示的构建号跟这一版代码所在提交对不上，水印就失去意义。

**做法（1.0.3 起）**：**先提交代码与文档**（拿到 `HEAD` = 本版代码所在提交）→ 再
`build-stamp.sh` + 构建 + 签名 → 水印即**精确等于该版代码的提交号**。`BuildStamp.ets` 这次被
改动的**内容**本身随紧接着的「⑤ 回填真实数据」那次提交一起入库（它只是把哈希写进去，不改逻辑）。

> 为什么不为「水印 = 发布提交」而做自指：那要求提交的哈希等于它自身内容算出的哈希，
> **在结构上不可能**。所以口径定为「**包里显示的提交 = 这个包是从哪个提交出来的**」，
> 而不是「等于最后一个提交」。详见 `entry/src/main/ets/core/BuildStamp.ets` 文件头。

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
- **主从方向与安卓版一致**（2026-10-20 起）：**Gitee 是主仓**（`gitee`），
  **AtomGit 是备源**（`atomgit`），**GitHub 是从站**（`origin`，由 Actions 自动同步）。
  本地只推国内两个远端，GitHub 交给 `.github/workflows/mirror-sync.yml`：
  每 3 小时或手动 `workflow_dispatch`，Runner 从 Gitee（不可达时退 AtomGit）`git clone --mirror`
  后 `git push --mirror`，再把 Gitee 的 Release 正文与 `.app` / `.hap` / `SHA256SUMS.txt` /
  `RELEASE_NOTES_*.md` 幂等回填到 GitHub（`scripts/ci/sync-releases.py`）。
  **为什么不再本地直推 GitHub**：`github.com:443` 长期不稳（`gnutls_handshake` 中断 / 超时），
  而 Runner 出网正常 —— 与其每次苦等，不如让 GitHub 自己来拉。
  > 前提：仓库 secret **`MIRROR_PAT`** 必须存在（带 `repo` + `workflow` scope 的 PAT）。
  > `GITHUB_TOKEN` 按安全设计永远不能写 `.github/workflows/*`，而 `push --mirror` 必然带上这些
  > 文件（坑 C），用它推会**永久卡链**。
- **推送动作**：

  ```bash
  git push gitee master && git push atomgit master     # 国内两源（主 + 备）
  git push gitee <tag>   && git push atomgit <tag>     # tag 同样先到国内源
  # GitHub 交给 CI；要立刻同步可手动触发：
  gh workflow run mirror-sync.yml -R westanke/dsh-companion-harmony
  ```

- **核验**（只看本地 `git log` 是自欺）：

  ```bash
  git ls-remote --heads gitee   master   # 必须等于本地 HEAD
  git ls-remote --heads atomgit master
  git ls-remote --heads origin  master   # CI 跑完后等于本地 HEAD
  gh run list -R westanke/dsh-companion-harmony --limit 5
  ```

- **GitHub 仍可按老办法手动补推**（CI 未跑 / secret 缺失时）。应急阶梯：
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
        最后再回查 `origin master` 确认等于本地 `HEAD`。
  ⛔ 不要为此阻塞收尾：Gitee 已全量同步时，如实说明「GitHub 由 CI 追平中」即可。

- **Release 的发布源是 Gitee**：tag 与资产先发在 Gitee，GitHub 由 CI 回填；
  本地**不再手工在 GitHub 建 Release**（否则会被 CI 判为已存在、只补缺资产）。
  CI 回填时的三条平台限制（已在 `scripts/ci/sync-releases.py` 里处理）：
  ① **`.app` 不能发到 GitHub Release** —— 资产扩展名有白名单，`.app` 不在其中，
     上传会被 422 `name has a file extension that is not allowed` 拒掉。
     所以 AGC 上架包只在 Gitee 提供，GitHub 侧给能直装的 `.hap`；
     不要为了「对齐」把它改名成 `.zip` —— 下载下来是什么就该叫什么。
  ② **Gitee 自动挂的源码包**（`v1.0.3.zip` / `v1.0.3.tar.gz`）要跳过：
     GitHub 每个 tag 自带源码包，重复传只会出现两个来源。
  ③ GitHub uploads **不接受非 ASCII 资产名**，脚本会清成 ASCII 再传
     （漏处理时 400/整段丢弃，见坑 D）。
