# 网页工作区信任与模型选择 Implementation Plan

**Goal:** 在网页确认并保存指定工作区信任，为 Chat 新对话提供模型选择。

**Architecture:** 目录列表返回规范路径与信任状态；有账户归属校验的确认接口通过已有 resolve_workspace 命令发送明确授权，Worker 校验规范路径后持久化信任。普通会话解析保持拒绝未信任目录。Chat 复用 Code 的暂存模型选择与启动后激活流程。

**Tech Stack:** Bun、TypeScript、Hono、React。

## Steps

- [x] 在 src/utils/config.ts 添加只写指定目录的信任保存函数，保留现有配置和锁。
- [x] 扩展 src/bridge/types.ts、productRuntime.ts 和 RCS 命令类型，传递显式确认与目录信任状态。
- [x] 在 routes/web/code.ts 添加校验环境归属、确认值和规范目录的信任接口。
- [x] 在 RemoteDirectoryPicker.tsx 显示目录信任状态、授权范围及确认按钮；继续支持手动路径和目录浏览。
- [x] 在 ChatHome.tsx 添加模型选择，通过 createSession.ts 暂存，复用既有切换流程。
- [x] 补充未确认拒绝、规范路径检查、信任持久化及模型传递测试；运行相关测试、类型检查和网页构建。
- [x] 检查 diff，仅提交本轮文件，不提交已有 scripts/rcs-stack/main.ts 修改。重启前检查活动会话，验证网页入口。
