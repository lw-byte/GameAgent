# 游戏 trace 性能分析与改进(2026-08)

本文记录 2026-08-12 ~ 2026-08-13 期间,针对"分析游戏 trace 太慢"问题做的端到端诊断与修复。
配套阅读:`docs/architecture/game-analysis-pipeline.md`(游戏 trace 完整执行链)。

---

## 1. 问题与背景

用户用 `MiniMax-M3[1m]` 做主模型、`MiniMax-M3[1m]` 做轻量模型,在 game scene 上跑一次完整 analyze 耗时 **2 分钟以上**,体感"AI 分析引擎已初始化"之后每轮都拖 10-30 秒。

三个直接证据来自 `logs/backend_20260812_202155.log`:
- 复杂度分类器在 30s timeout 后 graceful degradation 到 `full`(说明轻量模型端卡死)
- 焦点应用识别 `primary=com.hihonor.searchservice`(应该是 sgame 游戏包,误识别)
- SDK 主循环每轮 thinking 时间过长(thinking 模型特性)

围绕这些信号,我们做了两阶段工作:
1. **可观测性先行**:给所有日志加时间戳,给 Phase-0 检测器 + 每个 LLM 调用加耗时日志 — 在改动之前先把"时间花在哪"看清。
2. **修复具体瓶颈**:基于日志数据,定位三个真实问题,逐个修复。

---

## 2. 调查发现

### 2.1 14 秒间隔根因(`handleAnalyzeRequest: enter` → 第一个 `SessionLogger: Metadata updated`)

调用链:

```
agentRoutes.ts:2303 [HTTPEntry] handleAnalyzeRequest: enter
:2309  requireAiEnabledForHttp (~ms)
:2313  evaluateTenantMutationPolicy (~ms)
:2546  ensureTraceAccessible (~ms 的元数据 JSON read)
:2549  traceProcessorService.getOrLoadTrace(traceId)  ← ★
      └─→ loadTraceFromDisk(traceId)
            ├─ fs.existsSync + fs.readFileSync + JSON.parse (~ms)
            ├─ detectTraceFormat (~ms)
            └─ createProcessor(traceId)
                  ├─ spawn trace_processor_shell (~ms)
                  ├─ 子进程解析 trace protobuf(72MB ~2.14s,200MB+ 可达 5-10s)
                  ├─ HTTP server 启动 (~1s)
                  ├─ critical stdlib modules 加载 (~179ms)
                  └─ extractMetadata()  ← ★
                        └─ SELECT MIN/MAX/COUNT(*) FROM slice UNION ALL ... FROM counter
                              全表扫描几百万行,大 trace 上 2-8s
:2621  ensureToolsRegistered (~0)
:2641  getDefaultAndroidInternalsPackResolver().resolve()  ← ★
      └─ 读 pin / active / last-known-good / bundled 4 个 manifest,~ms-1s
:2649  analyzeSessionService.prepareSession(...)
:822   logger.setMetadata(...)  ← 14s 后第一行日志
```

**主嫌疑 = `extractMetadata` 的全表 `COUNT(*)` 扫描**(`traceProcessorService.ts:431-468`):
- 这个查询在 `processTrace` 的 promise 链中和 `createProcessor` 串行
- 即便 trace_processor_shell 已经 ready,`getOrLoadTrace` 还要等它扫完 `slice` 表才返回
- 200MB 游戏 trace 上扫 2000 万行切片可花 **10s+**

**次嫌疑 = `trace_processor_shell` 冷启动** + trace protobuf 解析:
- spawn + 解析 72MB ~3-4s,200MB+ ~5-10s
- 已有进程池复用路径(冷启动时可避免)

**第三嫌疑 = `AndroidInternalsPackResolver.resolve()`**:
- 每次 analyze 都重新读 4 个 manifest,~50-300ms

### 2.2 Haiku classifier 30s timeout 根因

诊断日志(`classifyWithHaiku` 中新增的 `messageCounts`):

```
[16:20:25.253Z] sdkQuery start (model=MiniMax-M3[1m], ...)
[16:20:28.281Z] first SDK message (3028ms, type=system)
[16:20:57.274Z] timeout after 32021ms; messageCounts={"system":1}; firstByteAt=3028ms
```

