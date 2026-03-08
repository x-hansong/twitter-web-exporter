---
status: pending
priority: p2
issue_id: "003"
tags: [code-review, performance, minio, sync]
dependencies: []
---

# Manifest 每次增量同步都要整文件读回并重写

## Problem Statement

当前 manifest 合并策略会在每次同步时下载完整 JSONL、解析全部历史记录、去重后再把整个文件重新上传。这对 append-only 清单来说会让单次同步成本随历史长度线性增长，数据量上来后会显著拖慢同步，并增加大对象覆盖失败导致的重试成本。

## Findings

- [`src/core/sync/sync-manager.ts`](/Users/xiaohansong/projects/twitter-web-exporter/src/core/sync/sync-manager.ts#L615) 每次都 `getText(manifestKey)` 取回完整 manifest。
- [`src/core/sync/sync-manager.ts`](/Users/xiaohansong/projects/twitter-web-exporter/src/core/sync/sync-manager.ts#L617) 会把整个 JSONL 重新解析成内存数组。
- [`src/core/sync/sync-manager.ts`](/Users/xiaohansong/projects/twitter-web-exporter/src/core/sync/sync-manager.ts#L626) 最终重新拼接全部历史行并整文件覆盖上传。
- 这意味着首次几千条记录还可接受，但长期运行后每次“只新增几条”也要处理整个历史文件。

## Proposed Solutions

### Option 1: 拆分为分片 manifest

**Approach:** 按日期、批次或 cursor 把 manifest 切成多个 JSONL 对象，再由 state 记录最新分片。

**Pros:**
- 最符合对象存储特性
- 同步成本随单次增量而不是全历史增长

**Cons:**
- 读取端协议会更复杂
- 需要迁移策略

**Effort:** 1-2 天

**Risk:** Medium

---

### Option 2: 追加写临时增量文件，再由后台合并

**Approach:** 前端只写新的 delta manifest，对主 manifest 的归并交给异步任务。

**Pros:**
- 写入路径快
- 失败隔离更好

**Cons:**
- 需要额外合并机制
- 最终一致性更复杂

**Effort:** 1 天

**Risk:** Medium

---

### Option 3: 保留单文件，但建立硬上限和监控

**Approach:** 短期不改协议，只在文档里设定规模上限并增加性能日志。

**Pros:**
- 改动最小
- 能先验证真实数据量

**Cons:**
- 只是延后问题
- 不能解决大历史用户的退化

**Effort:** 2-3 小时

**Risk:** High

## Recommended Action

## Technical Details

**Affected files:**
- [`src/core/sync/sync-manager.ts`](/Users/xiaohansong/projects/twitter-web-exporter/src/core/sync/sync-manager.ts)

**Related components:**
- MinIO manifest protocol
- Retry / startup sync latency

**Database changes (if any):**
- No

## Resources

- **Branch:** `codex/feat-minio-incremental-sync-backend`

## Acceptance Criteria

- [ ] 明确 manifest 的增长策略，不再每次整文件重写全部历史
- [ ] 大历史数据下同步时间有可接受上限
- [ ] 对 manifest 合并路径有性能日志或测试
- [ ] 文档说明对象布局和扩展边界

## Work Log

### 2026-03-07 - Code Review

**By:** Codex

**Actions:**
- 审查 manifest 读写实现
- 评估对象存储下 append-only JSONL 的长期成本
- 对照当前启动时全量同步的实测表现判断扩展性风险

**Learnings:**
- 当前启动慢的问题不只来自 payload 串行上传，manifest 合并路径后续也会成为瓶颈

## Notes

- 这是典型的“功能能跑，但协议不够对象存储友好”的问题。
