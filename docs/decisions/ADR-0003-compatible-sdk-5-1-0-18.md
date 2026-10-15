# ADR-0003：`compatibleSdkVersion` = 5.1.0(18)

- 状态：已采纳
- 日期：2026-10-15

## 背景

用户明确要求「目标兼容鸿蒙 6+，我自己用鸿蒙 7」。构建配置里
`compatibleSdkVersion` 决定**最低可安装版本**，`targetSdkVersion` 决定按哪一版的行为运行。

## 决策

**`compatibleSdkVersion = 5.1.0(18)`**（其余保持工具链默认）。

## 理由

1. HarmonyOS 6 对应 API 20，用户要求 6+，取 5.1.0(18) 可覆盖更广机型，
   不必为用不到的 6.x 新接口把门槛抬高。
2. **已实测**：真机 ICL-AL10 为 API 26 / HarmonyOS 7.0，安装与运行均通过
   ——低版本声明在高版本设备上不是阻碍。
3. 签名时 `-compatibleVersion 18` 必须与此一致，否则装包校验不过。

## 后果

- **代价**：若后续要用 API 20+ 才有的能力，需要重新评估这个值（属"上调须带理由"类变更）。
- **后果**：`hap-sign-tool` 的 `-compatibleVersion` 参数与这里**必须成对改动**，
  改一处忘一处会出现"签名成功、安装失败"。已记入 `docs/RELEASE.md`。
