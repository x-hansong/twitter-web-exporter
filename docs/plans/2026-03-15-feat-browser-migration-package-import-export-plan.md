---
title: feat: Add Browser Migration Package Import Export
type: feat
status: completed
date: 2026-03-15
origin: docs/brainstorms/2026-03-14-browser-migration-import-export-brainstorm.md
---

# feat: Add Browser Migration Package Import Export

## Overview
为 `twitter-web-exporter` 增加一个面向“浏览器 A -> 浏览器 B”迁移场景的本地迁移能力：用户可以导出一个单文件迁移包，其中同时包含本地数据库和完整配置；在另一浏览器中导入该文件后，当前浏览器的数据库与配置会被整体覆盖恢复。

本计划完全继承 brainstorm 已确认的需求边界，不扩展成“分离式数据库/配置导入导出”，也不引入云端中转或账号绑定流程（see brainstorm: `docs/brainstorms/2026-03-14-browser-migration-import-export-brainstorm.md`）。

## Problem Statement / Motivation
当前仓库已经具备以下零散能力：

- 设置页支持导出本地数据库，但没有导入入口
- 数据库底层已经有 Dexie `export()` / `import()` 能力
- 所有应用配置都已通过 `AppOptionsManager` 保存在 `localStorage`

这意味着“迁移”所需的数据面其实都已存在，但用户仍然需要手工处理多个存储位置，无法完成真正的一键迁移。对于需要在 Chrome、Arc、Firefox 等浏览器之间切换的用户来说，缺少这个能力会导致：

- 本地采集历史无法直接迁移
- 主题、模块开关、同步配置和凭证需要重新填写
- 切换浏览器后环境恢复成本高，容易遗漏敏感配置

## Proposed Solution

### 方案摘要
新增一个“迁移包”模型，作为数据库与配置的统一导出导入载体：

- 导出时：
  - 读取当前数据库快照
  - 读取当前完整配置快照
  - 包装为一个带版本信息的 JSON 迁移文件
  - 使用现有下载能力保存到本地

- 导入时：
  - 用户选择迁移文件
  - 系统校验文件结构与版本
  - 显示强提醒，要求用户二次确认
  - 先清空当前本地数据库，再导入文件中的数据库快照
  - 用迁移文件中的配置快照整体替换当前配置
  - 完成后刷新运行态，让 UI 与后续同步逻辑都基于新状态运行

### 迁移包建议结构
建议迁移文件是一个 JSON 文档，而不是 zip。原因是当前数据库导出结果本身已是 JSON Blob，配置也天然是 JSON，对 MVP 来说最简单、最可检查、最便于后续版本迁移。

```ts
interface MigrationPackageV1 {
  version: 1;
  exportedAt: string;
  appVersion: string;
  database: BlobLikeJson;
  options: AppOptions;
}
```

其中：
- `version` 用于未来迁移包协议演进
- `exportedAt` 用于用户提示和排障
- `appVersion` 用于兼容性日志和问题定位
- `database` 为当前 Dexie 导出内容
- `options` 为完整配置快照（see brainstorm: `docs/brainstorms/2026-03-14-browser-migration-import-export-brainstorm.md`）

### 设置页交互
继续沿用 [src/core/settings.tsx](/Users/xiaohansong/projects/twitter-web-exporter/src/core/settings.tsx) 中“本地数据库”区块作为入口，不额外创造新的主导航。

建议将该区块从“数据库操作”提升为“本地数据 / 迁移操作”，保留现有 `Analyze DB`、`Export DB`、`Clear DB`，并增加：

- `Export Migration`
- `Import Migration`

首版仍可保留旧的 `Export DB`，因为它对排障仍有价值；但计划中的主交互和 README 文案应围绕迁移包，而不是让用户自己拼数据库和配置。

## Technical Considerations

