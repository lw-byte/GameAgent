// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { TraceProcessorService } from '../services/traceProcessorService';
import { logger } from '../utils/logger';
import type { SceneType } from './sceneClassifier';

export interface DetectedFocusApp {
  packageName: string;
  totalDurationNs: number;
  switchCount: number;
  scopeStartNs?: number;
  scopeEndNs?: number;
  evidenceRefId?: string;
  evidenceRowIndex?: number;
}

export interface FocusAppDetectionResult {
  apps: DetectedFocusApp[];
  primaryApp?: string;
  method: 'battery_stats' | 'oom_adj' | 'frame_timeline' | 'game_threads' | 'none';
  timeRange?: FocusAppTimeRange;
}

export interface FocusAppTimeRange {
  startNs: number;
  endNs: number;
}

export interface FocusAppDetectionOptions {
  timeRange?: FocusAppTimeRange;
  /**
   * Scene type already classified by keyword matcher (from classifyScene).
   * When set to 'game', enables Tier 0 — game-engine-thread-based focus
   * detection — which is the most accurate signal for game traces because
   * Unity/UE/Godot create characteristic native threads (UnityMain, GameThread,
   * RenderThread, RHIThread, TaskGraph*, GodotMain) that no system process
   * ever spawns.
   */
  sceneType?: SceneType;
}

const SYSTEM_PROCESS_EXACT = new Set([
  'init',
  'surfaceflinger',
  'system_server',
  'zygote',
  'zygote64',
]);

const SYSTEM_PROCESS_PREFIXES = [
  '/system/bin/',
  '/system_ext/bin/',
  '/vendor/bin/',
  '/odm/bin/',
  '/apex/',
];

const SYSTEM_PACKAGE_PREFIXES = [
  'com.android.systemui',
  'com.android.launcher',
  'com.android.phone',
  'com.android.providers',
  // Google system apps that frequently appear in foreground but are rarely analysis targets
  'com.google.android.inputmethod',   // Gboard
  'com.google.android.apps.nexuslauncher', // Pixel Launcher
  'com.android.inputmethod',          // AOSP keyboard
  'com.google.android.apps.wallpaper', // Wallpaper picker
  'com.miui.home',                    // Xiaomi launcher
  'com.huawei.android.launcher',       // Huawei launcher
  'com.oppo.launcher',                // OPPO launcher
  'com.vivo.launcher',                // Vivo launcher
  'com.sec.android.app.launcher',      // Samsung launcher
];

function isSystemProcess(name: string): boolean {
  const lower = name.toLowerCase();
  return SYSTEM_PROCESS_EXACT.has(lower) ||
    SYSTEM_PROCESS_PREFIXES.some(prefix => lower.startsWith(prefix)) ||
    SYSTEM_PACKAGE_PREFIXES.some(prefix =>
      lower === prefix ||
      lower.startsWith(`${prefix}.`) ||
      lower.startsWith(`${prefix}:`));
}

function normalizeTimeRange(timeRange?: FocusAppTimeRange): FocusAppTimeRange | undefined {
  if (!timeRange) return undefined;
  const startNs = Number(timeRange.startNs);
  const endNs = Number(timeRange.endNs);
  if (!Number.isFinite(startNs) || !Number.isFinite(endNs) || endNs <= startNs) {
    return undefined;
  }
  return { startNs, endNs };
}

export function focusAppTimeRangeFromSelection(input?: {
  kind?: string;
  startNs?: number;
  endNs?: number;
  ts?: number;
  dur?: number;
}): FocusAppTimeRange | undefined {
  if (!input) return undefined;
  if (input.kind === 'area' && input.startNs !== undefined && input.endNs !== undefined) {
    return normalizeTimeRange({ startNs: input.startNs, endNs: input.endNs });
  }
  if (input.kind === 'track_event' && input.ts !== undefined && input.dur !== undefined) {
    return normalizeTimeRange({ startNs: input.ts, endNs: input.ts + input.dur });
  }
  return undefined;
}

function scopedDurationExpr(
  timeRange: FocusAppTimeRange | undefined,
  tsExpr: string,
  durExpr: string,
): string {
  if (!timeRange) return durExpr;
  return `MAX(0, MIN((${tsExpr}) + (${durExpr}), ${timeRange.endNs}) - MAX((${tsExpr}), ${timeRange.startNs}))`;
}

