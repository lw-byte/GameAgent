# 游戏场景分析管线深度文档(以 game scene 为例)

本文以"分析sgame游戏应用的卡顿问题"为例,串起 SmartPerfetto 后端的完整执行链:从 HTTP 进入到 trace_processor_shell 查询,从 system prompt 拼装到 MCP `invoke_skill` 调用,从焦点检测到结论回写。

涉及源码定位一律使用 `path/to/file.ts:line` 形式,点击 IDE 即可跳转。

---

## 0. 总览:一条 query 的生命周期

```text
POST /api/agent/v1/analyze
  → backend/src/routes/agentRoutes.ts:3145     (HTTP 入口,analysisMode=auto)
  → AgentAnalyzeSessionService.prepareSession()  (backend/src/assistant/application/...)
  → createAgentOrchestrator()                    (backend/src/agentRuntime/runtimeSelection.ts)
  → ClaudeRuntime.analyze(query, sessionId, traceId, options)
       1. classifyScene(query)                   ← ② 场景检测
       2. detectFocusApps(...) 并行启动          ← ① 焦点应用检测
       3. classifyQueryComplexity(...) 并行启动  ← query 复杂度分类(quick/full)
       4. buildSystemPromptParts(...)            ← ③ game.strategy.md 注入
       5. Claude Agent SDK 主循环:多轮调用
            - submit_plan   (plan/contract 守门)
            - detect_architecture
            - invoke_skill(game_fps_analysis)
            - invoke_skill(game_main_loop_jank)
            - execute_sql / fetch_artifact
            - submit_hypothesis / resolve_hypothesis
       6. finalizeAnalysis(): 证据收集 → verifier → 结论 → SSE → 前端
```

下面四个章节按用户提出的顺序展开。

---

## 1. 前台焦点应用检测 + 场景检测原理

### 1.1 焦点应用检测 `detectFocusApps`

入口:`backend/src/agentv3/focusAppDetector.ts:131-298`,函数 `detectFocusApps(traceProcessorService, traceId, options)`。

采用**三级顺序 fallback**(Tier 1 → 2 → 3),每一级跑一次 SQL,直到返回非空结果:

| Tier | Stdlib Module | 关键表 | SQL 路径 | 说明 |
|---|---|---|---|---|
| 1 | `android.battery_stats` | `android_battery_stats_event_slices` | `WHERE track_name='battery_stats.top' AND safe_dur > 50000000` | 最强信号:电池统计的前台切换 |
| 2 | `android.oom_adjuster` + `android.process_metadata` | `android_oom_adj_intervals` | `WHERE oa.score <= 0 AND oa.score > -900`(score ≤ 0 即前台) | 备用:进程调度优先级 |
| 3 | `android.frames.timeline` + `android.process_metadata` | `actual_frame_timeline_slice` | 解析 `layer_name LIKE 'TX - %'` 拿包名,按帧数排序 | 保底:几乎所有 trace 都有 frame timeline |

`focusAppDetector.ts:33-64` 维护了一份**黑名单**(系统进程/系统包前缀),用于过滤 `surfaceflinger`、`com.miui.home` 这类不应当被识别成"目标应用"的实体。

**system_process 黑名单**:
- 精确名:`init`、`surfaceflinger`、`system_server`、`zygote`、`zygote64`
- 路径前缀:`/system/bin/`、`/system_ext/bin/`、`/vendor/bin/`、`/apex/`
- 包名前缀:`com.android.systemui`、`com.miui.home`、`com.sec.android.app.launcher`(各厂商 launcher)等

每 Tier 拿到 rows 后,先 `filter(app => !isSystemProcess(app.packageName))`,再决定是否返回。**三级都失败时返回 `{ apps: [], method: 'none' }`**。

返回结构:`FocusAppDetectionResult { apps, primaryApp, method, timeRange }`,其中 `method` 标识实际命中的 Tier 名称。

> 调用现场见 `backend/src/agentRuntime/engines/claude/claudeRuntime.ts:1089-1124`。`startFocusDetection()` 与 classifier 并行启动,若本地规则已能跳过(如纯事实查询),则连 focus 检测都不启动。

**为什么 game 场景下焦点经常误识别**:
本次 query "分析sgame游戏应用的卡顿问题" 的实际 session log 显示命中 Tier 3 `frame_timeline`,但 `primaryApp` 是 `com.miui.securitycenter` 而非 sgame。原因是:
- Tier 1 battery_stats 不在范围里(测试 trace 通常不开)
- Tier 2 oom_adj_intervals 可能为空或全是系统进程
- Tier 3 frame_timeline 按帧数排序,系统应用的帧数可能多于游戏本身
- 真正根因:目前没有 "s 包名优先" 或 "查询内出现过的包名加权" 逻辑

### 1.2 场景检测 `classifyScene`

入口:`backend/src/agentv3/sceneClassifier.ts:103-124`,函数 `classifyScene(query)`。

**纯关键字匹配,** 不调用 LLM,< 1ms 完成。

#### 1.2.1 场景来源

所有 scene 都从 `backend/strategies/*.strategy.md` 的 YAML frontmatter 里读 `keywords` 和 `compound_patterns`:

```yaml
# backend/strategies/game.strategy.md:17-34
keywords: [游戏, game, 帧率, 游戏卡顿, 游戏掉帧, unity, unreal, 游戏性能, ...]
compound_patterns: ["游戏.*卡", "游戏.*帧", "game.*jank", "game.*fps"]
```

