# DSH Hub Desktop

[English](README.en.md)

![dsh-hub-desktop](design/banner/dsh-hub-desktop-banner-zh.png)

> 个人小玩具，主要解决在使用远程开发机的场景下，文档页面和 `dsh` 页面来回切换有点乱的问题。
> 刚好我的`OpenCode-go`和`mimo-code-plan`都要到期了，于是使用 OpenDesign 设计原型，用 `dsh` 实现出来，然后就有了 `DSH Hub`。
> 累计消耗`dsh`有 395 轮，7784 步，1528M token。

个人使用的 Electron 桌面工具：统一管理多个 **dsh**（DeepSeek Harness）实例 —— 本地进程、SSH 隧道、远程 HTTP 直连三种形态一站管理。认证对接 dsh-auth-gateway 协议（密码 + TOTP + HttpOnly Cookie 注入），支持凭据保险库与已存密码静默登录。

由于没有苹果开发者账号，因此无法打包可信的 App，需要`clone`代码仓库并通过`pnpm dist:mac`来编译 App。

## 分发与隐私

Windows 安装包当前**未经代码签名**，首次运行会出现 SmartScreen「未知发布者」提示（点「更多信息 → 仍要运行」继续）；可用 Release 附带的 `SHA256SUMS.txt` 校验完整性。macOS 不提供官方二进制，需从源码构建。

隐私政策见 [PRIVACY.md](PRIVACY.md)：本应用不收集任何个人数据，无遥测上报，网络连接仅发往用户配置的目标。

## 功能特性

- **实例统一管理**：注册表本地落盘（原子写 + 滚动备份 + 损坏自愈 + 版本迁移）；
  向导式创建 → 启动 → 详情页启停 / 编辑 / 开窗 / 删除
- **三种传输**：统一状态通道，启停 / 开窗按 transport 分发
  - `local`：spawn 本地进程
  - `ssh`：隧道，看门狗指数退避自动重连
  - `http/https`：远程直连
- **认证一体化**：网关五态探测识别（登录页 / OTP / onboarding / API 401 / 无需登录）；
  认证面板全状态流（密码 → 6 位 OTP / 备份码 → 锁定倒计时）；
  **已存密码静默登录**（勾选「记住密码」后，重启 / 会话失效无需重输密码 —— 密码绝不跨进程传递）
- **webview 集成**：分区 Cookie 注入（先注入再 loadURL）、302/401 请求拦截、会话失效信号驱动重登
- **凭据保险库**：系统钥匙串（safeStorage），登录后默认记住、可取消勾选；取消勾选 / 忘记即时清除
- **审计日志**：显式白名单投影，绝不落凭据
- **SSH 安全**：TOFU 主机指纹确认（首次信任 / 变更一律拒绝），口令经内存通道瞬时传递
- **插件管理**：在实例详情列出该实例环境已装插件（图标 / 名称 / 版本 / npm / GitHub / 安装来源），
  支持安装、检查升级、卸载；检查升级按 dsh 主包与子包 peer 判定兼容性，不兼容只提示不误升级；
  含 host 端代码的插件改动后提醒重启实例；元信息按界面语言本地化
- **托盘 / 通知 / 自启**：可配置

|                                            |                                                  |
| :----------------------------------------: | :----------------------------------------------: |
| ![亮色主题](docs/images/home-overview.png) |  ![实例详情](docs/images/instance-details.png)   |
|                 _实例总览_                 |              _实例详情 · 插件管理_               |
| ![实例详情](docs/images/instance-show.png) | ![收起侧边栏](docs/images/sidebar-collapsed.png) |
|                _实例详情页_                |             _侧边栏收起 · 图标模式_              |

## 技术栈

| 层       | 选型                                                                    |
| -------- | ----------------------------------------------------------------------- |
| 桌面框架 | Electron 44 + electron-vite 6 + Vite 7                                  |
| UI       | React 18 + zustand + 手写 CSS（OKLch 明暗双主题）                       |
| 语言     | TypeScript 5.9（strict + `noUncheckedIndexedAccess`）                   |
| 校验     | zod 4.6.7（唯一新增运行时依赖）                                         |
| 测试     | Vitest 5（单测）· Playwright `_electron`（E2E）· 契约测试（对真实网关） |
| 工具链   | ESLint 10 flat + Prettier 3 · pnpm 12 · Node 22                         |

> 刻意避开 vite 8 / TS 7 / React 19（版本线评审结论，勿升级）。

