# 0001. 进程分层与「框架无关层不 import Electron」红线

- 状态：已采纳
- 日期：2026-09（红线写入 AGENTS）；2026-10-19 由 ESLint 规则机器化（见文末）

## 背景

Electron 应用天然有三进程（main / preload / renderer），但业务逻辑（注册表、传输、认证、凭据、审计）如果直接 `import { app } from 'electron'`，就只能在 Electron 环境里测——单测要起 mock 电子秤级别的脚手架，且主进程生命周期会顺着 import 链渗进纯逻辑模块。

## 决策

`src/shared` 与 `src/main/{registry,transport,auth,vault,audit}` 六处为**框架无关层**：禁止 import `electron`（含子路径）。需要宿主能力（路径、窗口、系统对话框）时由装配层（`src/main/index.ts`、`create-runtime.ts` 等）解析后**注入**，以函数/数据形式传入。

配套边界：

- preload 只经 `contextBridge` 暴露白名单方法 `window.dshHub`，通道名全部来自共享常量；
- renderer 不直接 import `node:*`（宿主能力一律走桥接）；
- shared 不反向依赖 main/renderer（它被两侧共享）。

## 后果

- 框架无关层的单测在纯 Node（vitest）下即可运行，无需 mock electron；
- 新增宿主能力必须走「装配层解析 → 注入」路径，多一层显式接线，但这正是要的摩擦；
- 违规由 `eslint.config.mjs` 的 `no-restricted-imports` 即时报错（探针验证可转红）。