加载机制:`strategyLoader.ts:601-617` 的 `baseStrategies()` 在 dev 模式下每次重读,生产环境缓存到 `baseCache`。`getRegisteredScenes()`(`strategyLoader.ts:1019-1022`) 返回全部非 contract_only 的场景定义。

#### 1.2.2 匹配流程

```text
scenes.sort by priority ASC, exclude 'general'
for each scene (按 priority 升序):
    1. compound_patterns.test(query)   ← 复合模式,更精确
    2. keywords 中任意一个匹配(query)  ← 单关键字
命中即返回 scene,否则返回 'general'
```

优先级顺序(数字越小越优先):

| priority | scene |
|---|---|
| 1 | game(本次命中) |
| 1 | anr |
| 2 | startup |
| 3 | scrolling |
| 4 | interaction |
| 5 | overview |
| 99 | general(兜底) |

#### 1.2.3 关键字匹配的两个边界保护

`sceneClassifier.ts:29-93`:

1. **ASCII 关键字必须词边界匹配**:防止 "scroll" 误中 "scrollbar"。`isAsciiKeyword` + `matchesAsciiKeywordWithBoundary` 检查前后字符是否标识符字符(`[A-Za-z0-9_]`)。
2. **CamelCase 内匹配**:对长度 ≥ 8 的长关键字(如 `RecyclerView`),允许在 CamelCase 内部命中(如 `MyRecyclerViewHelper`),避免把整段小写子串误命中其他场景。

#### 1.2.4 本次 query 命中链路

`"分析sgame游戏应用的卡顿问题"` → 转为小写 → 按 priority 遍历 → game.scene 的 compound_pattern `"游戏.*卡"` 正则命中(包含"游戏卡"两字)→ **返回 `game`**。**整个匹配 < 1ms,0 网络开销**。

#### 1.2.5 返回值的使用

`claudeRuntime.ts:1066` 拿到 `sceneType = 'game'`,传给:
- `buildComplexityClassifierInput({ sceneType, ... })` 给 classifier
- `runSnapshots.capture(sessionId, sceneType)` 冻结策略版本(防止中途 reload split-brain)
- `buildSystemPromptParts(...)` 注入 game strategy 内容(见 §2)

### 1.3 架构检测 `detectArchitecture`

虽然不在"focus/scene"分类,但**入口链路相邻**——`invoke_skill('detect_architecture')` 跑的是同一个 YAML skill `rendering_pipeline_detection`,在 claudeRuntime 中作为 pre-evidence / 首次工具调用出现。

入口:`backend/src/agent/detectors/architectureDetector.ts:53-99`(`detectArchitectureViaSkill`)。

实现方式:直接调用 `skillExecutor.execute('rendering_pipeline_detection', traceId, ...)`,从 rawResults 中拿 `determine_pipeline` 与 `subvariants` 两个 step 的 row,转成 `ArchitectureInfo { type, confidence, evidence[] }`。

`resolvePipelineArchitectureType(pipelineId)`(`architectureDetector.ts:41-43`)从 `pipelineSkillLoader.getPipelineCatalogEntry(pipelineId)?.architecture_type` 拿到 24 种细粒度架构之一(STANDARD / FLUTTER / COMPOSE / WEBVIEW / 等)。

本次 session log 看到 `architecture_detected` 在焦点检测之后、`engine initialized` 之前,说明这是 orchestrator 在初始化完后第一波工具调用之一。

---

## 2. game strategy 加载及执行过程

### 2.1 加载机制 `strategyLoader.ts`

#### 2.1.1 文件格式

`backend/strategies/game.strategy.md` 由两部分组成:

1. **YAML frontmatter**:被 `js-yaml` 解析成结构化字段
2. **Markdown body**:作为 system prompt 的注入文本

frontmatter 字段(参见 `game.strategy.md:5-62`):

| 字段 | 类型 | game 中的值 | 用途 |
|---|---|---|---|
| `scene` | string | `game` | scene id,也是文件名 stem |
| `priority` | number | 1 | sceneClassifier 排序键 |
| `effort` | string | `medium` | 传给 Claude SDK 的 thinking effort |
| `required_capabilities` | string[] | `[cpu_scheduling]` | trace 必须具备的能力,缺则报 critical gap |
| `optional_capabilities` | string[] | `[gpu, thermal_throttling, ...]` | 提升分析质量但不阻塞 |
| `keywords` / `compound_patterns` | string[] / regex | 见 §1.2.1 | 场景匹配 |
| `phase_hints` | object[] | 2 条(game_loop_jank / game_gpu_power) | 中途阶段再注入提醒 |
| `plan_template.mandatory_aspects` | object[] | fps_and_gpu / engine_loop_jank | submit_plan 必须覆盖 |

#### 2.1.2 解析流程

- `strategyLoader.ts:180` `STRATEGIES_DIR = path.resolve(__dirname, '../../strategies')`
- `strategyLoader.ts:182` `FRONTMATTER_RE` 用 regex 切分 YAML 与正文;允许开头有 `<!-- SPDX -->` 等 HTML 注释块
- `strategyLoader.ts:363-503` `parseStrategyFile`:
  - `yaml.load()` 解析 frontmatter
  - `compound_patterns` 全部 `new RegExp(p, 'i')`
  - `phase_hints` 数组化
  - `plan_template.mandatory_aspects` 解析 trigger_keywords / required_expected_calls
  - `final_report_contract` 解析 trigger_patterns / recovery_text(zh/en)
  - `parseStrategyDetails()`(`strategyLoader.ts:299-326`)**抽出 `<-- strategy-detail -->` 块**:从正文中剥离,变成 `detailSections[]`,ref 形如 `game:full`。本次 game.strategy.md 的 `<-- strategy-detail id="full" title="..." -->` 块(`game.strategy.md:91-156`)被切成 `id='full'` 的 detail,在 agent 调 `lookup_strategy_detail({ ref: 'game:full' })` 时按需返回。