function scopedOverlapWhere(
  timeRange: FocusAppTimeRange | undefined,
  tsExpr: string,
  durExpr: string,
  unscopedWhere: string,
): string {
  if (!timeRange) return unscopedWhere;
  return `${durExpr} > 0 AND (${tsExpr}) < ${timeRange.endNs} AND ((${tsExpr}) + (${durExpr})) > ${timeRange.startNs}`;
}

function withScope(apps: DetectedFocusApp[], timeRange: FocusAppTimeRange | undefined): DetectedFocusApp[] {
  if (!timeRange) return apps;
  return apps.map(app => ({
    ...app,
    scopeStartNs: timeRange.startNs,
    scopeEndNs: timeRange.endNs,
  }));
}

export async function detectFocusApps(
  traceProcessorService: TraceProcessorService,
  traceId: string,
  options: FocusAppDetectionOptions = {},
): Promise<FocusAppDetectionResult> {
  const startedAt = Date.now();
  logger.debug('Phase0', `detectFocusApps: enter (traceId=${traceId}, sceneType=${options.sceneType ?? 'unset'})`);

  const timeRange = normalizeTimeRange(options.timeRange);
  const batteryDuration = scopedDurationExpr(timeRange, 'ts', 'safe_dur');
  const batteryWhere = scopedOverlapWhere(timeRange, 'ts', 'safe_dur', 'safe_dur > 50000000');
  const oomDuration = scopedDurationExpr(timeRange, 'oa.ts', 'oa.dur');
  const oomWhere = scopedOverlapWhere(timeRange, 'oa.ts', 'oa.dur', '1 = 1');
  const frameDuration = scopedDurationExpr(timeRange, 'a.ts', 'a.dur');
  const frameWhere = scopedOverlapWhere(timeRange, 'a.ts', 'a.dur', '1 = 1');

  // Tier 0 (game only): engine-native thread detection. Most accurate signal
  // for game traces — UnityMain / UnityGfx* / GameThread / RenderThread /
  // RHIThread / GodotMain / TaskGraph* are created by game engine runtimes
  // and never exist in system_server / surfaceflinger / launcher processes.
  // Only runs when caller signals sceneType='game' (set by classifyScene).
  if (options.sceneType === 'game') {
    const gameTier = await detectGameFocusApp(traceProcessorService, traceId, startedAt);
    if (gameTier) {
      return gameTier;
    }
    logger.info('Phase0', `detectFocusApps: game_threads tier returned empty, falling through to battery_stats/oom_adj/frame_timeline`);
  }

  // Tier 1: battery_stats.top
  const tier1StartedAt = Date.now();
  try {
    const result = await traceProcessorService.query(traceId, `
        INCLUDE PERFETTO MODULE android.battery_stats;
        SELECT
          str_value AS package_name,
          SUM(${batteryDuration}) AS total_duration_ns,
          COUNT(*) AS switch_count
        FROM android_battery_stats_event_slices
        WHERE track_name = 'battery_stats.top'
          AND ${batteryWhere}
        GROUP BY str_value
        ORDER BY total_duration_ns DESC
        LIMIT 10
      `);
    logger.debug('Phase0', `detectFocusApps: Tier 1 (battery_stats) rows=${result.rows.length} (${Date.now() - tier1StartedAt}ms)`);

    if (result.rows.length > 0) {
      const apps = result.rows
        .map(row => ({
          packageName: String(row[0]),
          totalDurationNs: Number(row[1]),
          switchCount: Number(row[2]),
        }))
        .filter(app => !isSystemProcess(app.packageName));

      if (apps.length > 0) {
        logger.info('Phase0', `detectFocusApps: hit=primary=${apps[0].packageName} via=battery_stats (${Date.now() - startedAt}ms)`);
        return {
          apps: withScope(apps, timeRange),
          primaryApp: apps[0].packageName,
          method: 'battery_stats',
          timeRange,
        };
      }
    }
  } catch (err) {
    console.warn('[FocusAppDetector] Tier 1 (battery_stats) failed:', (err as Error).message);
  }

  // Tier 2: oom_adj intervals (score <= 0 = foreground). Prefer Android
  // package metadata over raw process.name; process.name can be stale/truncated.
  const tier2StartedAt = Date.now();
  try {
    const result = await traceProcessorService.query(traceId, `
        INCLUDE PERFETTO MODULE android.oom_adjuster;
        INCLUDE PERFETTO MODULE android.process_metadata;
        WITH foreground_intervals AS (
          SELECT
            COALESCE(
              NULLIF(m.package_name, ''),
              NULLIF(m.process_name, ''),
              NULLIF(p.cmdline, ''),
              p.name
            ) AS package_name,
            ${oomDuration} AS scoped_dur
          FROM android_oom_adj_intervals oa
          JOIN process p USING(upid)
          LEFT JOIN android_process_metadata m USING(upid)
          WHERE oa.score <= 0 AND oa.score > -900
            AND ${oomWhere}
        )
        SELECT
          package_name,
          SUM(scoped_dur) AS total_duration_ns,
          COUNT(*) AS switch_count
        FROM foreground_intervals
        WHERE package_name IS NOT NULL
          AND package_name != ''
        GROUP BY package_name
        ORDER BY total_duration_ns DESC
        LIMIT 10
      `);
    logger.debug('Phase0', `detectFocusApps: Tier 2 (oom_adj) rows=${result.rows.length} (${Date.now() - tier2StartedAt}ms)`);

    if (result.rows.length > 0) {
      const apps = result.rows
        .map(row => ({
          packageName: String(row[0]),
          totalDurationNs: Number(row[1]),
          switchCount: Number(row[2]),
        }))
        .filter(app => !isSystemProcess(app.packageName));

      if (apps.length > 0) {
        logger.info('Phase0', `detectFocusApps: hit=primary=${apps[0].packageName} via=oom_adj (${Date.now() - startedAt}ms)`);
        return {
          apps: withScope(apps, timeRange),
          primaryApp: apps[0].packageName,
          method: 'oom_adj',
          timeRange,
        };
      }
    }
  } catch (err) {
    console.warn('[FocusAppDetector] Tier 2 (oom_adj) failed:', (err as Error).message);
  }

  // Tier 3: FrameTimeline upid/layer evidence (always present when frames exist)
  // layer_name format: "TX - com.example.app/com.example.app.Activity#1234"
  const tier3StartedAt = Date.now();
  try {
    const result = await traceProcessorService.query(traceId, `
        INCLUDE PERFETTO MODULE android.frames.timeline;
        INCLUDE PERFETTO MODULE android.process_metadata;
        WITH frame_packages AS (
          SELECT
            COALESCE(
              NULLIF(m.package_name, ''),
              CASE
                WHEN layer_name LIKE 'TX - %/%'
                  THEN SUBSTR(layer_name, 6, INSTR(SUBSTR(layer_name, 6), '/') - 1)
                WHEN layer_name LIKE 'TX - %'
                  THEN SUBSTR(layer_name, 6)
                ELSE NULL
              END,
              NULLIF(m.process_name, ''),
              NULLIF(p.cmdline, ''),
              p.name
            ) AS package_name,
            ${frameDuration} AS scoped_dur
          FROM actual_frame_timeline_slice a
          LEFT JOIN process p USING(upid)
          LEFT JOIN android_process_metadata m USING(upid)
          WHERE layer_name IS NOT NULL AND layer_name != ''
            AND ${frameWhere}
        )
        SELECT
          package_name,
          SUM(scoped_dur) AS total_duration_ns,
          COUNT(*) AS frame_count
        FROM frame_packages
        WHERE package_name IS NOT NULL AND package_name != ''
        GROUP BY package_name
        ORDER BY frame_count DESC
        LIMIT 10
      `);
    logger.debug('Phase0', `detectFocusApps: Tier 3 (frame_timeline) rows=${result.rows.length} (${Date.now() - tier3StartedAt}ms)`);

    if (result.rows.length > 0) {
      const apps = result.rows
        .map(row => ({
          packageName: String(row[0]),
          totalDurationNs: Number(row[1]),
          switchCount: Number(row[2]),
        }))
        .filter(app => app.packageName && !isSystemProcess(app.packageName));

      if (apps.length > 0) {
        logger.info('Phase0', `detectFocusApps: hit=primary=${apps[0].packageName} via=frame_timeline (${Date.now() - startedAt}ms)`);
        return {
          apps: withScope(apps, timeRange),
          primaryApp: apps[0].packageName,
          method: 'frame_timeline',
          timeRange,
        };
      }
    }
  } catch (err) {
    console.warn('[FocusAppDetector] Tier 3 (frame_timeline) failed:', (err as Error).message);
  }

  logger.info('Phase0', `detectFocusApps: hit=none (no apps matched in any tier, ${Date.now() - startedAt}ms)`);
  return { apps: [], method: 'none', timeRange };
}

