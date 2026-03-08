---
status: pending
priority: p2
issue_id: "002"
tags: [code-review, architecture, minio, sync]
dependencies: []
---

# User 类型模块不会写入 MinIO manifest

## Problem Statement

MinIO 清单现在只为 `tweet` capture 生成记录，所有 `user` 类型模块都会被静默跳过。结果是 `FollowersModule`、`FollowingModule`、`ListMembersModule` 这类数据即使已经写入 payload，也不会进入模块 manifest，Obsidian 读取端无法发现这些新增内容。

## Findings

- [`src/core/sync/sync-manager.ts`](/Users/xiaohansong/projects/twitter-web-exporter/src/core/sync/sync-manager.ts#L585) 对非 `tweet` capture 直接 `continue`。
- [`src/core/database/manager.ts`](/Users/xiaohansong/projects/twitter-web-exporter/src/core/database/manager.ts#L147) 明确会把用户类采集写成 `type: ExtensionType.USER` 的 capture。
- 当前 MinIO 方案是“manifest 是唯一可信来源”，因此 payload 里存在但 manifest 里缺失的用户模块，等价于对下游完全不可见。
- 这不是边角场景，而是整个用户类模块都会失效。

## Proposed Solutions

### Option 1: 为 user capture 增加独立 manifest record 结构

**Approach:** 扩展协议，让 manifest 同时支持 `tweet` 和 `user` 两种记录，并在 Obsidian 端按类型分流渲染。

**Pros:**
- 语义完整，覆盖全部模块
- 与“manifest 是唯一可信来源”的设计一致

**Cons:**
- 需要同步修改读取端协议和测试
- 会扩大当前数据模型

**Effort:** 0.5-1 天

**Risk:** Medium

---

### Option 2: 显式限制 MinIO 后端只支持 tweet 模块

**Approach:** 在 UI、文档和代码里把 user 模块排除掉，遇到 user capture 时明确告警而不是静默跳过。

**Pros:**
- 改动小
- 至少避免“看起来成功，实际缺数据”

**Cons:**
- 与“整个存储后端改成 MinIO”的目标不一致
- 功能范围明显缩水

**Effort:** 2-3 小时

**Risk:** Low

## Recommended Action

## Technical Details

**Affected files:**
- [`src/core/sync/sync-manager.ts`](/Users/xiaohansong/projects/twitter-web-exporter/src/core/sync/sync-manager.ts)
- [`src/core/database/manager.ts`](/Users/xiaohansong/projects/twitter-web-exporter/src/core/database/manager.ts)

**Related components:**
- MinIO manifest protocol
- Obsidian manifest reader

**Database changes (if any):**
- No

## Resources

- **Branch:** `codex/feat-minio-incremental-sync-backend`

## Acceptance Criteria

- [ ] 明确支持或明确禁止 `user` 类型模块
- [ ] 如果支持，manifest 协议和读取端都能覆盖 `user` capture
- [ ] 如果不支持，UI/日志/文档能明确暴露这个限制
- [ ] 至少有一条 user 模块的集成测试覆盖

## Work Log

### 2026-03-07 - Code Review

**By:** Codex

**Actions:**
- 审查 manifest 生成逻辑
- 对照本地 Dexie 写入逻辑确认存在 `USER` capture
- 评估对 Obsidian 增量消费的影响

**Learnings:**
- 当前实现不是“暂时未做渲染”，而是根本没把 user 模块暴露到协议层

## Notes

- 如果后续真要支持纯 MinIO 全量替代，这项不能跳过。
