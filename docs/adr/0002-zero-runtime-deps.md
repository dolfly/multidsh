# 0002. 运行时零 npm 依赖（zod 并入打包产物）

- 状态：已采纳
- 日期：2026-09（AGENTS 规则 3）；机器守护见文末

## 背景

桌面应用的运行时依赖是供应链面：每个依赖都会进 app.asar、进用户的磁盘、参与打包时的构建图。zod 是唯一确有必要的运行时代码（所有 IPC 入参与设置/注册表校验），其余需求（UI 状态 zustand、构建 electron-vite）都只在开发期。

## 决策

`package.json` 的 `dependencies` 恒为空。zod 放在 `devDependencies`，由 electron-vite 打包时正常解析并**并入 `out/` 产物**——devDependency 只影响「谁来安装它」，不影响打包结果。确需新增运行时依赖时：先在对话里说明原因与影响，再单独评审。

## 后果

- `pnpm install --frozen-lockfile` 之外没有隐式运行时依赖图；
- `tests/upgrade/release-metadata.test.ts` 断言 `dependencies` 为空，CI 每次提交都校验；
- 代价：不能随手引库，轮子要自己写（如 env-diff、semver 比较都自实现）——对本应用规模可接受。
