# 0003. IPC 错误信封 + zod 边界校验 + 安装源以枚举传递

- 状态：已采纳
- 日期：2026-09（信封与 zod）；2026-10-18（安装源枚举，见 docs/local/install-plugin-two-step 决策 #2）

## 背景

renderer 是不可信边界：它可能被 XSS、被旧版本缓存、被用户篡改。IPC 层若直接透传参数给命令执行（如 `dsh plugin add <spec>`）或路径拼接，renderer 就获得了任意命令/任意文件原语。另一类风险是「信封形状不一致」——有的通道抛异常、有的返回错误码，renderer 只能靠 try/catch 猜。

## 决策

1. **统一信封**：所有 IPC 返回 `{ok:true,value}` 或 `{ok:false,code,message}`，错误码固定五种（`invalid-input`/`not-found`/`invalid-state`/`io-error`/`internal`）；非法入参在边界拒绝，不抛异常穿透。
2. **zod 校验每个入参**：schema 定义在 `src/shared/contracts.ts`，主进程 handler 入口 parse；失败即 `invalid-input`。
3. **危险输入不进 IPC**：路径、命令、URL 由主进程自行解析（数据目录按实例推导），renderer 只触发动作。
4. **枚举档位而非 URL**：安装源这类「会被拼进命令行」的参数以枚举（`npmmirror`/`npmjs`）经 IPC 传递，URL 只在主进程映射——renderer 无法借 IPC 指定任意 registry 重开 MITM 面。

## 后果

- renderer 与主进程的契约完全由 `contracts.ts` 单点定义，类型与校验同源；
- 新通道必须五处同步（contracts/register/bridge/preload/测试），已由 `ipc-channels.test.ts` 四面对账机器守护；
- 代价：每加一条通道都要写 schema——这是刻意的摩擦。
