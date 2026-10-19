# AGENTS.md — DSH Hub Desktop

本文件记录仓库的架构、开发规则和运行环境。用户文档见 `README.md`；临时计划、交付记录和评审材料放在被 Git 忽略的 `docs/local/`，不得加入提交。

## 项目

DSH Hub Desktop 是用于管理多个 dsh 实例的 Electron 桌面应用，支持本机 dsh、SSH 隧道和远程 HTTP/HTTPS 端点。认证使用 dsh-auth-gateway，支持密码、TOTP 和 HttpOnly Cookie 注入。

当前权威信息以代码、本文件与 `README.md` 为准。第一个 demo 阶段的早期设计/需求/实现计划/UI demo/设计 token 等文档已归档至 `docs/archive/`（见其 README），**不再作为实现依据**，仅供回溯历史背景。

重大决策（改红线、改发布、改依赖、改测试策略）记录在 `docs/adr/`（索引见 `docs/adr/README.md`）：本文件只写规则本身，「为什么」与被否决的备选写进对应 ADR。新决策须随实现 PR 附 ADR；推翻旧决策时新增一篇并标注取代关系，不改写历史篇目。

## 技术栈

- Electron 44、electron-vite 6、Vite 7、React 18、TypeScript 5.9
- Vitest 5、Playwright `_electron`、ESLint 10、Prettier 3、pnpm 12、Node 22
- zod 4.6.7 是唯一新增的运行时依赖，用于数据校验
- 保持 vite 7、TypeScript 5 和 React 18 的版本线，不升级到 vite 8、TypeScript 7 或 React 19

## 架构

```text
src/
├─ shared/      Node 与 renderer 共用的类型、校验、设置和 i18n
├─ main/        Electron 主进程、IPC、运行时、传输、认证、存储和原生功能
├─ preload/     contextBridge 白名单，只暴露 dshHub.*
└─ renderer/    React 界面、状态管理和组件

tests/e2e/      Playwright Electron 测试
tests/upgrade/  升级与发布元数据测试
scripts/release/ 发布检查和校验和脚本
```

数据目录为 `<userData>/registry/instances.json`；可用 `DSH_HUB_DATA_DIR` 覆盖。`hub-data/` 是本地运行数据，已被 Git 忽略。

## 开发规则

1. UI 的真实基线是当前 renderer 实现（`src/renderer`）；`docs/archive/dsh-hub-desktop.html` 仅为早期 demo，不作为依据。
2. `src/shared`、registry、transport、auth、vault 和 audit 不得 import Electron（ESLint 分层规则守护；决策见 `docs/adr/0001-process-layering.md`）。
3. 不新增运行时依赖；确有必要时先说明原因和影响（`dependencies` 恒为空由测试守护；见 `docs/adr/0002-zero-runtime-deps.md`）。
4. 修改后至少运行相关测试；提交前运行 `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm test`，并至少运行一次 E2E。
5. 修改认证协议时必须运行 `pnpm test:contract`。
6. 注释和日志只说明当前代码的职责、约束、输入输出或失败原因。不得记录开发过程、任务编号、评审结论、反馈来源、历史实现或不可追溯的文档章节号。使用简洁、准确的常用术语；没有合适中文译法时保留 English。日志只输出排查当前故障所需的信息。
7. 注册表、审计日志、普通日志和文档中不得写入密码、OTP、Cookie 或私钥内容。

## 接口与安全

- IPC 统一返回 `{ok:true,value} | {ok:false,code,message}`；错误码为 `invalid-input`、`not-found`、`invalid-state`、`io-error` 或 `internal`（见 `docs/adr/0003-ipc-envelope-and-enum-registry.md`）。
- 新 IPC 通道需要同步更新 `src/shared/contracts.ts`、`src/main/ipc/register.ts`、`src/shared/bridge.ts`、`src/preload/index.ts` 和测试；`src/main/ipc/ipc-channels.test.ts` 对账四面一致性，漏同步即红。
- IPC 不得接受可被 renderer 用来执行任意路径、命令或其他危险操作的输入。由主进程自行确定目录和命令。
- 实例类型为 `local`、`ssh`、`http`；传输类型不可通过 patch 修改。
- SSH 采用 TOFU：首次读取主机指纹后由用户确认；已保存的指纹发生变化时拒绝连接，用户可显式删除本地指纹后重新确认。
- 目录别名 `@shared` 指向 `src/shared`，配置位于 electron-vite、三个 tsconfig、Vitest 和 Playwright 设置中。

## 并发编辑与 Git

- 有其他 agent 正在编辑文件时，不要提交包含其文件的工作树快照。
- 不使用 `git add .` 或 `git add -A`；只暂存明确确认过的路径。
- 实验在隔离副本中进行，结束后删除实验文件。
- 提交前确认 `git status --short` 只包含预期文件。
- 可按照阶段/功能粒度创建提交，无需逐次征询；提交信息使用 `feat|fix|chore|refactor|test|docs: 描述`。
- **推送（`git push`）必须先征得用户同意**；用户未明确同意时只提交不推送。

## 常用命令

```bash
pnpm dev            # 启动开发模式
pnpm typecheck      # Node、Web、E2E 类型检查
pnpm lint           # ESLint
pnpm format:check   # Prettier 格式校验（CI 强制；修复用 pnpm format）
pnpm test           # Vitest
pnpm build          # 构建 main、preload 和 renderer
pnpm test:e2e       # Playwright Electron 测试
```

打包脚本均使用 `--publish never`；`release:publish` 默认停在 Draft，须显式 `-- --publish` 才正式发布：

```bash
pnpm dist:mac:zip
pnpm dist:mac
pnpm dist:win
pnpm dist:win:local
pnpm release:checksums
pnpm release:check
pnpm release:publish
```

## 环境

- `$HOME/pnpm-workspace.yaml` 可能影响子项目识别；保留仓库内的 `pnpm-workspace.yaml`。
- Electron 44 起二进制按需下载：`pnpm install` 不会生成 `node_modules/electron/dist`（该包的 package.json 已无 postinstall）。E2E 首次启动会自行下载；打包前必须存在该目录（`electronDist` 指向它），四个出包脚本已内置 `pnpm electron:prepare`。`dist:win:local` 在 mac 上交叉构建 Windows 包：`-c.electronDist=` 置空使 electron-builder 自行下载 win 版 Electron，不使用本机 dist；`dist:win` 依赖本机 dist，只能在 Windows 上执行。
- 受限环境安装依赖时使用 `--store-dir=/tmp/pnpm-store --cache-dir=/tmp/pnpm-cache`。
- Electron 缓存使用 `ELECTRON_CACHE=/tmp/electron-cache`。
- 受限环境运行 E2E：`DSH_HUB_E2E_ARGS="--no-sandbox --disable-gpu" CI=true pnpm test:e2e`。
- 本机边工作边跑 E2E：`DSH_HUB_E2E_HIDDEN=1 CI=true pnpm test:e2e`（窗口不显示、应用不进 Dock、不抢焦点；CI 的 Linux 走 xvfb 无需此开关）。
- 无 TTY 时运行 pnpm 脚本必须设置 `CI=true`。
- 后台命令使用 `cd <workspace> && ...` 或 `pnpm --dir <workspace>`，确保在正确目录执行。
