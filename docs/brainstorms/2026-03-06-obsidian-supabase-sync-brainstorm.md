---
date: 2026-03-06
topic: obsidian-supabase-sync
---

# Obsidian Supabase Sync

## What We're Building
为 Twitter 数据链路增加第二段消费端：单独创建一个 Obsidian 插件仓库，由插件直接连接 Supabase，把推文同步到指定 Vault 目录。

同步范围聚焦为最小可用版本：
- 插件运行在 Obsidian 中，不放在当前 `twitter-web-exporter` 仓库里
- 数据来源为当前仓库已写入 Supabase 的同步表
- 目录按抓取模块拆分，例如 `bookmarks/`、`likes/`、`user-tweets/`
- 每条推文生成一个 Markdown 文件
- 同一条推文可以在多个模块目录中各写一份
- 插件启动后按固定间隔轮询 Supabase
- Obsidian 侧采用 append-only 语义：只新增，不覆盖，不删除

## Why This Approach
我们比较了“独立 Node 脚本”“Obsidian 插件”“仅协议/文档先行”几种方向，最终选择独立仓库的 Obsidian 插件，因为它最贴近使用场景：数据进入 Supabase 后，直接在用户使用中的 Vault 内可见，不需要额外守护进程。

在插件实现上，选择“直连 Supabase + 轮询拉取 + 单条 Markdown 文件”的 MVP，而不是 Realtime、后端中转或复杂索引体系，原因是：
- 与现有 Supabase 同步架构最兼容
- 实现复杂度最低，便于先验证信息架构
- append-only 规则清晰，避免本地状态回收和误删问题

## Key Decisions
- 插件形态：独立 Obsidian 插件仓库
  - 理由：与 `twitter-web-exporter` 解耦，职责边界清楚。

- 数据读取方式：插件直连 Supabase
  - 理由：MVP 不引入额外中间层，直接复用现有云端数据。

- 目录结构：按抓取模块分文件夹
  - 理由：符合你的使用习惯，浏览时能直接按来源查看。

- 文件粒度：每条推文一个 Markdown 文件
  - 理由：增量写入、去重判断、后续引用都更直接。

- 重复策略：允许同一推文在多个模块目录中重复落盘
  - 理由：模块语义优先，不为去重引入额外链接层。

- 触发方式：插件启动后固定间隔轮询
  - 理由：比 Realtime 更稳，插件实现和排障都更简单。

- 本地同步语义：append-only
  - 理由：只新增，不覆盖，不删除，最大化避免误改已有笔记。

## Resolved Questions
- 插件运行位置：Obsidian 插件，而不是独立 Node 脚本。
- 仓库边界：单独新建 Obsidian 插件仓库。
- 模块定义：按抓取模块分目录。
- 多模块重复：允许每个模块各写一份。
- 触发方式：固定间隔轮询 Supabase。
- 文件格式：每条推文一个 Markdown 文件。
- 本地文件策略：只追加，不覆盖，不删除。
- 推荐实现路线：插件直连 Supabase。

## Open Questions
- 暂无。

## Next Steps
-> 进入 `/prompts:workflows-plan`，输出实施计划，重点覆盖：
- 插件配置项与 Vault 目录约定
- Supabase 查询模型与模块映射
- Markdown 文件命名与 frontmatter 结构
- 插件本地同步游标设计
- 首次同步、增量同步、失败恢复的验证方案
