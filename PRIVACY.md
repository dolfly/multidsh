# 隐私政策（Privacy Policy）

> **English summary:** DSH Hub Desktop collects **no personal data**. It contains **no telemetry, analytics, crash reporting, advertising, or auto-update mechanism**. It makes network connections **only to endpoints you explicitly configure** — local dsh processes on loopback, SSH hosts you add, remote HTTP/HTTPS dsh instances you register, the npm registry for plugin operations you trigger, and the dsh runtime installer you approve. All application data (registry, credentials, logs, session cookies) stays on your device. The entire source code is public and auditable.

本文档说明 DSH Hub Desktop（以下简称"本应用"）的数据处理行为。核心结论：**本应用不收集任何用户个人数据，不包含任何遥测、分析、崩溃上报、广告或自动更新机制**；所有网络连接都只发往**用户明确配置的目标**，所有数据都只保存在用户自己的设备上。

## 1. 我们不做什么（数据收集）

- 不收集、不上传任何个人身份信息、使用习惯或设备信息。
- 无遥测（telemetry）、无使用统计、无行为分析（analytics）。
- 无崩溃上报（无 `crashReporter`）、无错误日志回传。
- 无广告、无推送营销。
- 无自动更新检查（构建时生成 `latest.yml` 仅供签名发布验证，应用自身不发起升级轮询）。
- 无账户系统，不要求注册或登录本应用。

以上结论可由源码直接核查：整个仓库搜索不到任何遥测/分析 SDK 或第三方统计端点。

## 2. 网络连接（仅用户指定的目标）

本应用会在以下情形发起网络连接，**每一类都对应用户的显式配置或主动操作**：

| 场景                   | 连接目标                                                                                              | 触发方式                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------- |
| 本机实例运行与健康探测 | `127.0.0.1`（回环，dsh 子进程与 SSH 隧道本地端口）                                                    | 用户创建并启动 local 实例        |
| 健康探测               | 实例就绪 URL（仅回环地址）                                                                            | 启动/接管实例时自动              |
| 远程实例               | 用户注册的 HTTP/HTTPS 端点 URL（认证、Cookie 注入均发往该端点）                                       | 用户添加 http 实例               |
| SSH 隧道               | 用户配置的 SSH 主机（经系统 OpenSSH）                                                                 | 用户添加 ssh 实例                |
| 插件管理               | npm registry（默认 `registry.npmjs.org`，可用环境变量 `DSH_HUB_NPM_REGISTRY` 指定镜像；https 信任根） | 用户在插件卡主动安装/升级/检查   |
| 打开外链               | 系统默认浏览器（协议白名单 http/https/mailto，如 npm/GitHub 页面）                                    | 用户点击链接                     |
| dsh 运行时下载         | dsh 官方发布源                                                                                        | 本地实例首次引导，需用户明确确认 |

除上述用户指定目标外，本应用**不向任何其他联网系统发送数据**。外链一律经协议白名单与域名校验（仅放行 http/https/mailto，拒绝可拉起本地程序的协议）。

## 3. 本地存储（全部保存在本机）

应用数据位于系统用户数据目录（`<userData>`，可用 `DSH_HUB_DATA_DIR` 覆盖）：

- **实例注册表** `registry/instances.json`：实例清单与配置，原子写 + 滚动备份 + 损坏自愈。
- **凭据保险库**：经操作系统安全存储（macOS Keychain / Windows DPAPI，Electron `safeStorage`）加密保存；**仅在用户显式勾选"记住"时才落盘**，取消勾选/忘记即清除。
- **会话 Cookie 分区**：webview 分区的认证 Cookie，仅用于渲染用户实例页面；删除实例时清理。
- **本地隔离空间** `homes/<instanceId>`：本地实例的 dsh 配置与工作数据（用户可删除/移入系统废纸篓）。
- **审计日志与应用日志**：本地文件；凭据类内容（密码、OTP、Cookie、私钥）在写入前一律脱敏。
- **界面状态**：渲染层 localStorage/sessionStorage（仅存界面偏好与确认状态）。

## 4. 第三方组件

应用基于 Electron（Chromium + Node.js）与 MIT 等开源许可的 npm 依赖构建，全部随仓库锁文件公开。不含任何第三方分析、广告或追踪服务；页面资源全部随包本地加载。

## 5. 可验证性

- 全部源码在 [GitHub 公开仓库](https://github.com/xbzbing/dsh-hub-desktop) 中，包括主进程、渲染层与 IPC 白名单（`src/preload/` 仅暴露 `dshHub.*` 接口）。
- 渲染层启用 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`，无法自行发起任意网络请求。
- 主进程出网位置有限且可枚举（第 2 节列表），无硬编码第三方端点。

任何怀疑数据被收集或外传的人，都可以对照源码核查或通过下方联系方式提出。

## 6. 变更与联系方式

- 本政策随应用版本演进；政策变更会同步更新本文档并注明日期。
- 问题与报告：GitHub Issues（<https://github.com/xbzbing/dsh-hub-desktop/issues>）。

_最后更新：2026-10-07_
