---
date: 2026-02-22
topic: supabase-incremental-sync
---

# Supabase 增量同步（定时批量）

## What We're Building
为 twitter-web-exporter 增加“自动同步到 Supabase”的能力：在浏览器端以固定周期执行增量同步，把本地 IndexedDB 中的 `tweets`、`users`、`captures` 推送到 Supabase。

同步目标是“稳定可用的最小方案”：
- 不改变现有本地导出能力（JSON/CSV/HTML 继续可用）
- 增量依据为 `tweets/users.twe_private_fields.updated_at`
- 每 15 分钟执行一次
- 仅做新增/更新，不做删除

## Why This Approach
我们比较了“导出时同步 / 定时批量 / 近实时”三种路径，选择“定时批量同步”，原因是：
- 比“导出时同步”自动化更强
- 比“近实时同步”更稳、更容易排障
- 与当前项目“浏览器本地优先”的架构兼容性更好

认证和安全上选择浏览器直连 Supabase（`anon key` + RLS），避免引入额外后端。为保证可恢复性，同步游标落在 Supabase 的 `sync_states` 表，而不是本地存储。

## Key Decisions
- 同步模式：定时批量同步（每 15 分钟）
  - 理由：实时性与稳定性平衡，避免高频触发。

- 增量基准：`tweets/users.twe_private_fields.updated_at`
  - 理由：直接反映本地记录最近更新时间，便于增量扫描。

- 认证模型：浏览器直连 Supabase（`anon key` + RLS）
  - 理由：实现成本最低，不引入中转服务。

- 同步范围：`tweets`、`users`、`captures`
  - 理由：除实体数据外，还保留模块来源与抓取顺序语义。

- 游标存储：Supabase `sync_states` 表
  - 理由：跨设备可恢复，不依赖本地浏览器状态。

- 失败策略：单轮最多 3 次指数退避重试
  - 理由：提升成功率，避免无限重试导致阻塞。

- 删除策略：仅新增/更新，不删除云端
  - 理由：降低误删风险，先保证数据安全。

- 账号隔离：`twitter_user_id` 参与唯一约束
  - 理由：支持多账号隔离，避免跨账号数据污染。

- 分批策略：固定 500 条/批
  - 理由：兼顾吞吐和请求稳定性，减少超时/失败概率。

## Resolved Questions
- 是否做近实时同步：否，采用定时批量。
- 增量来源字段：使用 `updated_at`，不使用 `captures.created_at`。
- 是否要求登录：当前阶段不要求，使用 `anon key` + RLS。
- 游标存储位置：放 Supabase，不放 localStorage。
- 是否同步 `captures`：是。
- 是否同步删除：否。
- 批大小：500。
- RLS 约束方案：仅用 `twitter_user_id` 做写入约束（MVP）。

## Open Questions
- 暂无。

## Next Steps
→ 进入 `/prompts:workflows-plan`，输出实施计划（表结构、RLS、前端配置、同步循环、错误处理、验证用例）。
