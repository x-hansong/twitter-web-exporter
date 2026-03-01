---
title: feat: Add Manual Batch Assisted Capture
type: feat
status: completed
date: 2026-03-01
origin: docs/brainstorms/2026-03-01-batch-assisted-capture-brainstorm.md
---

# feat: Add Manual Batch Assisted Capture

## Overview

为脚本增加一个“手动运行”的批量辅助抓取能力，允许用户在设置面板中勾选并串行执行两类任务：

- 抓取全部书签
- 抓取当前登录账号的个人推文历史（以 Web 端可加载范围为准）

该功能必须严格沿用现有“拦截 Twitter/X Web App 自身请求”的架构，不新增主动 GraphQL 请求，只负责自动导航、自动滚动、节流暂停、停止判定和运行状态展示（见 brainstorm: `docs/brainstorms/2026-03-01-batch-assisted-capture-brainstorm.md`）。

## Problem Statement / Motivation

当前仓库已经能在用户浏览页面时自动拦截并入库书签与个人推文数据，但抓取过程依然高度依赖重复人工操作：

- 需要手动进入对应页面
- 需要持续滚动触发懒加载
- 长列表抓取耗时长且容易遗漏

这导致“理论可抓到的数据”与“实际能稳定抓到的数据”之间存在明显落差。用户希望把重复性操作内建到脚本里，同时保留较低风控风险，不把功能演变成主动调用接口的机器人。

## Proposed Solution

增加一个新的本地调度器，用于在浏览器内驱动“辅助抓取流程”，并把它接到设置面板里的手动入口。

### 用户交互

- 在 [src/core/settings.tsx](/Users/xiaohansong/projects/twitter-web-exporter/src/core/settings.tsx) 新增一个“Manual Batch Capture”区块或独立操作项。
- 点击入口后弹出一个轻量配置界面，支持：
  - 勾选任务：`Bookmarks`、`My Tweets`
  - 查看节流参数（使用默认值即可，也可允许高级用户调整）
  - 启动本次任务
  - 运行中查看当前步骤、当前任务、累计滚动次数、最近一次新增条数
  - 手动停止当前任务

### 运行模型

- 新增一个独立的批量辅助抓取管理器（建议放在 `src/core/batch-capture/`）。
- 调度器串行执行选中的任务，任一时刻只跑一个任务（见 brainstorm: `docs/brainstorms/2026-03-01-batch-assisted-capture-brainstorm.md`）。
- 每个任务包含统一状态机：
  - `idle`
  - `navigating`
  - `warming`
  - `scrolling`
  - `cooldown`
  - `completed`
  - `stopped`
  - `failed`

### 任务行为

- `Bookmarks`
  - 导航到书签页
  - 等待页面首屏稳定
  - 周期性向下滚动，依赖现有 [src/modules/bookmarks/api.ts](/Users/xiaohansong/projects/twitter-web-exporter/src/modules/bookmarks/api.ts) 拦截 XHR 并入库
  - 使用“多轮无新增”判断抓取完成

- `My Tweets`
  - 导航到当前登录账号的个人资料页（不是任意用户）
  - 等待推文时间线首屏稳定
  - 周期性向下滚动，依赖现有 [src/modules/user-tweets/api.ts](/Users/xiaohansong/projects/twitter-web-exporter/src/modules/user-tweets/api.ts) 拦截并入库
  - 明确告知仅保证 Web 端可见范围，不承诺完整历史

### 停止与节流

- 采用混合节流：
  - 常规短暂停顿：每次滚动后等待较短时间
  - 分段长暂停：累计固定滚动次数后进行一次更长冷却
- 完成判定采用双保险：
  - 连续 N 轮捕获数量无增长或页面高度无变化，判定到底
  - 达到最大滚动次数或最大运行时长后强制结束

## Technical Considerations

- 架构约束
  - 必须保持“只拦截页面已有请求，不主动请求 Twitter/X API”。
  - 新能力本质是 UI 自动化，不是网络层扩展（见 brainstorm: `docs/brainstorms/2026-03-01-batch-assisted-capture-brainstorm.md`）。

