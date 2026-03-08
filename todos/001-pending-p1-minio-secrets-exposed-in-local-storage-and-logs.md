---
status: pending
priority: p1
issue_id: "001"
tags: [code-review, security, minio, frontend]
dependencies: []
---

# MinIO 密钥暴露在 localStorage 和日志中

## Problem Statement

新增的 MinIO 后端把 `accessKeyId` 和 `secretAccessKey` 直接持久化到浏览器 `localStorage`，并且在加载/保存配置时整对象打到日志里。对 userscript 来说，这意味着任意同源脚本、浏览器扩展、导出的日志或用户截图，都可能泄露长期有效的 MinIO 写权限。

## Findings

- [`src/core/settings.tsx`](/Users/xiaohansong/projects/twitter-web-exporter/src/core/settings.tsx#L323) 允许用户直接输入长期 `MinIO Secret Access Key`。
- [`src/core/options/manager.ts`](/Users/xiaohansong/projects/twitter-web-exporter/src/core/options/manager.ts#L107) 从 `localStorage` 读取完整配置。
- [`src/core/options/manager.ts`](/Users/xiaohansong/projects/twitter-web-exporter/src/core/options/manager.ts#L144) 把完整 `appOptions` 原样写回 `localStorage`。
- [`src/core/options/manager.ts`](/Users/xiaohansong/projects/twitter-web-exporter/src/core/options/manager.ts#L125) 和 [`src/core/options/manager.ts`](/Users/xiaohansong/projects/twitter-web-exporter/src/core/options/manager.ts#L147) 会把包含敏感字段的配置对象写入日志。
- 这不是理论风险。当前 MinIO 权限模型允许直接写 bucket，对象覆盖和清单污染都会受到影响。

## Proposed Solutions

### Option 1: 改为短期凭证或签名代理

**Approach:** 不在浏览器保存长期密钥；改为通过受控后端发放短期凭证或预签名 URL。

**Pros:**
- 从根上消除长期写密钥暴露
- 更容易撤销和审计

**Cons:**
- 需要引入额外后端或代理服务
- 实现成本最高

**Effort:** 1-2 天

**Risk:** Low

---

### Option 2: 至少停止持久化和日志输出敏感字段

**Approach:** `secretAccessKey` 只保存在内存中，reload 后要求重新输入；日志中对所有敏感字段做脱敏。

**Pros:**
- 改动较小，能立刻降低暴露面
- 不需要改变现有 MinIO 协议

**Cons:**
- 仍然需要用户重复输入密钥
- 不能防止运行时内存中的凭证被其它脚本读取

**Effort:** 2-4 小时

**Risk:** Medium

---

### Option 3: 使用浏览器安全存储或 userscript 专用 secret 存储

**Approach:** 如果运行环境支持，改用比 `localStorage` 更封闭的存储，并统一做日志脱敏。

**Pros:**
- 比直接写 `localStorage` 更安全
- UX 优于纯内存

**Cons:**
- 仍然不如短期凭证安全
- 依赖运行环境能力

**Effort:** 4-8 小时

**Risk:** Medium

## Recommended Action

## Technical Details

**Affected files:**
- [`src/core/settings.tsx`](/Users/xiaohansong/projects/twitter-web-exporter/src/core/settings.tsx)
- [`src/core/options/manager.ts`](/Users/xiaohansong/projects/twitter-web-exporter/src/core/options/manager.ts)

**Related components:**
- MinIO settings UI
- Global options persistence
- Debug/info logging

**Database changes (if any):**
- No

## Resources

- **Branch:** `codex/feat-minio-incremental-sync-backend`
- **Related files:** [`src/core/sync/minio-client.ts`](/Users/xiaohansong/projects/twitter-web-exporter/src/core/sync/minio-client.ts)

## Acceptance Criteria

- [ ] `secretAccessKey` 不再以明文形式写入 `localStorage`
- [ ] `accessKeyId` / `secretAccessKey` 不再出现在 info/debug 日志里
- [ ] 刷新页面后的凭证行为有清晰约定并经过验证
- [ ] 文档明确说明当前凭证模型和风险边界

## Work Log

### 2026-03-07 - Code Review

**By:** Codex

**Actions:**
- 审查了 MinIO 配置存储与日志链路
- 确认敏感字段经由 `options.set()` 进入 `localStorage`
- 确认加载和保存配置时完整对象会被日志输出

**Learnings:**
- 当前实现把“可直接写对象存储的长期密钥”当作普通 UI 配置处理
- 这类风险在 userscript 场景下比服务端更高

## Notes

- 如果产品坚持使用长期凭证，至少也要先完成 Option 2。