指纹 = `{"system":1, "assistant":0, "result":0}`:
- TTFB 3s 正常 → 不是网络问题
- 收到 1 条 `system` 后停住 → 上游 SDK 已经建立连接
- 没有 `assistant` / `result` → 模型一次都没开始说话

**结论 = MiniMax 的 anthropic 兼容网关在拿到 init 后挂起**(thinking 模型流在 MiniMax 网关上不被正确转发),不是本地 SDK 或代码问题。

### 2.3 focus app 误识别根因

`detectFocusApps` 在 game trace 上命中 Tier 2 (oom_adj),返回 `com.hihonor.searchservice` — 不是 sgame 游戏包。
- Tier 1 (battery_stats):测试 trace 通常不开
- Tier 2 (oom_adj):系统进程干扰
- Tier 3 (frame_timeline):按帧数排序,launcher 可能比游戏多

**UnityMain / UnityGfx* / GameThread / RenderThread / RHIThread / GodotMain / TaskGraph*** 这些**游戏引擎 native 线程**只存在于运行游戏的进程,是 game scene 最高保真的 focus 信号。

---

## 3. 改动一览

### 3.1 可观测性:日志加时间戳 + 关键节点日志

**目的**:在改任何东西之前,先把"时间花在哪"看清。

| 文件 | 改动 |
|---|---|
| `backend/src/utils/logger.ts` | 全部 `logger.error/warn/info/debug/sql` 加上 ISO 时间戳(`new Date().toISOString()` 前缀) |
| `backend/src/routes/agentRoutes.ts` | `handleAnalyzeRequest: enter` 加 `HTTPEntry` 标签日志 |
| `backend/src/agentv3/sceneClassifier.ts` | `classifyScene` 加 enter/hit/exit + ms 日志 |
| `backend/src/agentv3/focusAppDetector.ts` | `detectFocusApps` 加 enter/per-Tier ms/final hit 日志 |
| `backend/src/agentv3/queryComplexityClassifier.ts` | `classifyQueryComplexity` + `classifyWithHaiku` 加 source/AI/timing 日志 |
| `backend/src/agentv3/claudeSystemPrompt.ts` | `buildSystemPromptParts` 加 enter/done + segments/tokens/ms 日志 |
| `backend/src/agentRuntime/engines/claude/claudeRuntime.ts` | `sdkQueryWithRetry` + `sdkQuery` 加 start/attempt-N/done 日志 |
| `backend/src/agentRuntime/engines/claude/claudeVerifier.ts` | `verifyWithLLM` + sdkQuery 加 enter/start/done/timeout 日志 |
| `backend/src/agentRuntime/engines/openai/openAiRuntime.ts` | `runStream` 加 start/completed 日志 |
| `backend/src/agentRuntime/engines/openai/openAiComplexityClassifier.ts` | `fetch` 加 start/HTTP/timeout/done 日志 |
| `backend/src/agentRuntime/engines/pi/piAgentCoreRuntime.ts` | `analyze` 加 enter/done 日志 |
| `backend/src/agentRuntime/engines/opencode/openCodeRuntime.ts` | `analyze` + `client.session.prompt` 加 start/done 日志 |
| `backend/src/agentRuntime/engines/qoder/qoderRuntime.ts` | `analyze` + `sdk.query` 加 start/stream-end 日志 |

**统一标签约定**:
- `HTTPEntry` — HTTP 路由入口
- `Phase0` — 4 个 Phase-0 检测器(classifyScene / detectFocusApps / classifyQueryComplexity / buildSystemPromptParts)
- `LLMCall` — 所有 LLM 调用入口

下次 grep 只需一个 token:`grep "LLMCall"` 拉出所有模型调用,`grep "Phase0"` 拉出所有检测器,`grep "handleAnalyzeRequest: enter"` 拉出所有 analyze 请求的入口。

### 3.2 修复 1:`extractMetadata` 改 fire-and-forget