- 配置持久化
  - 若提供可配置的节流参数，需扩展 [src/core/options/manager.ts](/Users/xiaohansong/projects/twitter-web-exporter/src/core/options/manager.ts) 中的 `AppOptions`，保持与当前本地存储模式一致。
  - 默认值应偏保守，避免首次启用即过快滚动。

- UI 一致性
  - 入口放在设置面板，符合“低频工具项”定位，复用现有设置区块与按钮样式。
  - 运行状态建议通过 modal 呈现，避免在主面板塞入过多长任务信息。

- 页面导航
  - 尽量使用同页路由跳转（`location.assign` 或站内链接），避免重新注入失败。
  - 若 Twitter/X 的 SPA 导航拦截与脚本时序存在冲突，需要为“导航后等待稳定”提供超时和失败回退。

- 数据判定
  - 不要直接依赖 DOM 里推文条数作为唯一完成依据，优先结合本地数据库中目标模块的 `capture count` 增量。
  - 当前项目已有 [src/core/database/manager.ts](/Users/xiaohansong/projects/twitter-web-exporter/src/core/database/manager.ts) 的 `extGetCaptureCount`，可作为低耦合统计基线。

- 文案约束
  - 必须在 UI 中复述 README 的关键限制：只能抓到页面可加载的数据；过快操作可能触发 Web 端限制。

## System-Wide Impact

- **Interaction graph**
  - 用户在 [src/core/settings.tsx](/Users/xiaohansong/projects/twitter-web-exporter/src/core/settings.tsx) 点击“手动运行”后，触发新建的 batch capture 管理器。
  - 管理器驱动页面导航和滚动。
  - 页面在滚动过程中继续发起 XHR。
  - [src/core/extensions/manager.ts](/Users/xiaohansong/projects/twitter-web-exporter/src/core/extensions/manager.ts) 里的 hook 仍按原路径把响应分发给已启用模块。
  - `BookmarksModule` / `UserTweetsModule` 解析响应后继续写入 [src/core/database/manager.ts](/Users/xiaohansong/projects/twitter-web-exporter/src/core/database/manager.ts)。
  - 设置面板或运行 modal 再订阅管理器状态刷新 UI。

- **Error propagation**
  - 导航失败、页面结构异常、长时间无首屏内容、任务中断都应由调度器吞并并转为 `failed` 状态，而不是抛到全局导致整个脚本 UI 崩溃。
  - 解析失败仍由原模块日志处理，不应影响批量辅助抓取调度器本身的生命周期。

- **State lifecycle risks**
  - 若用户在运行中关闭 modal，后台任务是否继续，必须有明确规则。建议：modal 关闭不终止任务，只有显式点击“Stop”才停止。
  - 若用户切到其他页面或手动滚动，调度器需要检测“上下文偏离”并停止或提示，避免与用户操作互相抢控制权。

- **API surface parity**
  - 现有 `Sync Now` 是设置面板中的一次性主动操作样式，本功能应复用类似的触发心智，而不是新增一个隐藏入口。
  - 若未来扩展到 `Likes`、`Followers` 等其他可滚动模块，调度器接口应允许新增任务定义，而不是把逻辑硬编码在设置组件里。

- **Integration test scenarios**
  - 从设置面板启动只勾选 `Bookmarks`，能跑完并自动停止。
  - 同时勾选 `Bookmarks` 与 `My Tweets`，按串行顺序执行，前一个结束后再进入后一个。
  - 导航后页面没有进入预期时间线，任务应失败并给出可见状态。
  - 连续多轮无新增时自动完成，不无限滚动。
  - 用户手动点击停止后，滚动循环在当前等待点内可终止。

## SpecFlow Analysis

### 核心用户流

1. 用户打开设置面板并进入批量辅助抓取入口。
2. 用户勾选一个或两个任务。
3. 用户点击开始。
4. 系统进入“运行中”状态，显示当前任务和进度提示。
5. 系统导航到目标页面并等待首屏稳定。
6. 系统按节流规则持续滚动并观察捕获增量。
7. 若满足完成条件，则结束当前任务并进入下一个任务。
8. 全部任务结束后，系统显示完成状态。