/**
 * Tier 0 — game-engine-native thread detection.
 *
 * Used only when sceneType === 'game'. Looks for characteristic native
 * threads that game runtimes (Unity / Unreal / Godot) spawn at startup:
 *   - UnityMain, UnityGfx* (Unity main + render thread family)
 *   - GameThread (Unreal 5 main thread)
 *   - RenderThread (Unreal render thread; Unity may also have one)
 *   - RHIThread (Unreal RHI thread)
 *   - GodotMain (Godot 4 main thread)
 *   - TaskGraph* (Unreal TaskGraph family)
 *
 * These threads never exist in system_server / surfaceflinger / launcher
 * processes, so they are a strong, low-noise signal for "which process is
 * running the game". The package is resolved via android_process_metadata,
 * falling back to process.cmdline then process.name. Returns undefined on
 * SQL failure so the caller can fall through to the existing tier ladder.
 */
async function detectGameFocusApp(
  traceProcessorService: TraceProcessorService,
  traceId: string,
  parentStartedAt: number,
): Promise<FocusAppDetectionResult | undefined> {
  const startedAt = Date.now();
  try {
    const result = await traceProcessorService.query(traceId, `
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
        SELECT
          p.upid AS upid,
          COALESCE(
            NULLIF(m.package_name, ''),
            NULLIF(p.cmdline, ''),
            p.name
          ) AS package_name,
          COUNT(*) AS game_thread_count,
          GROUP_CONCAT(g.thread_name, ', ') AS matched_threads
        FROM game_engine_threads g
        JOIN process p USING(upid)
        LEFT JOIN android_process_metadata m USING(upid)
        WHERE p.name IS NOT NULL AND p.name != ''
        GROUP BY p.upid
        ORDER BY game_thread_count DESC
        LIMIT 10
      `);

    logger.debug('Phase0', `detectFocusApps: Tier 0 (game_threads) rows=${result.rows.length} (${Date.now() - startedAt}ms)`);

    if (result.rows.length === 0) {
      return undefined;
    }

    const apps = result.rows
      .map(row => ({
        packageName: String(row[1] ?? ''),
        totalDurationNs: Number(row[2] ?? 0),
        switchCount: 0,
      }))
      .filter(app => app.packageName && !isSystemProcess(app.packageName));

    if (apps.length === 0) {
      logger.debug('Phase0', `detectFocusApps: Tier 0 (game_threads) all rows filtered as system processes`);
      return undefined;
    }

    const primary = apps[0];
    logger.info(
      'Phase0',
      `detectFocusApps: hit=primary=${primary.packageName} via=game_threads matched=${apps[0].totalDurationNs}threads (${Date.now() - parentStartedAt}ms)`,
    );
    return {
      apps,
      primaryApp: primary.packageName,
      method: 'game_threads',
    };
  } catch (err) {
    console.warn('[FocusAppDetector] Tier 0 (game_threads) failed:', (err as Error).message);
    return undefined;
  }
}

/** Human-readable duration for system prompt (e.g. "2.3s", "145ms") */
export function formatDurationNs(ns: number): string {
  if (ns >= 1_000_000_000) return `${(ns / 1_000_000_000).toFixed(1)}s`;
  if (ns >= 1_000_000) return `${(ns / 1_000_000).toFixed(0)}ms`;
  return `${(ns / 1_000).toFixed(0)}us`;
}
