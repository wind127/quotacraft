# 架构与接口

```text
Codex app-server → quota snapshots → planner → Web / CLI / MCP
                                         ↓
explicit execution opt-in → serial runner → checkpoint → human acceptance
X API / manual signals → evidence ledger → experimental survival forecast
community forecast → separately labelled display (no admission influence)
```

## 模块

| 模块             | 责任                                       |
| ---------------- | ------------------------------------------ |
| `src/domain.ts`  | 输入约束、领域类型、默认策略               |
| `src/planner.ts` | 纯函数调度、数据有效期、消耗速度、实验预测 |
| `src/store.ts`   | SQLite WAL 持久化、索引、参数化写入        |
| `src/codex.ts`   | app-server 握手、额度标准化、受管进程结束  |
| `src/service.ts` | 任务生命周期、提醒去重、账号恢复观测       |
| `src/runner.ts`  | 显式开启的串行执行、暂停、摘要、验收门槛   |
| `src/server.ts`  | 仅回环 HTTP、API、静态页面、有限轮询       |
| `src/mcp.ts`     | 7 个 stdio 工具，不输出诊断到 stdout       |
| `web/main.tsx`   | 任务、预算、信号、成绩单与设置界面         |

## 调度方法

1. 缺失、超期、未来读数或已到期窗口阻止新任务准入。
2. 取所有已暴露窗口的最小剩余百分比，减去应急预留，得到当前规划预算。不同池不相加；当前为保守约束，尚未根据模型隔离池。
3. 正在执行的任务优先收尾；排队任务按 `must → should → could`、截止时间、最高估计成本和创建时间排序。
4. 最高成本估计加收尾预留，用于每项任务准入；执行是串行的，累计用时参与截止风险判断。
5. 如果预计执行跨越最近窗口恢复边界，先等待恢复并重新读取，不假定自动增加额度。
6. 暂停任务需要用户检查断点并恢复。进程成功退出进入 `review`，验收通过才进入 `done`。

模型档位由任务质量与用户设置决定。没有基于低额度的隐式降档，也不把 API 价格映射为订阅额度成本。

## 持久化

`~/.quotacraft/state.sqlite` 为真实/手动空间；`demo.sqlite` 为独立演示空间。通用 `records` 表按种类与 ID 唯一索引，时间与插入顺序用于读取。保留最多 2,000 条额度快照；信号、任务和断点不会自动清除。审计数据不保存原始子进程日志。

任务内容与断点可能包含私有代码描述。不要提交数据库或导出到公开仓库。Unix 数据目录和主数据库采用仅用户访问权限；Windows 使用当前用户目录继承的访问控制。

服务持有带时间戳的本地 owner 记录，避免同一数据目录的近期存活服务被第二个实例接管。启动失败时不修改任务状态；成功启动后将上次遗留执行任务变为已暂停。

## REST API

| 方法 / 路径                      | 用途                           |
| -------------------------------- | ------------------------------ |
| `GET /api/state`                 | 状态、计划、趋势和成绩         |
| `GET /api/health`                | 版本、存活和演示状态           |
| `POST /api/tasks`                | 创建任务                       |
| `PATCH /api/tasks/:id`           | 编辑任务配置                   |
| `DELETE /api/tasks/:id`          | 删除非执行中任务               |
| `POST /api/tasks/:id/preflight`  | 短期准入建议                   |
| `POST /api/tasks/:id/start`      | 开始受管执行                   |
| `POST /api/tasks/:id/pause`      | 暂停当前进程树                 |
| `POST /api/tasks/:id/checkpoint` | `{text}` 保存断点并暂停        |
| `POST /api/tasks/:id/resume`     | 已暂停 → 排队                  |
| `POST /api/tasks/:id/review`     | `{accepted, actualCost?}` 验收 |
| `PUT /api/policy`                | 完整策略更新                   |
| `POST /api/quota/refresh`        | 官方 Codex 额度读取            |
| `POST /api/quota/manual`         | `{windows}` 手动规划额度       |
| `POST /api/signals`              | 添加/更新带来源信号            |
| `POST /api/signals/sync`         | `{source: "x"                  | "community"}` |
| `POST /api/import/signals`       | `{signals: [...]}` 批量信号    |
| `POST /api/notices/read`         | 标记消息已读                   |
| `GET /api/export`                | 导出本地私人数据               |

修改请求使用 `application/json`。浏览器 Origin 与 Host 必须是实际端口上的 `127.0.0.1` 或 `localhost`。没有对外网络监听和跨域放行。

信号输入示例（仅演示格式，不代表真实事件）：

```json
{
  "id": "replace-with-post-id",
  "title": "Replace with an accurate summary",
  "kind": "hint",
  "scope": "unknown",
  "occurredAt": "2026-10-07T08:00:00Z",
  "resetAt": null,
  "sourceUrl": "https://example.com/original-source",
  "evidence": "Replace with verifiable evidence"
}
```

## 外部连接

Codex 使用官方 `initialize → initialized → account/read → account/rateLimits/read` 流程，子进程结束后清理进程树。原始身份字段不持久化，账号关联使用本地哈希。未登录或 API-key 模式不返回虚构额度。

可选 X 源只向 `api.x.com` 发出 bearer-auth 请求；它不会把令牌传入 Codex 子进程。社区源固定为 `codex.gussuriworks.com/api/current`，检查 schema、概率范围和时间有效性；没有任意 URL 代理接口。
