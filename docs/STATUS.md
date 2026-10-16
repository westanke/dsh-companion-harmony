# 当前状态

- **日期**：2026-10-16
- **阶段**：1.0.1 已打包，待重新上传 AGC（1.0.0 送审被驳回，详见下「本轮改动」）
- **版本**：1.0.1 / `versionCode` 1000001（1.0.0 因图标不合规被拒，同版本号不能再传）
- **bundleName**：`com.Deepseek_Harness_client.westanke`（AGC 调试 Profile 已绑定，不可改）
- **仓库**：[GitHub](https://github.com/westanke/dsh-companion-harmony)（`origin`，主）·
  [Gitee](https://gitee.com/westanke/dsh-companion-harmony)（`gitee`，镜像），两远端 `master` 同提交
- **兼容**：HarmonyOS 6.0 及以上（`compatibleSdkVersion` = 5.1.0(18)）
- **设备类型**：phone / tablet / 2in1
- **插件基线**：`dsh-remote-bridge` **≥ 2.0.4**（旧名 `dsh-workspace`）
- **最近验证**：`531 用例全绿`（`cd test && npm test`）+ `BUILD SUCCESSFUL`
- **真机**：已在 ICL-AL10（API 26，HarmonyOS 7.0）跑通 **release 构建**（调试证书签名安装）
- **发布产物**（2026-10-16 重出为 **1.0.1**，含分层图标 + 坑 23 / 坑 24 修复，内外层均 `verify-app` 通过）：
  - `dsh-companion-harmony-1.0.1-release-signed.app`（里外双签，**上架 AGC 用**）
  - `dsh-companion-harmony-1.0.1-release-debugsigned.hap`（调试签名，**装真机用**）
  > 两者**代码完全相同**，只差签名来源；发布证书签的 hap 无法 `hdc install`（设备只信任调试证书）。
  > **`1.0.0` 的包作废**：图标为 216×216 单层图，已送审被拒。
- **产物校验**（2026-10-16，`sha256sum` 实测回填）：

  | 产物 | 字节 | SHA-256 |
  |---|---|---|
  | `…-1.0.1-release-signed.app` | 443 800 | `b07fb60d57873c8c5e5659e56f3ab59dac11e5e841292d41c605b409afec9c82` |
  | `…-1.0.1-release-debugsigned.hap` | 1 290 390 | `45f3bbd0f2538093706c4413c726306e4dd5ad1ab45711f894528925332eb891` |
- **应用图标**：**分层资源**（前景透明 PNG + 背景纯色、背景不含透明像素），两层均 1024×1024 正方形、
  无圆角、无内间距；`AppScope/app_layered_image.json`（`app_foreground` / `app_background`）与
  `entry/layered_image.json`（`foreground` / `background`）刻意用**不同资源名**避免同名覆盖；
  `startWindowIcon` 仍为独立单层图 `startIcon`。真机桌面渲染正常。
- **权限**：仅 `ohos.permission.INTERNET` + `GET_NETWORK_INFO`（`READ_PASTEBOARD` 已移除）
- **阻塞项**：**无**。表格列宽修复（坑 23）与 `/` 命令面板修复（坑 24）均已于 2026-10-16
  真机验收通过（见 PORT-MAP §7 第 24 / 25 条）
- **本轮改动**：①上架送审被驳回**主因——应用图标为 216×216 单层图**，已改为 1024×1024 分层图标
  并升版 1.0.1 重出包；②7 个超长文件按「约 900 行」拆分完成（对外接口不变，用例数未降）；
  ③修复会话页 `/` 带不出 dsh 命令（坑 24：普通成员不被回写 → 改 `@Prop`）；④双远端建仓
- **下一步**：把 `dsh-companion-harmony-1.0.1-release-signed.app` 重新上传 AGC；重截上架截图第 3 张