- 数据来源
  - 数据库当前由 `DatabaseManager.export()` / `import()` 提供原生能力，位于 [src/core/database/manager.ts](/Users/xiaohansong/projects/twitter-web-exporter/src/core/database/manager.ts#L182)。
  - 配置当前由 `AppOptionsManager` 持久化到 `localStorage`，位于 [src/core/options/manager.ts](/Users/xiaohansong/projects/twitter-web-exporter/src/core/options/manager.ts#L110) 与 [src/core/options/manager.ts](/Users/xiaohansong/projects/twitter-web-exporter/src/core/options/manager.ts#L138)。

- 配置范围
  - 必须包含完整配置快照，而不是只导出“安全字段”或“用户可见字段”（see brainstorm: `docs/brainstorms/2026-03-14-browser-migration-import-export-brainstorm.md`）。
  - 这意味着 Supabase、MinIO、token、模块禁用列表、语言、主题、批量抓取参数等全部进入迁移文件。

- 覆盖语义
  - 导入必须是“整体覆盖当前数据库和配置”，不能做字段级合并（see brainstorm）。
  - 因此导入动作前必须有强提醒和二次确认。

- 文件格式与版本
  - 迁移包需要自己的 `version`，不要直接把 `package.json.version` 当协议版本。
  - `options.version` 仍由现有保存逻辑维护，可作为 app 版本信息的一部分，但不能代替迁移协议版本。

- 运行态刷新
  - 仅写入 `localStorage` 不一定足以让当前页面上的信号、同步状态、主题、语言都立即一致。
  - 计划应明确导入后需要统一的“应用状态重载”路径，避免出现“存储已替换，但当前单例仍持有旧内存值”的半切换状态。

- 多账号数据库
  - 现有数据库名会受 `dedicatedDbForAccounts` 和 `userId` 影响（[src/core/database/manager.ts](/Users/xiaohansong/projects/twitter-web-exporter/src/core/database/manager.ts#L30)）。
  - 迁移设计必须明确：导入发生在“当前运行中的数据库实例”上，而不是尝试枚举所有本地数据库。
  - 首版按当前运行实例导入，保持范围最小；不设计“批量导入所有账号数据库”。

- 同步副作用
  - 配置导入后可能立即改变 `syncEnabled`、后端类型和密钥。
  - 现有 `SyncManager` 会监听 options 变化并在特定边沿触发同步（[src/core/sync/sync-manager.ts](/Users/xiaohansong/projects/twitter-web-exporter/src/core/sync/sync-manager.ts#L75)）。
  - 实施时必须避免“导入中途配置半写入就触发同步”的副作用。

## System-Wide Impact

- **Interaction graph**
  - 用户在 [src/core/settings.tsx](/Users/xiaohansong/projects/twitter-web-exporter/src/core/settings.tsx#L166) 的本地区块点击导出或导入迁移包。
  - 导出路径会调用数据库导出能力、配置快照能力，再通过 [src/utils/exporter.ts](/Users/xiaohansong/projects/twitter-web-exporter/src/utils/exporter.ts#L27) 保存文件。
  - 导入路径会读取文件、校验协议、确认覆盖、清空数据库、导入数据库、替换配置，再触发应用级刷新。

- **Error propagation**
  - 文件格式不合法、JSON 解析失败、数据库导入失败、版本不兼容都必须在设置层可见，而不是仅写日志。
  - 若数据库导入失败，必须阻止继续写配置，避免用户进入“数据库旧 / 配置新”的混合状态。

- **State lifecycle risks**
  - “先写配置后导入数据库”会导致同步、主题、语言等监听逻辑提前响应，应避免。
  - “数据库已清空但导入失败”会造成数据丢失风险。计划中至少要有“校验通过后再清空”的顺序约束，并明确失败文案。
  - 导入后若不刷新内存单例，`options`、`db`、`syncManager` 可能继续运行在旧状态。

- **API surface parity**
  - 当前设置页已有 `Analyze DB` / `Export DB` / `Clear DB` 风格，这次应沿用同一操作模型。
  - 若未来真的需要“配置单独导入导出”或“数据库单独导入导出”，应该建立在同一迁移服务层之上，而不是把逻辑写死在设置组件中。

- **Integration test scenarios**
  - 导出迁移包后，在同一浏览器导入，能恢复数据库计数和配置值。
  - 导入损坏文件时，不会清空现有数据库，也不会覆盖配置。
  - 导入成功后，主题、语言、同步配置与模块开关能反映迁移结果。
  - 当迁移包中启用同步时，导入完成不会在半状态下误触发同步。

## SpecFlow Analysis

### 核心用户流
1. 用户打开设置面板，进入本地数据库/迁移区域。
2. 用户点击 `Export Migration`。
3. 系统读取当前数据库和完整配置，生成单个迁移文件并下载。
4. 用户在另一浏览器安装脚本后，点击 `Import Migration`。
5. 用户选择本地迁移文件。
6. 系统先做结构和版本校验。
7. 系统展示“将覆盖当前数据库和配置”的强提醒。
8. 用户二次确认后，系统执行导入。
9. 导入完成后，系统提示成功，并刷新应用状态。

### 关键分支与补全
- 若用户取消选择文件，导入流程应无副作用结束。
- 若文件不是合法 JSON 或缺少必填字段，应直接阻止导入。
- 若迁移包版本过高或结构不兼容，应阻止导入并给出版本提示。
- 若导入过程中数据库失败，则不能继续写配置。
- 若配置写入成功但运行态未刷新，UI 可能与真实存储不一致，因此必须定义明确的 reload 策略。
- 若导入文件中的同步配置启用了 Supabase/MinIO，但当前网络不可用，不应阻塞迁移成功提示；同步失败应由后续正常同步链路处理。

### 默认假设
- MVP 只支持当前脚本版本认识的迁移包 `version: 1`。
- MVP 不做跨多个本地 Dexie 数据库的批量迁移。
- MVP 不做迁移包加密；通过文案明确“文件包含敏感配置”。
- MVP 不提供导入预览页面，只提供结构校验 + 强提醒 + 二次确认（see brainstorm）。

## Acceptance Criteria

- [x] 设置面板新增迁移包导出入口，能生成单个文件，包含数据库与完整配置（see brainstorm: `docs/brainstorms/2026-03-14-browser-migration-import-export-brainstorm.md`）。
- [x] 设置面板新增迁移包导入入口，支持用户选择本地文件并执行导入。
- [x] 迁移包具有独立协议版本字段，且导出时包含 `exportedAt` 与 `appVersion`。
- [x] 导入前会先做文件解析与结构校验；校验失败时不会清空数据库，也不会覆盖配置。
- [x] 导入前必须展示明确的危险提示，并要求用户二次确认（see brainstorm）。
- [x] 导入成功后，当前浏览器的数据库与配置会被整体替换，不做合并（see brainstorm）。
- [x] 迁移包中的配置包含敏感同步配置和 token，不做删减（see brainstorm）。
- [x] 导入流程不会在“配置写了一半”时触发同步副作用；同步只会在导入完成后的稳定状态下恢复。
- [x] 导入完成后，UI 运行态能与新配置一致，至少覆盖主题、语言、模块开关和同步开关。
- [x] 至少完成一次本地构建验证，并补充与迁移相关核心文件的 lint 检查。

## Success Metrics

- 用户可以只依赖一个文件完成浏览器迁移，不需要额外手工复制配置。
- 损坏文件或不兼容文件不会破坏当前已有本地数据。
- 导入成功后，设置页和后续功能表现与来源浏览器基本一致。
- 不破坏现有导出数据、导出媒体、同步、批量辅助抓取等既有功能。

## Dependencies & Risks

- 依赖现有 Dexie 导出格式在同版本仓库内可稳定回读。
- 依赖 `AppOptionsManager` 作为唯一配置存储入口，避免出现配置散落在多个 key 中。
- 风险：迁移包包含敏感信息，若用户随意传播文件，会放大凭证泄露风险。
- 风险：数据库导入不是事务性“整体替换”，一旦清空后导入失败，恢复只能依赖原始迁移文件重试。
- 风险：当前单例对象在导入后若不重建，可能继续引用旧状态。
- 风险：`dedicatedDbForAccounts` 语义会让用户误以为迁移包包含“所有账号数据库”；首版必须在文案中明确范围。

## Implementation Phases

### Phase 1: Migration Service Foundation
- 新增统一的迁移包服务层，建议放在 `src/core/migration/` 或 `src/core/transfer/`，负责：
  - 迁移包类型定义
  - 导出组装
  - 导入校验
  - 导入执行编排
- 不把协议拼装逻辑直接写进设置组件。
- 明确单一常量：`MIGRATION_PACKAGE_VERSION = 1`。

### Phase 2: Options Snapshot and Restore
- 为 `AppOptionsManager` 增加“读完整快照 / 用完整快照替换”的显式接口，而不是让调用方直接操作 `localStorage`。
- restore 路径应复用现有默认值与版本补全逻辑，避免导入后出现字段缺失。
- 需要考虑导入期间抑制信号或延迟副作用，避免 `SyncManager` 在半状态下响应。

### Phase 3: Database Import Orchestration
- 在数据库层保留现有 `export()` / `import()` 能力。
- 增加更清晰的导入编排语义，例如：
  - `validateImportPackage`
  - `replaceCurrentDatabaseFromBlob`
- 导入顺序建议：
  1. 读取并校验迁移文件
  2. 解析数据库部分与配置部分
  3. 用户确认
  4. 清空当前数据库
  5. 导入数据库
  6. 替换配置
  7. 触发应用重载

### Phase 4: Settings UI
- 在 [src/core/settings.tsx](/Users/xiaohansong/projects/twitter-web-exporter/src/core/settings.tsx) 新增两个按钮：
  - `Export Migration`
  - `Import Migration`
- `Import Migration` 需要隐藏 file input 或等价交互，不要求额外页面。
- 强提醒至少应明确三件事：
  - 会覆盖当前数据库
  - 会覆盖当前配置
  - 文件包含敏感信息

### Phase 5: Hardening and Documentation
- 更新 [README.md](/Users/xiaohansong/projects/twitter-web-exporter/README.md) 与 [docs/README.zh-Hans.md](/Users/xiaohansong/projects/twitter-web-exporter/docs/README.zh-Hans.md)：
  - 增加迁移包说明
  - 明确文件包含敏感配置
  - 明确导入是覆盖语义
  - 说明该功能主要面向浏览器迁移
- 为失败态补充用户可见错误文案和日志。

## Alternative Approaches Considered

- 数据库与配置分别导入导出
  - 未采用。它更灵活，但偏离本次“浏览器迁移”主场景，且会增加操作复杂度（see brainstorm: `docs/brainstorms/2026-03-14-browser-migration-import-export-brainstorm.md`）。

- 同时提供一键迁移和高级分离入口
  - 未采用。长期可能值得做，但首版没有必要把产品面做宽（see brainstorm）。

- 使用 zip 或二进制包格式
  - 未采用。当前数据天然适合 JSON，MVP 没必要引入额外封装复杂度。

## Documentation Plan

- 更新 [README.md](/Users/xiaohansong/projects/twitter-web-exporter/README.md)：
  - 在设置功能或 FAQ 中说明浏览器迁移能力
  - 明确迁移文件包含数据库和完整配置
  - 明确文件包含敏感配置，需自行妥善保管

- 更新 [docs/README.zh-Hans.md](/Users/xiaohansong/projects/twitter-web-exporter/docs/README.zh-Hans.md)：
  - 补充中文使用说明
  - 增加“从一个浏览器迁移到另一个浏览器”的具体描述

## Sources & References

- **Origin brainstorm:** [docs/brainstorms/2026-03-14-browser-migration-import-export-brainstorm.md](/Users/xiaohansong/projects/twitter-web-exporter/docs/brainstorms/2026-03-14-browser-migration-import-export-brainstorm.md)
  - Carried-forward decisions: 单文件迁移包、导入覆盖当前数据库与配置、配置包含敏感信息、导入前必须二次确认。

### Internal references
- [src/core/settings.tsx](/Users/xiaohansong/projects/twitter-web-exporter/src/core/settings.tsx#L166)（当前本地数据库操作入口）
- [src/core/settings.tsx](/Users/xiaohansong/projects/twitter-web-exporter/src/core/settings.tsx#L193)（现有 `Export DB` 交互）
- [src/core/options/manager.ts](/Users/xiaohansong/projects/twitter-web-exporter/src/core/options/manager.ts#L9)（完整配置结构）
- [src/core/options/manager.ts](/Users/xiaohansong/projects/twitter-web-exporter/src/core/options/manager.ts#L110)（配置加载）
- [src/core/options/manager.ts](/Users/xiaohansong/projects/twitter-web-exporter/src/core/options/manager.ts#L138)（配置保存）
- [src/core/database/manager.ts](/Users/xiaohansong/projects/twitter-web-exporter/src/core/database/manager.ts#L182)（Dexie 数据库导出）
- [src/core/database/manager.ts](/Users/xiaohansong/projects/twitter-web-exporter/src/core/database/manager.ts#L186)（Dexie 数据库导入）
- [src/core/database/manager.ts](/Users/xiaohansong/projects/twitter-web-exporter/src/core/database/manager.ts#L190)（数据库清空语义）
- [src/core/database/manager.ts](/Users/xiaohansong/projects/twitter-web-exporter/src/core/database/manager.ts#L30)（数据库名受账号配置影响）
- [src/core/sync/sync-manager.ts](/Users/xiaohansong/projects/twitter-web-exporter/src/core/sync/sync-manager.ts#L90)（options 变化触发同步的边沿监听）
- [src/core/sync/sync-manager.ts](/Users/xiaohansong/projects/twitter-web-exporter/src/core/sync/sync-manager.ts#L134)（实际同步执行入口）
- [src/utils/exporter.ts](/Users/xiaohansong/projects/twitter-web-exporter/src/utils/exporter.ts#L27)（通用文件下载能力）

### Research notes
- 本地 repo pattern 足够清晰，因此未额外做外部研究。
- `docs/solutions/` 中相关 institutional learning 只有一条直接相关记录：[docs/solutions/integration-issues/supabase-sync-csp-404-userid-unknown-20260222.md](/Users/xiaohansong/projects/twitter-web-exporter/docs/solutions/integration-issues/supabase-sync-csp-404-userid-unknown-20260222.md)。其中最可迁移的结论是：配置变化会触发同步链路，因此迁移导入必须避免在半配置状态下发出副作用。
- `docs/solutions/patterns/critical-patterns.md` 当前仓库中不存在，因此没有额外的全局必读模式文件可继承。