### 关键分支与遗漏补全

- 若用户未勾选任何任务，则不能启动。
- 若对应模块被用户在设置中禁用，启动前应提示并阻止执行，或自动启用并明确告知。建议第一阶段直接阻止并提示，减少隐式副作用。
- 若当前页面因登录失效、站点改版或网络异常没有出现预期时间线，任务应失败并停止后续任务。
- 若用户在运行过程中切换标签页，时间器可能被浏览器降频。UI 需要避免把“变慢”误判为“已卡死”。
- 若用户在运行中手动滚动/跳转，需将其视为人工接管，建议中止当前任务。

## Acceptance Criteria

- [x] 设置面板新增“手动批量辅助抓取”入口，用户可打开配置/运行界面。
- [x] 入口支持勾选 `Bookmarks` 与 `My Tweets` 两类任务。
- [x] 未勾选任何任务时不能启动，并有明确提示。
- [x] 任务执行为串行，不允许并发跑多个抓取流程（见 brainstorm: `docs/brainstorms/2026-03-01-batch-assisted-capture-brainstorm.md`）。
- [x] `Bookmarks` 任务能够自动导航到书签页并通过自动滚动触发现有拦截链路持续入库。
- [x] `My Tweets` 任务能够自动导航到当前登录账号主页并通过自动滚动触发现有拦截链路持续入库。
- [x] 运行逻辑不新增主动的 Twitter/X API 请求，只复用页面本身的请求行为（见 brainstorm: `docs/brainstorms/2026-03-01-batch-assisted-capture-brainstorm.md`）。
- [x] 节流采用混合模式：支持短暂停顿与阶段性长暂停。
- [x] 停止逻辑同时具备“多轮无变化自动结束”和“最大运行上限强制结束”。
- [x] 运行界面可展示当前状态、当前任务、最近进展，并支持手动停止。
- [x] 任务失败不会导致整个脚本 UI 崩溃，错误状态对用户可见。
- [x] UI 明确说明抓取范围限制与潜在风控风险，尤其是“我的推文”仅限 Web 端可见范围。
- [x] 至少完成一次本地构建验证，并补充与新模块相关的 lint 检查。

## Success Metrics

- 用户无需手动反复滚动，即可完成一次长列表书签抓取。
- 同一轮运行内，两个勾选任务都能按顺序独立完成或明确失败。
- 在保守默认节流参数下，不出现明显的连续高频滚动失控。
- 功能上线后不破坏现有被动捕获、导出、设置和同步功能。

## Dependencies & Risks

- 依赖 Twitter/X 当前 DOM 与路由行为保持足够稳定。
- 依赖现有 XHR hook 继续在目标页面生效。
- 风险在于：
  - 站点改版导致目标页面识别失败
  - 自动滚动与用户手动操作冲突
  - 计数策略误判，导致过早停止或过晚停止
  - 浏览器后台标签页降频，导致定时行为不稳定

建议用“保守默认值 + 可见运行状态 + 硬上限”来控制这些风险。

## Implementation Phases

### Phase 1: Foundation

- 新建 `src/core/batch-capture/` 目录，定义：
  - 任务类型
  - 运行状态
  - 配置结构
  - 管理器单例
- 管理器对外提供最小接口：
  - `start(config)`
  - `stop()`
  - `getState()`
  - 订阅状态更新
- 补充默认节流参数与最大运行上限常量。

### Phase 2: Settings UI

- 在 [src/core/settings.tsx](/Users/xiaohansong/projects/twitter-web-exporter/src/core/settings.tsx) 增加入口按钮。
- 新增一个 modal 组件（建议放在 `src/components/modals/`）用于：
  - 勾选任务
  - 开始运行
  - 展示状态
  - 手动停止
- 若需要记住上次选择或高级参数，扩展 [src/core/options/manager.ts](/Users/xiaohansong/projects/twitter-web-exporter/src/core/options/manager.ts)。