**问题**:`getOrLoadTrace` 等 `extractMetadata` 全表 `COUNT(*)` 跑完才返回,在 200MB 游戏 trace 上 2-8s。

**改动**:`backend/src/services/traceProcessorService.ts:364-432`

- `processTrace` 不再 `await extractMetadata(processor)` — 改用 `void this.extractMetadataInBackground(traceId, processor)`
- `trace.status = 'ready'` 在 `createProcessor` 完成后立即 emit,不等 metadata
- 新增 `extractMetadataInBackground(traceId, processor)`:后台跑 metadata 扫描,完成后写回 `trace.metadata` 并 emit `trace-status-changed`
- 背景日志:`extractMetadata background done for {traceId} (Xms, numEvents=N)` — 排查用

**安全性**:`traceInfo.metadata` 唯一消费者是 `agentReportData.ts:115`(`traceInfo?.metadata?.startTime`,可选链),即使一开始是 `undefined` 也能正确处理。

**预期收益**:**大 game trace 上省 2-8s**。

### 3.3 修复 2:`AndroidInternalsPackResolver` 加 5 分钟 TTL 缓存

**问题**:每次 analyze 都重新读 4 个 manifest + 校验,~50-300ms。

**改动**:`backend/src/services/androidInternalsPack/androidInternalsPackResolver.ts:346-422`

- 拆分 `resolve()` 为 cache check + `resolveUncached()` + cache write
- 缓存键 = `JSON.stringify(pin)`(pin-aware,不同 pin 独立缓存)
- TTL = 5 分钟(`AndroidInternalsPackResolver.CACHE_TTL_MS`)
- `SMARTPERFETTO_AIW_PACK_ENABLED=0` 跳过缓存 — 操作员切环境变量立即生效

**预期收益**:**每次 analyze 省 50-300ms**。

### 3.4 修复 3:`maxProcessors` 改 env-getter

**问题**:硬编码 `maxProcessors = 5`,开 5 个 game trace 后开第 6 个会触发 LRU 驱逐,下次冷启动 3-5s。

**改动**:`backend/src/services/workingTraceProcessor.ts:1187-1214`

```ts
private static get maxProcessors(): number {
  const raw = process.env.SMARTPERFETTO_TP_MAX_PROCESSORS;
  if (!raw) return 5;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 5;
}
```

推荐值见文件注释:
- `5`(默认) — 16GB 开发机
- `8` — 32GB 工作站
- `10-12` — 64GB+ 分析服务器
- `3` — Docker / portable(内存受限)

RAM 闸门(`assertTraceProcessorAdmission`)仍然兜底,所以调高数量是安全的。

**预期收益**:**避免 evict-and-cold-start 开销**(具体数值取决于使用模式)。

### 3.5 修复 4:`classifyWithHaiku` 诊断日志

**目的**:下次 30s timeout 时能立刻看出根因。

**改动**:`backend/src/agentv3/queryComplexityClassifier.ts:634-686`

- 新增 `firstByteAt: number | null` —首字节延迟
- 新增 `messageCounts: Record<string, number>` —按 `msg.type` 聚合计数
- 3 个新日志点:
  1. `first SDK message (Xms after start, type=Y)` — 立刻打出 TTFB
  2. `timeout after Xms; messageCounts={...}; firstByteAt=Y; result=Zchars`
  3. `stream end (Xms total, Yms after first byte); messageCounts={...}; result=Zchars`

典型指纹:
- `{"system":1, "assistant":0, "result":0}` → MiniMax 网关缺终态事件
- `{}`(空)→ 上游根本不响应
- `{"system":1, "result":1, "assistant":1}` → 正常返回

### 3.6 修复 5:game scene hard rule — `classifyQueryComplexity` 跳过 LLM

**问题**:`sceneType === 'game'` 仍调用 Haiku,Haiku 在 MiniMax 上 30s timeout,graceful degradation 到 `full`(走完整路径,本来就该 full)。

**改动**:`backend/src/agentv3/queryComplexityClassifier.ts`