#### 2.1.3 缓存

`strategyLoader.ts:601-617` `baseStrategies()` 在 `NODE_ENV !== 'production'` 时**每次重新读盘**(dev 热加载);生产环境缓存到 `baseCache`。`invalidateStrategyCache()`(`strategyLoader.ts:1078-1082`)清空全部缓存。

`loadStrategies()`(`strategyLoader.ts:932-942`)还会被 `Self-Evolution runtime registry` 覆盖:若当前请求有 runManifest / effective registry snapshot,则使用 snapshot 版本;否则回退到 base。

#### 2.1.4 查询 API

| 函数 | 文件:行 | 返回 |
|---|---|---|
| `getStrategyContent(scene)` | `strategyLoader.ts:944-955` | 正文 Markdown(去掉 detail 块) |
| `getStrategyDetails(scene)` | `strategyLoader.ts:957-961` | detailSections 数组 |
| `getStrategyDetailByRef(ref)` | `strategyLoader.ts:963-975` | 按 `scene:id` 查 detail |
| `matchStrategyDetailForPhase(scene, phase)` | `strategyLoader.ts:977-998` | 按 phase 文本打分挑最匹配的 detail |
| `getPlanTemplate(scene)` | `strategyLoader.ts:1041-1045` | mandatory_aspects 列表 |
| `getFinalReportContract(scene)` | `strategyLoader.ts:1051-1053` | final_report_contract |
| `getPhaseHints(scene)` | `strategyLoader.ts:1025-1029` | phase_hints 列表 |

### 2.2 strategy 注入 system prompt

入口:`backend/src/agentv3/claudeSystemPrompt.ts`。

`buildSystemPromptParts(context, maxTokens?, options?)`(`claudeSystemPrompt.ts:591-`)按 3 个 tier 组装 prompt:

```text
Tier 1 (静态,永不丢): role / output_language / output_format / retrieved_context_safety
Tier 2 (per-trace stable): architecture / focus_apps / trace_completeness / knowledge_base
Tier 3 (per-query, 可裁剪): base_methodology / scene_strategy_core / report_contract / base_methodology_reference
```

**scene_strategy_core 这一段就是 game strategy**:

`claudeSystemPrompt.ts:149-164` `buildSceneStrategySections()`:
- `getStrategyContent(sceneType || 'general')` 拿到 `game.strategy.md` 的正文(已剥离 detail 块)
- 包成 `### 场景策略(必须严格遵循)\n\n---\n\n{content}`
- 标记为 `truncatable: true`(`claudeSystemPrompt.ts:727`),超 token 预算时按二分法裁剪到最近的 markdown 边界(`truncateSegmentToTokenBudget` `claudeSystemPrompt.ts:632-654`)

**phase_hints 怎么用**:phase hint 不是 prompt 一次性注入,而是按 plan 阶段**再次注入**。`getPhaseHints('game')` 返回 game.strategy.md 里 2 条 phase hint(`game_loop_jank` 与 `game_gpu_power`),agent 在每个 plan phase 跑前/后,根据当前 phase 文本与 hint.keywords 做匹配,命中后把 hint.constraints 作为 reminder 注入,避免 agent 漏掉 critical tool。

### 2.3 strategy 守门:`plan_template` 与 `final_report_contract`

#### 2.3.1 plan 守门

`game.strategy.md:48-62` 声明 `plan_template.mandatory_aspects`:

```yaml
- id: fps_and_gpu
  match_keywords: ['game','fps','游戏','gpu','frame','帧率']
  suggestion: '...'
  required_expected_calls: [{ tool: invoke_skill, skill_id: game_fps_analysis }]
- id: engine_loop_jank
  match_keywords: ['Unity','Unreal','Cocos','Godot',...]
  required_expected_calls: [{ tool: invoke_skill, skill_id: game_main_loop_jank }]
```

agent 调 `submit_plan(...)` 时,MCP server 端的 plan 守门(`backend/src/agentv3/claudeMcpServer.ts:3083 附近`)会用 `getPlanTemplate('game')` 取上面这个列表,扫描 plan 中每个 phase 的 `name/goal/expectedTools/expectedCalls`,必须至少一个 phase 命中 `fps_and_gpu` 的 `match_keywords` 并把 `invoke_skill(game_fps_analysis)` 列入 expected_calls。**否则 plan 被拒**。

#### 2.3.2 报告守门

`game.strategy.md` 的 `final_report_contract.required_sections`(若有)会在最终结论生成后被 `backend/src/services/finalReportContractGate.ts` 检查——对 game 而言,它会要求"帧率概览 / 卡顿帧分析 / GPU 状态 / 热节流影响 / 优化建议"五段(对应 `game.strategy.md:149-155` 输出结构)出现在最终 conclusion 里,缺失则用 `recovery_text.zh` 自动补段。

### 2.4 本次 game strategy 在 prompt 中的实际形态

注入后的 system prompt 中 `### 场景策略(必须严格遵循)` 段:

```text
### 场景策略(必须严格遵循)

对于以下常见场景,已有验证过的分析流水线。**必须完整执行所有阶段**,不可跳过。

---

#### game Core Strategy

**Route card**: 游戏 / game / 帧率 / 游戏卡顿 / 游戏掉帧 / unity / unreal / 游戏性能 / game fps / game performance

**Capabilities**: required=[cpu_scheduling], optional=[gpu, thermal_throttling, surfaceflinger, gpu_work_period, power_rails, cpu_freq_idle]

**Execution contract**
- 先 submit_plan;计划必须覆盖下列 frontmatter mandatory aspects,并在 expectedCalls 中声明关键 Skill/工具。
- 条件触发项只在 plan/证据命中对应 trigger 时强制;数据缺失时用 skipped+reason 或 waiver,不把缺失证据改写成通过。
- detail 是 informational:只指导如何执行,不能替代 invoke_skill / execute_sql / fetch_artifact 的 trace 证据。

**Mandatory aspects**
- fps_and_gpu: ...(required: invoke_skill(game_fps_analysis))
- engine_loop_jank: ...(required: invoke_skill(game_main_loop_jank))

**Phase reminders**
- game_loop_jank: 游戏/引擎场景必须先用 game_fps_analysis 看整体帧率... 工具: game_fps_analysis, game_main_loop_jank
- game_gpu_power: GPU/功耗/发热问题按数据完整度补充 ... 工具: ...

**Final report contract summary**
- 遵循通用输出契约。

**Detail ref**
- `game:full`: 游戏性能分析(用户提到 游戏、game、帧率、游戏卡顿) 的完整 phase recipe、SQL、fetch_artifact 表、决策树和边界说明。
```

agent 看到后,通常会:
1. `submit_plan` 含 fps_and_gpu + engine_loop_jank 两个 phase
2. 第 1 phase 调 `invoke_skill('game_fps_analysis')`
3. 第 2 phase 调 `invoke_skill('game_main_loop_jank')`
4. 必要时 `lookup_strategy_detail({ ref: 'game:full' })` 拿完整 phase recipe(对应 `game.strategy.md:91-156`)

---

## 3. game YAML skill 加载与执行过程

### 3.1 skill 物理布局

`backend/skills/` 的目录结构:

```text
backend/skills/
  atomic/           ← 单步 SQL skill,如 game_fps_analysis
  composite/        ← 多步 skill,如 scrolling_analysis
  deep/             ← 深度诊断 skill
  comparison/       ← 多 trace 对比专用
  modules/          ← 跨领域模块专家
    app/
    framework/
    kernel/
    hardware/
  pipelines/        ← pipeline_definition 类型,如 rendering_pipeline_detection
  vendors/          ← 厂商覆盖层(extends + additional_steps)
  fragments/        ← 可复用 SQL CTE 片段
  _template/        ← 新建 skill 的模板
```

`★ Insight ─────────────────────────────────────`
- `atomic/` 一个文件 = 一个 skill,一个 step 一个 SQL。`composite/` 一个文件 = 一个 skill 串多个 atomic/iterator。
- `pipelines/` 装的是 `type: pipeline_definition` 的 skill,**不能被 `invoke_skill` 直接调**,而是给 `rendering_pipeline_detection` 当目录。
- `fragments/*.sql` 是 CTE 复用片段,skill step 用 `sql_fragments: ['fragments/target_threads.sql']` 注入。
`─────────────────────────────────────────────────`

### 3.2 skill 加载机制 `skillLoader.ts`

入口:`backend/src/services/skillEngine/skillLoader.ts`,单例 `skillRegistry`(`skillLoader.ts:1180`)。

#### 3.2.1 加载入口

- `ensureSkillRegistryInitialized()`(`skillLoader.ts:1193-1230`):用 Promise-based lock 防止并发初始化;幂等。
- 初始化路径:`skillLoader.ts:1204-1219` → `skillRegistry.loadSkills(skillsDir)` → `loadSkillRoot({ rootPath, origin: 'built_in' })` → 递归扫 5 个目录 + fragments + 厂商。

#### 3.2.2 各目录扫描方式

`skillLoader.ts:373-403` `loadSkillRoot()`:

| 步骤 | 文件:行 | 行为 |
|---|---|---|
| 1 | `loadFragments(skillsDir, root)` `skillLoader.ts:409-434` | 读 `fragments/*.sql`,缓存到 `fragmentCache`,key 为 `fragments/<name>.sql` |
| 2 | 扫 `atomic/`、`composite/`、`deep/`、`system/`、`comparison/` | 调 `loadSkillsFromDir` (`skillLoader.ts:802-827`):逐个 `.skill.yaml` → `yaml.load` → `normalizeSkillDefinition` → `registerLoadedSkill` |
| 3 | 扫 `custom/`(仅 built_in root) | 同上 |
| 4 | 递归扫 `modules/` | `loadModuleSkillsRecursively` (`skillLoader.ts:583-613`):保留 `module` 与 `dialogue` 元信息 |
| 5 | 扫 `pipelines/` | `loadPipelineSkills` (`skillLoader.ts:619-643`):只注册 `type === 'pipeline_definition'` |
| 6 | 扫 `vendors/<厂商>/*.override.yaml` | `loadVendorOverrides` (`skillLoader.ts:650-753`):基于 `extends` 找到 base skill,叠加 `additional_steps`,记到 `vendorOverrides[baseSkillId][]` |

#### 3.2.3 YAML 归一化 `normalizeSkillDefinition`

`skillLoader.ts:50-287` 承担**多版本 YAML 向后兼容**:

| Legacy 写法 | 归一化后 |
|---|---|
| `triggers: ['kw1', '(reg|exp)']` | `triggers: { keywords: [...], patterns: [...] }` |
| `triggers: { pattern: '...' }` | `triggers: { patterns: ['...'] }` |
| `display:` 顶层 | `output.display:` |
| `meta` 缺失 | 从 `display_name` / `description` / `name` / 文件名兜底 |
| `step` 无 `type` 但有 `sql` | `type: 'atomic'` |
| iterator 用 `skill:` 而不是 `item_skill:` | `item_skill:` |
| `step.interpretation.key_metrics/analysis_hints`(legacy) | `step.synthesize` `{fields:[], insights:[]}` |
| condition 中的 `AND`/`OR` | `&&` / `||`,`=` 转 `==`(`normalizeConditionToJsExpr` `skillLoader.ts:168-175`) |

归一化保证 executor 只看一份稳定的内部结构。

#### 3.2.4 加载校验

每次 register 都跑:

| 校验 | 文件 | 说明 |
|---|---|---|
| `validateSkillDisplayContract` | `skillLoader.ts:533` | display.title/columns/layer/level 类型对不对 |
| `validateSkillConditions` | `skillLoader.ts:462` | step.conditions 的 JS 表达式语法 |
| `validateFragmentReferences` | `skillLoader.ts:467` | `sql_fragments: [...]` 引用的 key 是否在 fragmentCache 里 |
| `validateSkillBatchAnalysis` | `skillLoader.ts:472` | batch_frame_* 专用 schema |

加载期问题只记日志,不阻塞启动。

#### 3.2.5 模块专家识别

`skillLoader.ts:521-526`:若 YAML 顶层有 `module:` 字段(以及可选 `dialogue:`),归到 `moduleSkills` Map 而不是普通 skills,这样 `findSkillsByLayer` / `findModuleSkill` 可以按 layer = `app|framework|kernel|hardware` 和 component 维度查。

### 3.3 skill 内部结构(YAML schema)

以 `backend/skills/atomic/game_fps_analysis.skill.yaml`(`game.strategy.md` 强制要求的 skill)为例,看一份 atomic skill 的完整骨架:

```yaml
name: game_fps_analysis          # 必填,invoke_skill(skillId=...) 的 key
version: "1.0"
type: atomic                     # atomic | composite | iterator | parallel | conditional | pipeline_definition
category: rendering
tier: A
priority: high

meta:                            # 归一化必填
  display_name: "游戏帧率分析"
  description: "..."
  icon: "gamepad"
  tags: [game, fps, ...]

triggers:                        # 关键字 + 正则,被 findMatchingSkill 用
  keywords: { zh: [...], en: [...] }
  patterns: [...]

prerequisites:                   # executor 在跑前检查
  required_tables: [actual_frame_timeline_slice, process]
  optional_tables: [expected_frame_timeline_slice]
  modules: [android.frames.timeline]

thresholds:                      # 给 smartSummaryGenerator 用
  jank_rate: { unit: "%", levels: { excellent: {max:1}, ... } }

inputs:                          # 参数契约
  - { name: package, type: string, required: false }
  - { name: target_fps, type: integer, required: false }
  - { name: start_ts, type: timestamp, required: false }
  - { name: end_ts, type: timestamp, required: false }

steps:                           # ★ 执行流
  - id: detect_target_fps
    type: atomic
    sql: |
      WITH time_bounds AS (...), ...
    save_as: fps_detection       # 后续 step 可 ${fps_detection.target_fps}
    display:                     # 决定 DataEnvelope 怎么渲染
      level: summary
      layer: overview
      title: "目标帧率检测"
      columns: [ {name, label, type, format}, ... ]
```

`game_main_loop_jank.skill.yaml` 同样格式,但更复杂:
- 2 个 atomic steps:`engine_loop_summary` + `slow_engine_slices`
- CTE 引用了 `process`、`thread`、`thread_track`、`slice`,通过 `slices.with_context` stdlib module 让 trace_processor 注入 JOIN 提示
- 引擎识别靠 `s.name GLOB '*Unity*'` / `'*PlayerLoop*'` / `'*FrameGameThread*'` 等串匹配

### 3.4 skill 执行机制 `skillExecutor.ts`

入口:`backend/src/services/skillEngine/skillExecutor.ts`。

#### 3.4.1 入口

MCP server 的 `invoke_skill` 工具(`backend/src/agentv3/claudeMcpServer.ts:3053-3500`):

```text
1. requirePlan('invoke_skill')                    ← 没 plan 直接拒
2. 如果 skillId === 'detect_architecture'         ← 走 architectureDetector 通道
3. effectiveSkillRegistry.getSkill(skillId)       ← 找 YAML 定义
4. 若 type ∈ {pipeline_definition, comparison}    ← 拒,提示改用其他入口
5. normalizeSkillParams(params, packageName)      ← 注入默认包名
6. skillExecutor.execute(skillId, traceId, params, { signal, __paneSide, __outputLanguage })
7. emit progress: "技能 X 完成 (Yms, N 个结果层)"
```

#### 3.4.2 执行流

`skillExecutor.ts` 的核心方法是 `execute(...)` → 视情况调 `executeStepBasedSkill`(`skillExecutor.ts:2026-`):

```text
executeStep(skillId, traceId, params, ctx)
  ├─ prerequisites check (checkPrerequisites, skillExecutor.ts:3043-)
  ├─ validateSkillInputs (skillValidator)
  └─ for each step in skill.steps:
       executeStep(step, execContext, parentSkillId)
         ├─ step.type === 'atomic'      → executeAtomicStep        ← 这里查 SQL
         ├─ step.type === 'parallel'     → Promise.all(steps)
         ├─ step.type === 'composite'    → 子 skill 复用
         ├─ step.type === 'iterator'     → 拿 item_skill,逐元素跑
         ├─ step.type === 'conditional'  → eval step.condition,then/else
         ├─ step.type === 'pipeline_definition' → 拒
         └─ ...其他 ...
```