## 架构

```
src/
├─ shared/          框架无关核心（node + web 双工程共享，不 import electron）
│  ├─ endpoint.ts   URL 解析/归一化（协议优先、host:port 消歧、IPv6、回环检测）
│  ├─ contracts.ts  实例模型（zod 判别联合）+ IPC 通道常量 + IpcResult 信封 + 版本迁移
│  ├─ settings.ts   非敏感偏好（语言/主题/托盘/自启/通知）
│  ├─ i18n/         扁平 key → {zh,en} 文案目录
│  └─ bridge.ts     preload 桥接面类型 + app 通道常量
├─ main/            主进程（唯一处理 electron 全局件的地方）
│  ├─ index.ts      窗口 / app://hub 协议 + CSP / 装配
│  ├─ ipc/register.ts  全部 ipcMain.handle 单点注册；入参 zod 校验 → 错误信封
│  ├─ registry/     实例注册表：原子写 + 备份 + 自愈 + 迁移
│  ├─ transport/    local spawn / ssh 隧道 / http 直连
│  ├─ auth/         网关客户端 + 认证状态机 + 会话恢复 + 静默登录
│  ├─ webview/      分区 Cookie 注入、请求拦截、视图计划
│  ├─ vault/        凭据保险库（钥匙串，显式 opt-in）
│  ├─ audit/        审计日志（白名单投影）
│  └─ shell/        托盘 / 原生设置 / 通知 的可注入实现
├─ preload/         contextBridge 白名单，只暴露 dshHub.*
└─ renderer/        React 壳 + 视图 · zustand store · i18n 护栏
tests/e2e/          Playwright _electron
tests/upgrade/      升级路径与发布元数据护栏
scripts/release/    发布演练与校验和
design/             UI 视觉基线（HTML 原型）+ 品牌 token
```

**核心设计约定**（详见 `AGENTS.md`）：

- **IPC 信封**：所有通道返回 `{ok:true,value} | {ok:false,code,message}`，错误码稳定，
  渲染层按码表映射文案；新增通道走固定四步（contracts → register → bridge/preload → 测试）
- **框架无关核心**：shared / registry / transport / auth / vault / audit 不 import electron
- **实例模型**：`transport: local|ssh|http` × `authMode: auto|none|gateway`，
  transport 创建后不可变更

## 快速开始

前置：Node 22+、pnpm 12。

```bash
pnpm install
pnpm dev            # 启动 dev server + Electron 窗口
```

受限 / 沙箱环境下 install 需要附加参数（pnpm store 与 electron 缓存落到可写目录）：

```bash
pnpm install --store-dir=/tmp/pnpm-store --cache-dir=/tmp/pnpm-cache
ELECTRON_CACHE=/tmp/electron-cache node node_modules/electron/install.js  # postinstall 偶发跳过时
```

## 常用命令

| 命令                 | 说明                                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `pnpm dev`           | dev server + Electron 窗口                                                                            |
| `pnpm typecheck`     | node + web + e2e 三工程类型检查                                                                       |
| `pnpm lint`          | ESLint（flat config）                                                                                 |
| `pnpm test`          | 单测（vitest）                                                                                        |
| `pnpm build`         | 三端产物（E2E 前置）                                                                                  |
| `pnpm test:e2e`      | Playwright `_electron`                                                                                |
| `pnpm test:contract` | 对本地 dsh-auth-gateway 源码运行认证契约测试；需设置 `DSH_AUTH_GATEWAY_SRC=/path/to/dsh-auth-gateway` |

**测试说明**：E2E 用例使用 `DSH_HUB_DATA_DIR` 指向的隔离临时目录，实例与凭据均为测试环境构造的数据。CI 失败时收集的产物只包含 Playwright 错误上下文、trace、界面截图与审计日志；凭据保险库文件（`vault/credentials.json`）即使内容是密文也不上传。若未来某条测试必须预置保险库数据，必须使用测试环境构造的 mock 数据并在此处记录其构造方式。

发布相关命令分为“本地打包与验证”和“公开 Release”两类。公开 Release 支持两种分发模式，由发布说明的「分发方式」小节声明：`source-only`（只发布源码、tag 和 Release Note）与 `windows-unsigned`（额外附带本地构建的未签名 Windows 安装包 `DSH-Hub-Setup-<版本>.exe` 与 `SHA256SUMS.txt`）。任何模式都不上传 macOS 二进制（`.app`、`.dmg`、`.zip`）、自动更新元数据（`latest-*.yml`）或差分中间产物（`.blockmap`）；`scripts/release/lib.mjs` 做形态白名单校验。未签名 Windows 安装包首次运行会触发 SmartScreen「未知发布者」提示。