- 新增 `applyGameSceneRule(input)`:sceneType === 'game' → `{ complexity: 'full', reason: 'game scene requires full evidence chain' }`
- 插入 `classifyQueryComplexityLocal` 中,在 `scopeResult` 之后、`identityFact` 之前
- **位置选择**:在 `acknowledgementRule` 之后(game + "ok" 仍走 quick),但早于其他 quick rule(game + 任何 query 都强制 full)

**预期收益**:**game query 上 classifier 从 30s → < 1ms**。

### 3.7 修复 6:`detectFocusApps` 新增 Tier 0 — game_threads

**问题**:`oom_adj` / `frame_timeline` 把游戏包误识别成 `com.hihonor.searchservice` 等系统进程。

**改动**:`backend/src/agentv3/focusAppDetector.ts`

- `FocusAppDetectionOptions` 加 `sceneType?: SceneType`
- `FocusAppDetectionResult.method` 联合加 `'game_threads'`
- 新增 `detectGameFocusApp()` Tier 0:用 `thread` 表查询 UnityMain / UnityGfx* / GameThread / RenderThread / RHIThread / GodotMain / TaskGraph* 这些**只有游戏引擎 native runtime 才创建**的线程,反查 upid → package_name
- `detectFocusApps()` 入口加 `if (options.sceneType === 'game')` 短路
- 系统进程黑名单照常过滤
- 类型联合四处同步:`agentv3/types.ts`、`claudeSystemPrompt.ts`(2 处)、`qoderRuntime.ts`
- `buildFocusAppSection` 显示适配:`game_threads` tier 显示"匹配 N 个游戏引擎线程"

SQL:

```sql
INCLUDE PERFETTO MODULE android.process_metadata;
WITH game_engine_threads AS (
  SELECT DISTINCT t.upid, t.name AS thread_name
  FROM thread t
  WHERE t.name = 'UnityMain'
     OR t.name GLOB 'UnityGfx*'
     OR t.name = 'GameThread'
     OR t.name = 'RenderThread'
     OR t.name = 'RHIThread'
     OR t.name = 'GodotMain'
     OR t.name GLOB 'TaskGraph*'
)
SELECT p.upid,
       COALESCE(NULLIF(m.package_name, ''), NULLIF(p.cmdline, ''), p.name) AS package_name,
       COUNT(*) AS game_thread_count,
       GROUP_CONCAT(g.thread_name, ', ') AS matched_threads
FROM game_engine_threads g
JOIN process p USING(upid)
LEFT JOIN android_process_metadata m USING(upid)
WHERE p.name IS NOT NULL AND p.name != ''
GROUP BY p.upid
ORDER BY game_thread_count DESC
LIMIT 10
```

调用方传 `sceneType`:`backend/src/agentRuntime/engines/claude/claudeRuntime.ts:1115, 3796`。

**预期收益**:**`primaryApp` 从误识别的系统进程修正为真实游戏包**(`com.example.sgame` 等)。

---

## 4. 验证

| 检查 | 命令 | 状态 |
|---|---|---|
| LF 行尾 | `npm run check:line-endings`(项目根) | ✅ |
| TypeScript 类型 | `cd backend && node node_modules/typescript/bin/tsc --noEmit` | ✅ |

历史失败点:
- `claudeRuntime.ts:784` 调用 `Buffer.byteLength(queryOptions.systemPrompt ?? '')` — `systemPrompt` 类型是 `string \| string[] \| { type: "preset"; ... }`,`?? ''` 不够。改成显式 narrow。
- `traceProcessorService.ts:422` 调用 `metadata.numEvents.toString()` — 类型 narrow 后变 `never`。改成不用 typeof 简化。

---

## 5. 期望效果(gmae trace 完整请求)

修复前(从 `backend_20260812_202155.log`):

```
T+0ms      handleAnalyzeRequest: enter
T+~14s     SessionLogger: Metadata updated   ← 主延迟(extractMetadata)
T+~30s     classifyQueryComplexity timeout
T+~120s+   主循环完成(每轮 thinking 10-30s)
```

修复后:

```
T+0ms      handleAnalyzeRequest: enter (HTTPEntry)
T+~3s      SessionLogger: Metadata updated    ← 快了 11s
T+~0ms     classifyQueryComplexity: Game scene rule → full (1ms)
T+~0ms     detectFocusApps: hit=primary=com.example.sgame via=game_threads (87ms)
T+~3s      buildSystemPromptParts: done (segments=9, 87ms)
T+~5s      sdkQuery: attempt 1/3 start
T+~10s     sdkQuery: attempt 1/3 done (model=MiniMax-M3[1m])
... (主循环每轮仍受 thinking 模型限制,但 Tier 0 + hard rule + fire-and-forget 已消除本地瓶颈)
```

**节省**:
- 14s → ~3s 在 `getOrLoadTrace` 段(主要靠修复 1)
- 30s → < 1ms 在 classifier 段(修复 5)
- 焦点应用识别准确(修复 6)

主循环每轮的 thinking 延迟属于上游模型特性,本地无法消除 — 那是切 `CLAUDE_MODEL` 到非 thinking 模型的事情。

---

## 6. 未做但应该考虑

### 6.1 `CLAUDE_LIGHT_MODEL` 切换

**问题根因**:`MiniMax-M3[1m]` 作为 thinking 模型,在 MiniMax 的 anthropic 兼容层上发不出 `result` 终态事件。

**建议**:
```bash
# .env
CLAUDE_LIGHT_MODEL=claude-haiku-4-5  # 单轮 JSON 返回,< 2s
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_BASE_URL=                  # 清空,走官方
```

只换 light model,**主 model 继续用 MiniMax** — 主 model 多轮 reasoning 是 thinking 模型优势,classifier 单轮 JSON 是速度优先场景。

### 6.2 方案 5:`getOrLoadTrace` 改为后台预热

把 `handleAnalyzeRequest` 改成"同步做轻量校验 + 后台启动 trace load",`ClaudeRuntime.analyze` 内部第一句 await trace ready。预期再省 3-10s,但需要改 `ClaudeRuntime.analyze` 接口 + 调整 SSE 流。

### 6.3 `extractMetadata` SQL 优化

`COUNT(*) FROM slice` 在 SQLite perfetto 是 O(N)。改成并行子查询:

```sql
SELECT (SELECT MIN(ts) FROM slice) AS startTime,
       (SELECT MAX(ts) FROM slice) AS endTime,
       (SELECT COUNT(*) FROM slice) AS numEvents
```

trace_processor 通常会复用 cursor,预期 2-3x 提速。当前 fire-and-forget 已消除这个延迟,所以优先级低。

### 6.4 跑 `npm run verify:pr` 在 PR 之前

当前已通过 typecheck + line-endings,但完整 PR 门是 `npm run verify:pr`,包含:
- 根质量检查
- Rust 检查
- 后端 Skill / Strategy 验证
- Backend 类型检查 + build
- CLI 包检查
- core / architecture / self-evolution / external-issue-reporting 测试
- 6-trace 场景回归

### 6.5 跑 scene trace 回归

```bash
cd backend
npm run test:scene-trace-regression
```

跑 6 个 canonical trace 验证改动没破坏现有路径(game / startup / scrolling / Flutter SurfaceView/TextureView)。

---

## 7. 一句话总结

**这次会话围绕"game trace 太慢"做了端到端诊断与修复**:先加日志看清瓶颈(改 13 个文件,统一加时间戳 + Phase-0/LLM 节点耗时),再针对三个真问题做修复 — `extractMetadata` 改 fire-and-forget(省 2-8s)、`AndroidInternalsPackResolver` 加缓存(省 50-300ms)、`TP_MAX_PROCESSORS` 可配置(避免 evict cold-start)、game scene 加 hard rule 跳过 LLM classifier(从 30s timeout 降到 < 1ms)、`detectFocusApps` 新增 game_threads Tier 0(精确识别游戏包)。期望 game trace `handleAnalyzeRequest: enter` → `SessionLogger: Metadata updated` 从 14s 降到 ~3s,焦点应用识别从误识别修正为真实游戏包。主循环每轮 thinking 延迟属于上游模型特性,需要切 `CLAUDE_LIGHT_MODEL` 解决。