#### 3.4.3 atomic step 的实际查询路径

`skillExecutor.ts:2964-3038` `executeAtomicStep`:

```text
1. substituteVariables(step.sql, context)        ← ${package} ${start_ts} ${end_ts} 等替换
2. 若 step.sql_fragments: injectSqlFragments(...) ← 注入 fragments/*.sql
3. buildSqlWithModuleIncludes(...)               ← prerequisites.modules 自动加 INCLUDE PERFETTO MODULE
4. queryTraceProcessor(context.traceId, sql, {}, context.signal)
     → traceProcessorService.query(traceId, sql, {signal})
         → processorForQuery(traceId) → 拿到 TraceProcessor pool 中的一个 process
         → POST http://127.0.0.1:<port>/  body=sql
         → 等待 SSE/data response
     → 返回 { columns: [...], rows: [[...],...] }
5. rowsToObjects(columns, rows)                  ← 行列转 JSON 对象数组
6. 包装 StepResult { stepId, stepType, success, data, executionTimeMs }
```

错误处理:若 `step.optional === true`,SQL 错误也返回 `{ success: true, error, code: 'optional_query_error' }`;否则抛。

#### 3.4.4 取消传播

`skillExecutor.ts:2969` `throwIfTraceProcessorQueryCancelled(context.signal)` 与 `:3023` `rethrowIfTraceProcessorQueryCancelled` 保证 user 取消时整条执行链立即中断。

### 3.5 skill 输出的 DataEnvelope

skill 跑完后,`executor.execute()` 返回 `SkillExecutionResult { success, displayResults, rawResults, layeredResults, diagnostics }`,在 `claudeMcpServer.ts:3179` 拿到后:

1. 包成 `DataEnvelope`(`{meta, data, display, ...}`,见 `backend/src/types/dataContract.ts`)
2. 顶层 `display` 字段从 `step.display` 提取:layer (`overview|list|session|deep|diagnosis`)、level (`none|debug|detail|summary|key|hidden`)、columns、clickAction
3. 注入 `evidenceRefId` 与 `sourceToolCallId`(`claudeMcpServer.ts:3083-3163` 的 `createEvidenceProducerContext` + `buildScopedTraceProvenance`)
4. 通过 MCP `content: [{type:'text', text: JSON.stringify(envelope)}]` 回到 agent
5. agent 据此判断下一步(再调 skill?直接出结论?)

`synthesize` 配置:atomic skill 中若有 `synthesize` 块(由归一化或 YAML 直接写),`skillExecutor.ts:2026+` 会做轻量级数据汇总:对 fields 做阈值告警、对 insights 做条件评估,把告警附加到 result。

---

## 4. 主分析数据流(以 "分析sgame游戏应用的卡顿问题" 为例)

### 4.1 HTTP 入口 → orchestrator

`backend/src/routes/agentRoutes.ts:3145` 是 `POST /api/agent/v1/analyze` 的 handler:

```text
HTTP body: { query, sessionId, traceId, options }
   options 含 analysisMode / outputLanguage / selectionContext / packageName / referenceTraceId
   ↓
AgentAnalyzeSessionService.prepareSession()        ← 持久化 session,挂 trace
   ↓
createAgentOrchestrator()                          ← runtimeSelection 决定 runtime
   ↓
ClaudeRuntime.analyze(query, sessionId, traceId, options)
   ↓
SSE 通道挂上,前端开始收到 progress 事件
```

### 4.2 ClaudeRuntime.analyze() 主干

`backend/src/agentRuntime/engines/claude/claudeRuntime.ts:1031+` 是单一入口。整个函数分 8 个 phase:

```text
Phase 0: classifyScene(query) → 'game'                   ← §1.2
Phase 0: detectFocusApps(...) startFocusDetection()       ← §1.1,后台跑
Phase 0: classifyQueryComplexity(input, config)           ← quick/full 决策
Phase 1: buildSystemPromptParts(context)                  ← §2.2,拼 game strategy
Phase 2: createAnalysisRunSpec({ ... })                   ← runtime config 包
Phase 3: sdkQuery({ prompt, options }) 主循环:
   - submit_plan: 必须含 fps_and_gpu / engine_loop_jank
   - detect_architecture: 走 rendering_pipeline_detection skill (§1.3)
   - invoke_skill(game_fps_analysis, { package: '...' })
        → game_fps_analysis.yaml 的 3 个 atomic steps
        → trace_processor_shell 跑 SQL
        → DataEnvelope 回 MCP
   - invoke_skill(game_main_loop_jank, ...)
        → 2 个 atomic steps
   - submit_hypothesis / resolve_hypothesis
   - execute_sql 补刀,fetch_artifact 取详情
Phase 4: finalizeAnalysis():
   - 收集所有 StepResult + DataEnvelope
   - 跑 verifyFinalResult() / claimVerificationRunner
   - 生成最终 conclusion(SSE conclusion 事件)
Phase 5: 持久化 analysis-result snapshot
Phase 6: emit analysis_completed 事件
Phase 7: 关闭 SSE,归还 metrics
```

### 4.3 关键并行与依赖