本地打包命令仍保留，但生成的未签名、未公证产物只适用于开发、本机验证和受控测试：

```bash
pnpm dist:mac:zip      # mac zip，本地验证用
pnpm dist:mac          # 仅生成未封装的 macOS .app，本地验证用
pnpm dist:win          # Windows NSIS，需在 Windows 上执行
pnpm dist:win:local    # Windows NSIS（x64），mac 交叉构建出测试包
pnpm electron:prepare  # 按需下载 Electron 二进制（dist* 已内置，无需手动执行）
pnpm release:checksums # 生成 SHA256SUMS.txt（windows-unsigned 发布随安装包上传）
pnpm release:check     # 发布演练：校验发布说明与分发模式、资产清单自洽
pnpm release:publish   # 半自动发布：推 tag → Draft → 资产核验；加 -- --publish 才正式发布
```

Electron 44 起二进制按需下载：`pnpm install` 之后 `node_modules/electron/dist` 可能不存在，而打包配置的 `electronDist` 指向它，因此 `dist`、`dist:mac`、`dist:mac:zip`、`dist:win` 都会先执行 `pnpm electron:prepare`（已存在则立即跳过）。`dist:win:local` 在 mac 上交叉构建 Windows 包：`-c.electronDist=` 置空后 electron-builder 改为自行下载 win 版 Electron zip（缓存在 `~/Library/Caches/electron`，复用构建），不使用本机 dist；`dist:win` 在 mac 上直接执行会把 mac 版 Electron 打进 Windows 包，不要这样用。

发布前运行 `CI=true pnpm release:check -- --pre`，确认发布说明的分发模式与资产清单自洽。演练按声明的模式（`source-only` 或 `windows-unsigned`）输出对应的收口步骤：构建人工完成，推 tag、建 Draft 与上传资产由 `pnpm release:publish` 半自动执行并停在 Draft，人工确认资产后再 Publish；详见 [`docs/release-policy.md`](docs/release-policy.md)。macOS 二进制分发仍需先满足该文档中的签名、公证与验证门槛。

> 无 TTY 环境跑 `pnpm <script>` 需带 `CI=true`（依赖检查在无 TTY 时会中止）。

## 数据目录

- 运行时数据：`<userData>/`（可用环境变量 `DSH_HUB_DATA_DIR` 覆盖）；
  实例注册表在 `<userData>/registry/instances.json`
- 主进程日志：`<userData>/logs/main.log`（按日轮转为 `main.log.<YYYY-MM-DD>`，归档保留 90 天；
  仅主进程 console 输出，落盘前脱敏，不含凭据）
- 仓库内 `hub-data/` 为本地运行 / E2E 数据（已 gitignore；E2E 自动隔离到 `hub-data/e2e*`）

## 安全与凭据纪律

- 注册表 / 审计 / 日志 / 文档**绝不落**密码、OTP、Cookie、私钥；
  密码与 OTP 只经 IPC 参数瞬时传递并驻留内存
- 保险库写入：登录后**默认记住**，用户可取消勾选；降级模式（钥匙串不可用）绝不落盘
- 审计记录由白名单投影构造（禁止对象展开），从结构上杜绝凭据泄漏
- SSH 主机密钥 TOFU：首次确认指纹才放行，**指纹变更一律拒绝**，
  恢复只能显式遗忘该主机指纹
- 静默登录使用保险库已存密码时，密码不跨进程传递：主进程自取，渲染层无读回通道

## 文档

- 发布策略（入库）：[`docs/release-policy.md`](docs/release-policy.md)
- 历史存档：第一个 demo 阶段的设计 / 需求 / 实现计划 / UI demo / 设计 token 等文档已归档至
  [`docs/archive/`](docs/archive/)（不再作为实现依据，仅供回溯）
- 任务追踪类文档（开发任务清单、评审报告、交付清单、打包 / 发布演练 / 安全走查报告等）
  为**本地文档**，按里程碑放 `docs/local/ms-<N>/`（当前 `ms-1`），不进 git
  （一次性任务追踪，见 `.gitignore`）
- 仓库级开发守则：`AGENTS.md`
