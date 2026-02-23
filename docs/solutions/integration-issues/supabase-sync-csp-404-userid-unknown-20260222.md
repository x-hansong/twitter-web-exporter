---
module: System
date: 2026-02-22
problem_type: integration_issue
component: tooling
symptoms:
  - "Userscript runtime log: Sync skipped: twitter user id is unknown"
  - "x.com 页面报 CSP 拦截，无法请求 Supabase REST"
  - "直连 PostgREST 出现 GET 200 但 POST/UPSERT 404 {}"
  - "新增 view_payload 后历史数据为空，需要全量回填"
root_cause: config_error
resolution_type: code_fix
severity: high
tags: [supabase, userscript, csp, postgrest, sync, tampermonkey]
---

# Supabase 同步在 Userscript 场景下失败（CSP + REST 404 + user id unknown）

## 问题现象
在 Twitter Web Exporter 增加 Supabase 自动同步后，出现多重失败链路：

1. 同步直接跳过：`Sync skipped: twitter user id is unknown`
2. 页面控制台报 CSP：`Refused to connect ... violates Content Security Policy`
3. 自部署 PostgREST 表现异常：`GET /sync_states` 返回 200，但 `POST/UPSERT` 返回 `404 {}`
4. 新增 `view_payload` 字段后，旧数据不会自动回填

## 影响范围
- 影响模块：同步模块（`src/core/sync/*`）、数据库管理（`src/core/database/manager.ts`）、userscript 元数据（`vite.config.ts`）
- 影响用户：开启 Supabase 同步的全部用户，尤其是自部署 Supabase 和 x.com 强 CSP 场景
- 业务影响：数据无法落库、游标不推进、新字段长期为空

## 调查过程（关键排障路径）

### 1) 环境与连通性排查
- 验证 `SUPABASE_URL/SUPABASE_API_KEY` 在 `zsh -lic` 下可读。
- 验证 Auth/REST 健康：`/auth/v1/health` 与 `/rest/v1/` 可访问。
- 通过 `supabase-js` 读 `sync_states`：可读但早期写失败。

### 2) 区分 DB 层 vs REST 层
- SQL Editor 中 `set local role anon; insert ... on conflict ...` 成功。
- 直连 PostgREST 仍 `POST 404 {}`，确认不是 RLS/GRANT 本身，而是 REST 进程配置/缓存侧问题。

### 3) 自部署配置定位
- 检查 rest 配置发现 `PGRST_DB_CHANNEL_ENABLED=false`。
- 重启 `rest` 服务后，`POST /sync_states` 恢复 `201 Created`。

### 4) Userscript CSP 定位
- x.com 拒绝页面上下文直接 `fetch` 目标域名。
- userscript 头未声明 `@connect`，导致跨域能力不足。

### 5) user id unknown 根因
- 同步启动早于 `__META_DATA__.userId` 稳定可用时机。
- 早期实现对 userId 获取过于脆弱，导致长期 `unknown`。

## 最终修复

### A. 同步与数据模型实现
- 新增同步管理器与 Supabase 客户端：
  - `src/core/sync/sync-manager.ts`
  - `src/core/sync/supabase-client.ts`
  - `src/core/sync/types.ts`
  - `src/core/sync/index.ts`
- 应用启动接入同步调度：`src/main.tsx`
- 新增 `view_payload`（推文导出视图）落库逻辑：
  - `src/core/sync/tweet-view.ts`
  - `src/core/sync/sync-manager.ts`

### B. Userscript 跨域与 CSP 修复
- userscript 元数据增加：
  - `@connect` 白名单（含 `stormfire.heiyu.space`）
  - `GM_xmlhttpRequest` grant
- 位置：`vite.config.ts`
- Supabase 客户端优先走 `GM_xmlhttpRequest`，绕过页面 CSP，失败时回退原生 `fetch`。

### C. user id 获取稳健性修复
- `src/core/database/manager.ts`
  - `getCurrentUserId()` 改为运行时动态解析
  - 回退链路：`__META_DATA__.userId -> cookie(twid)`
  - 增加 `decodeURIComponent` 安全解码，避免 cookie 异常导致同步流程中断
  - 移除 `userHash` 作为同步键，防止同账号数据分裂

### D. 同步触发策略修复
- `src/core/sync/sync-manager.ts`
  - 由“任意 options 变更触发”改为“边沿触发”：
    - `syncEnabled` 从 false -> true
    - 配置从不完整 -> 完整
  - 避免用户输入 URL/key 过程中的无效触发与噪音日志

### E. Supabase 初始化与迁移
- 新增/更新 SQL：`docs/supabase-sync-setup.sql`
  - 建表、索引、RLS、兼容 `view_payload` 增列语句

## 关键验证命令

```bash
# 构建验证
bun run build

# 针对核心变更文件 lint 验证
bunx eslint src/core/database/manager.ts src/core/sync/sync-manager.ts src/core/sync/supabase-client.ts
```

```sql
-- 验证同步游标
select twitter_user_id, last_synced_at, last_success_at, last_error
from public.sync_states
order by updated_at desc
limit 20;

-- 验证 view_payload 回填情况
select
  count(*) as total,
  count(*) filter (where view_payload is null or view_payload = '{}'::jsonb) as empty_view
from public.synced_tweets
where twitter_user_id = '<UID>';
```

## 回填策略（解决旧数据 view_payload 为空）
若已存在历史同步数据，需按账号重置并全量重导：

```sql
delete from public.synced_captures where twitter_user_id = '<UID>';
delete from public.synced_tweets   where twitter_user_id = '<UID>';
delete from public.synced_users    where twitter_user_id = '<UID>';
delete from public.sync_states     where twitter_user_id = '<UID>';
```

然后在页面点击 `Sync Now`，触发全量重同步。

## 预防策略
1. **自部署 PostgREST**：建议启用 `PGRST_DB_CHANNEL_ENABLED=true`，避免 schema/权限变更后缓存失效。
2. **Userscript 网络访问**：外部域名访问必须在元数据中声明 `@connect`，并优先使用 `GM_xmlhttpRequest`。
3. **同步键稳定性**：`twitter_user_id` 必须来源稳定，避免临时哈希键造成数据分裂。
4. **触发去抖**：同步只在“启用或配置就绪”时触发一次，避免配置输入过程噪音请求。
5. **新增列策略**：对已存在数据的派生字段（如 `view_payload`）必须提供“重跑/回填”路径。

## 相关文件
- `src/core/database/manager.ts`
- `src/core/sync/sync-manager.ts`
- `src/core/sync/supabase-client.ts`
- `src/core/sync/tweet-view.ts`
- `src/core/options/manager.ts`
- `src/core/settings.tsx`
- `src/main.tsx`
- `vite.config.ts`
- `docs/supabase-sync-setup.sql`