### Phase 3: Task Execution

- 实现 `Bookmarks` 和 `My Tweets` 的任务定义：
  - 页面导航
  - 首屏稳定检测
  - 滚动循环
  - 增量判定
  - 完成/失败收尾
- 使用数据库 capture count 作为主要增量信号，必要时辅以页面高度变化作为兜底。
- 手动停止必须能打断滚动与等待流程。

### Phase 4: Hardening

- 补足失败态与提示文案。
- 校验目标模块是否启用；对禁用场景给出阻断提示。
- 回归检查：
  - 设置面板
  - 模块拦截
  - 现有 `Sync Now`
  - 基础导出流程

## Alternative Approaches Considered

- 主动模拟请求 GraphQL
  - 未采用。它偏离当前架构，会引入更高风控风险和更高维护成本（见 brainstorm: `docs/brainstorms/2026-03-01-batch-assisted-capture-brainstorm.md`）。

- 把入口放在主控制面板
  - 未采用。该操作是低频长任务，放在设置面板更符合工具属性（见 brainstorm: `docs/brainstorms/2026-03-01-batch-assisted-capture-brainstorm.md`）。

- 多任务并发执行
  - 未采用。会提升请求密度，并让页面控制、状态显示和错误恢复都更复杂（见 brainstorm: `docs/brainstorms/2026-03-01-batch-assisted-capture-brainstorm.md`）。

## Documentation Plan

- 更新 [README.md](/Users/xiaohansong/projects/twitter-web-exporter/README.md) 与 [docs/README.zh-Hans.md](/Users/xiaohansong/projects/twitter-web-exporter/docs/README.zh-Hans.md)：
  - 增加“手动批量辅助抓取”说明
  - 明确其仍属于“辅助自动化”，不主动请求 API
  - 明确“我的推文”只覆盖 Web 端可见范围
  - 补充风控与频率建议

## Sources & References

- **Origin brainstorm:** [docs/brainstorms/2026-03-01-batch-assisted-capture-brainstorm.md](/Users/xiaohansong/projects/twitter-web-exporter/docs/brainstorms/2026-03-01-batch-assisted-capture-brainstorm.md)
  - carried-forward decisions:
  - 入口放在设置面板
  - 单入口勾选任务
  - 只做辅助抓取，不做主动 API 拉取
  - 串行执行
  - 混合节流
  - “多轮无变化 + 硬上限”停止策略

- Similar implementations:
  - [src/core/settings.tsx](/Users/xiaohansong/projects/twitter-web-exporter/src/core/settings.tsx)
  - [src/core/options/manager.ts](/Users/xiaohansong/projects/twitter-web-exporter/src/core/options/manager.ts)
  - [src/core/extensions/manager.ts](/Users/xiaohansong/projects/twitter-web-exporter/src/core/extensions/manager.ts)
  - [src/modules/bookmarks/api.ts](/Users/xiaohansong/projects/twitter-web-exporter/src/modules/bookmarks/api.ts)
  - [src/modules/user-tweets/api.ts](/Users/xiaohansong/projects/twitter-web-exporter/src/modules/user-tweets/api.ts)
  - [src/core/database/manager.ts](/Users/xiaohansong/projects/twitter-web-exporter/src/core/database/manager.ts)

- Institutional learnings:
  - [docs/solutions/integration-issues/supabase-sync-csp-404-userid-unknown-20260222.md](/Users/xiaohansong/projects/twitter-web-exporter/docs/solutions/integration-issues/supabase-sync-csp-404-userid-unknown-20260222.md)
  - Relevant takeaway: userscript 里的长生命周期任务要避免脆弱时序和隐式触发，优先显式入口、稳健状态机和可恢复失败态。

- Product constraints:
  - [README.md](/Users/xiaohansong/projects/twitter-web-exporter/README.md)
  - [docs/README.zh-Hans.md](/Users/xiaohansong/projects/twitter-web-exporter/docs/README.zh-Hans.md)