```text
时间 ──────────────────────────────────────────────────────▶

[analyze 入口]
  ├─ classifyScene → 'game' (同步,< 1ms)
  ├─ detectFocusApps → Promise (后台)            ← §1.1
  ├─ complexity classifier → Promise (后台)      ← quick/full
  │
  ├─ buildSystemPrompt (game strategy 注入)      ← §2.2
  │
  ├─ Claude SDK 主循环 (query → tool → query)
  │    ├─ submit_plan
  │    ├─ detect_architecture
  │    ├─ invoke_skill(game_fps_analysis)        ← §3
  │    ├─ invoke_skill(game_main_loop_jank)      ← §3
  │    └─ ...
  │
  └─ finalize → conclusion → SSE analysis_completed
```

focus detection 与 complexity classifier **并行启动**,所以 1.1 节提到的 32s focus 耗时不会阻塞 classifier;classifier 自身的 30s 超时是另一个独立计时。

### 4.4 SQL 数据从 trace 到 UI 的完整链

```text
skill YAML 里写死的 SQL
  ↓ substituteVariables(${package} 等)
  ↓ injectSqlFragments(fragments/*.sql)
  ↓ buildSqlWithModuleIncludes(prerequisites.modules)
  ↓ queryTraceProcessor(traceId, finalSql)
        ↓ TraceProcessorService.query(traceId, sql, {signal})
              ↓ processorForQuery(traceId) → TraceProcessorPool.acquire()
                    ↓ 走 HTTP POST 127.0.0.1:<port>/
                    ↓ trace_processor_shell (subprocess)
                          ↓ 内部 Perfetto 解析 + 跑 PerfettoSQL
                          ↓ 返回 SSE/done + columns + rows
              ↓ TraceProcessorPool.release()
  ↓ rowsToObjects(columns, rows)
  ↓ DataEnvelope(...)
  ↓ MCP content: [{type:'text', text: JSON.stringify(envelope)}]
  ↓ Claude Agent SDK 把 envelope 作为 tool_result 喂回模型
  ↓ 模型决定下一步
```

每一跳都伴随 SSE `progress` 事件:`'analyzing' | 'starting'` 阶段的 `运行分析技能: X...` / `技能 X 完成 (Yms, N 个结果层)`。

### 4.5 数据多副本规则

`backend/.claude/rules/backend.md` 强调的"AI 输出多副本契约"在 game 场景下的具体落地点:

| 副本 | 路径 | 内容 |
|---|---|---|
| **运行时结论** | `AnalysisResult.conclusion`(`claudeRuntime.ts` finalize 段) | 全文 |
| **HTML 报告** | `/api/reports/*` + report export | 包含证据 / claim 验证 / 身份解析 / 附录 |
| **CLI turn artifacts** | `~/.smartperfetto/sessions/...jsonl` | 本次 session log + 完整步骤结果 |
| **Analysis-result snapshot** | `analysisResultSnapshotPipeline` | 可被后续 run / 对比引用 |
| **SSE chat 投影** | `conclusion` / `analysis_completed` 事件 | 给前端只显示关键结论,不喷 SQL/audit |
| **Frontend contract types** | `perfetto/.../generated/*.ts` | 由 `npm run generate:frontend-types` 生成,DataEnvelope 类型 |

**绝对不能改一个副本不动其他**——CLAUDE.md 明确要求"保持这些边界完整"。

### 4.6 verifier 与 claim 验证

`backend/src/services/verifier/claimVerificationRunner.ts` 在 finalize 阶段被调用:
- 抓 conclusion 里的每个 claim
- 比对 claim 与已收集 evidence(`DataEnvelope` + `claimSupportCount`)
- 跑 identity resolution(`processIdentityContractMapper` 等)
- 把 verified / unverified 状态写回 analysis-result snapshot
- 缺证据的 claim 标 `uncertainty`,而不是默默通过

### 4.7 本次 query 的预期执行轨迹

如果一切顺利(且没有 MiniMax-M3[1m] 这种 thinking 模型卡死),预期:

```text
T+0ms       analyze() 启动
T+~5ms      classifyScene('game'), focus detection 启动
T+~10ms     buildSystemPrompt 完成(game strategy 注入完毕)
T+~30s      focus detection 命中 (frame_timeline 或 oom_adj)
T+~30s      classifier 返回 quick 或 full(本地规则可能已命中)
T+~32s      Claude SDK 主循环首轮
T+~35s      submit_plan 通过(fps_and_gpu + engine_loop_jank)
T+~40s      detect_architecture 返回 STANDARD/FLUTTER/COMPOSE
T+~45s      invoke_skill('game_fps_analysis') 启动
T+~50s      3 个 atomic steps 跑完(SQL → DataEnvelope)
T+~55s      invoke_skill('game_main_loop_jank') 启动
T+~70s      2 个 atomic steps 跑完
T+~75s      submit_hypothesis 出现掉帧/卡顿根因候选
T+~90s      resolve_hypothesis + 补 execute_sql 验证
T+~110s     verifier / claim verification 跑完
T+~115s     conclusion emit 到 SSE
T+~120s     analysis_completed 事件 + snapshot 持久化
```

实际跑会因模型响应延迟、SQL 大小、trace_processor_shell 冷启动而拉长。本次观察到的是 thinking 模型把"AI 分析引擎已初始化"之后每轮拖到 10-30 秒。

### 4.8 SSE 事件协议

