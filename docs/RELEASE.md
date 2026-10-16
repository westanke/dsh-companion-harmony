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
| `entry/src/main/module.json5` | `versionCode` +1、`versionName` |
| `docs/CHANGELOG.md` | `[未发布]` 段整体挪到版本号下，补日期 |
| `docs/STATUS.md` | 日期、阶段、版本线 |
| `docs/TESTING.md` | 本轮用例数与门验结果 |

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
  -appCertFile signing/<cert>.cer -profileFile signing/<profile>.p7b -profileSigned 1 \
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
  -appCertFile signing/<cert>.cer -profileFile signing/<profile>.p7b -profileSigned 1 \
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
- **双远端**：`origin` = GitHub（主，`master` 跟踪它），`gitee` = Gitee（镜像）。
  两边都要推，推完**逐远端核验**：`git ls-remote --heads <远端> master` 必须等于本地 `HEAD`
  —— 只看本地 `git log` 是自欺（本地领先时它照样显示新提交）。
- **GitHub 间歇不可达的重试阶梯**（国内网络常见：`github.com:443` 被断，但 `api.github.com` 通）：
  ① 重试并强制 `-c http.version=HTTP/1.1`（`gnutls_handshake failed` 多为 HTTP/2 问题）；
  ② 探测本机代理（7890 / 1080 / 8118…），命中则 `-c http.proxy=…` **一次性**推送、不改全局配置；
  ③ 试 `ssh -T -p 443 git@ssh.github.com`（该端口常通；**需账号已挂 SSH 公钥**）；
  ④ 仍不通 → 用 GitHub REST API 补推：`POST /git/blobs`（每个改动文件，base64）→
  `POST /git/trees`（`base_tree` 取父提交的 tree）→ `POST /git/commits` → `PATCH /git/refs/heads/master`。
  关键：commit 必须**复刻本地提交的 tree / parent / author / committer / message 五要素**
  （author/committer 连时间戳与时区都要一致），否则算出的 SHA 与本地不同 → 远端与本地**分叉**，
  后续正常 `push` 会被拒。做法：每步都用 `git rev-parse` 期望值断言，**commit SHA 必须等于本地 HEAD**。
  ⛔ 不要为此阻塞收尾：Gitee 已全量同步时，如实说明「GitHub 仅差一笔，待网络恢复重推」即可。