| 事件 | 类型 | 来源 | UI 表现 |
|---|---|---|---|
| `progress` | `{phase: starting/analyzing/starting}` | claudeRuntime / skillExecutor | 状态条 + 文字 |
| `data` | `DataEnvelope` 数组 | invoke_skill 返回后批量发出 | 渲染表格/图表 |
| `architecture_detected` | `{type, confidence, evidence[]}` | detect_architecture | 显示架构徽章 |
| `hypothesis_submitted` / `hypothesis_resolved` | 同 | MCP | 显示假设条目 |
| `plan_updated` | `{phase, expectedCalls}` | submit_plan | 显示当前 phase |
| `conclusion` | 终态前结论 | finalize | 主答案展示 |
| `analysis_completed` | 终态 | finalize 后 | 报告链接、快照 ID |

前端 `backend/src/agentv3/claudeMcpServer.ts` 的 `emitUpdate?.({type, content, timestamp})` 把这些事件投递到 SSE 通道。

---

## 5. 修改点速查(下次想改 game 这条链时)

| 想做什么 | 改哪里 |
|---|---|
| 加 game 关键字 / 改 compound pattern | `backend/strategies/game.strategy.md` 的 `keywords` / `compound_patterns` |
| 让 game 强制调某个 skill | `game.strategy.md` 的 `plan_template.mandatory_aspects` 加一项 |
| 让 game 在跑某 phase 时再注入提醒 | `game.strategy.md` 的 `phase_hints` 加一项 |
| 改 game 报告必检段落 | `game.strategy.md` 的 `final_report_contract.required_sections` |
| 改 FPS 算法阈值 | `game_fps_analysis.skill.yaml` 的 `thresholds` 或 step `save_as` 后的 SQL |
| 新增引擎(比如新增 "Egret" 引擎) | `game_main_loop_jank.skill.yaml` 的 GLOB 模式 + CASE WHEN |
| 让游戏场景快 1 秒 | 改 `backend/.env` 的 `CLAUDE_LIGHT_MODEL`(详见本文档外的前置讨论) |
| 让 focus 检测优先游戏包名 | 改 `focusAppDetector.ts` Tier 3 的排序(用 query 内出现的包名加权) |

---

## 6. 关键源码跳转表

| 主题 | 文件 | 关键行 |
|---|---|---|
| HTTP 入口 | `backend/src/routes/agentRoutes.ts` | 3145 (`router.post('/analyze', ...)`) |
| Runtime 工厂 | `backend/src/agentRuntime/runtimeSelection.ts` | full file |
| ClaudeRuntime 入口 | `backend/src/agentRuntime/engines/claude/claudeRuntime.ts` | 1031 (`analyze`) |
| 场景检测 | `backend/src/agentv3/sceneClassifier.ts` | 103 (`classifyScene`) |
| 焦点应用检测 | `backend/src/agentv3/focusAppDetector.ts` | 131 (`detectFocusApps`) |
| 复杂度分类 | `backend/src/agentv3/queryComplexityClassifier.ts` | 276 (`classifyQueryComplexity`) |
| 策略加载 | `backend/src/agentv3/strategyLoader.ts` | 363 (parseStrategyFile), 601 (baseStrategies) |
| System prompt 拼装 | `backend/src/agentv3/claudeSystemPrompt.ts` | 149 (sceneStrategySections), 591 (buildSystemPromptParts) |
| MCP server | `backend/src/agentv3/claudeMcpServer.ts` | 3053 (`invoke_skill`), 2763 (`execute_sql`), 3555 (`detect_architecture`), 5215 (`submit_plan`) |
| Skill 加载 | `backend/src/services/skillEngine/skillLoader.ts` | 333 (SkillRegistry), 1193 (ensureSkillRegistryInitialized) |
| Skill 执行 | `backend/src/services/skillEngine/skillExecutor.ts` | 2964 (`executeAtomicStep`), 3043 (checkPrerequisites) |
| Trace processor 池 | `backend/src/services/traceProcessorService.ts` | 549 (`query`), 1045 (`loadTraceFromFilePath`) |
| 架构检测 | `backend/src/agent/detectors/architectureDetector.ts` | 53 (`detectArchitectureViaSkill`) |
| Game strategy | `backend/strategies/game.strategy.md` | full file (157 lines) |
| Game FPS skill | `backend/skills/atomic/game_fps_analysis.skill.yaml` | full file (386 lines) |
| Game main loop skill | `backend/skills/atomic/game_main_loop_jank.skill.yaml` | full file (311 lines) |
| Verifier | `backend/src/services/verifier/claimVerificationRunner.ts` | full file |
| Normalizer | `backend/src/services/agentResultNormalizer.ts` | full file |
| Report contract gate | `backend/src/services/finalReportContractGate.ts` | full file |

---

## 7. 一句话总结

> SmartPerfetto 的"分析sgame游戏卡顿"执行链:**HTTP → ClaudeRuntime.analyze()** 在 `claudeRuntime.ts:1031` 同步启动 **3 件并行事**(焦点检测、复杂度分类、system prompt 拼装),**场景检测 0 延迟** 通过 `sceneClassifier.ts:103` 命中 `game`,**game strategy 正文** 通过 `claudeSystemPrompt.ts:149` 注入 prompt,agent 在 plan 守门(`game.strategy.md:48-62` 的 `fps_and_gpu` + `engine_loop_jank`)通过后,**`invoke_skill('game_fps_analysis')` 与 `invoke_skill('game_main_loop_jank')`** 通过 MCP `claudeMcpServer.ts:3053` 路由到 `skillExecutor.ts:2964` 的 atomic step,后者调用 `traceProcessorService.ts:549` 把 SQL POST 给 `trace_processor_shell`,拿回 DataEnvelope → 回到模型 → 收集证据 → `claimVerificationRunner` 验证 → SSE `conclusion` + `analysis_completed` 推到前端,全程多副本落入 session log / report / snapshot。