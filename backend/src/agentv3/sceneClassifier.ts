// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Keyword-based scene classifier for progressive prompt disclosure.
 * Classifies user queries into scene types to inject only relevant
 * analysis strategies into the system prompt, saving ~3500 tokens
 * for non-scrolling queries.
 *
 * Keywords and compound patterns are loaded from external strategy files
 * (`backend/strategies/*.strategy.md`), not hardcoded here.
 *
 * Pure keyword matching — no LLM calls, <1ms execution.
 */

import { getRegisteredScenes } from './strategyLoader';
import { logger } from '../utils/logger';

export type SceneType = string;

function isAsciiIdentifierChar(ch: string): boolean {
  return /^[A-Za-z0-9_]$/.test(ch);
}

function isAsciiKeyword(keyword: string): boolean {
  return /^[\x00-\x7F]+$/.test(keyword);
}

function matchesAsciiKeywordWithBoundary(lowerQuery: string, lowerKeyword: string): boolean {
  let offset = lowerQuery.indexOf(lowerKeyword);
  while (offset !== -1) {
    const before = offset > 0 ? lowerQuery[offset - 1] : '';
    const afterOffset = offset + lowerKeyword.length;
    const after = afterOffset < lowerQuery.length ? lowerQuery[afterOffset] : '';
    const hasStartBoundary = !before || !isAsciiIdentifierChar(before);
    const hasEndBoundary = !after || !isAsciiIdentifierChar(after);
    if (hasStartBoundary && hasEndBoundary) return true;
    offset = lowerQuery.indexOf(lowerKeyword, offset + 1);
  }
  return false;
}

function isUpperAscii(ch: string): boolean {
  return /^[A-Z]$/.test(ch);
}

function isLowerAscii(ch: string): boolean {
  return /^[a-z]$/.test(ch);
}

function isCamelBoundaryBefore(query: string, offset: number): boolean {
  if (offset <= 0) return true;
  const before = query[offset - 1] ?? '';
  const current = query[offset] ?? '';
  return isAsciiIdentifierChar(before) && isUpperAscii(current);
}

function isCamelBoundaryAfter(query: string, offset: number): boolean {
  if (offset >= query.length) return true;
  const before = query[offset - 1] ?? '';
  const current = query[offset] ?? '';
  return !isAsciiIdentifierChar(current) || (isLowerAscii(before) && isUpperAscii(current));
}

function matchesLongAsciiKeywordAtCamelBoundary(query: string, lowerQuery: string, lowerKeyword: string): boolean {
  // Short generic scene words like "scroll", "frame", and "startup" remain
  // boundary-only; long component terms such as ScrollView/RecyclerView can
  // match inside CamelCase class names without reopening rcustomscroller-style
  // substring false positives.
  if (lowerKeyword.length < 8) return false;
  let offset = lowerQuery.indexOf(lowerKeyword);
  while (offset !== -1) {
    const afterOffset = offset + lowerKeyword.length;
    if (isCamelBoundaryBefore(query, offset) && isCamelBoundaryAfter(query, afterOffset)) {
      return true;
    }
    offset = lowerQuery.indexOf(lowerKeyword, offset + 1);
  }
  return false;
}

function matchesKeyword(query: string, lowerQuery: string, keyword: string): boolean {
  const normalizedKeyword = keyword.trim();
  if (!normalizedKeyword) return false;
  const lowerKeyword = normalizedKeyword.toLowerCase();
  // ASCII scene keywords must not match inside identifiers. Component/class
  // names that should match, such as RecyclerView, belong in strategy keywords.
  if (isAsciiKeyword(normalizedKeyword)) {
    return matchesAsciiKeywordWithBoundary(lowerQuery, lowerKeyword)
      || matchesLongAsciiKeywordAtCamelBoundary(query, lowerQuery, lowerKeyword);
  }
  return query.includes(normalizedKeyword) || lowerQuery.includes(lowerKeyword);
}

/**
 * Classify a user query into a scene type for prompt strategy injection.
 * Returns 'general' when no specific scene is matched — Claude will use
 * list_skills to self-discover appropriate analysis tools.
 *
 * Scenes are matched by priority (lower = higher priority):
 *   ANR (1) → startup (2) → scrolling (3) → interaction (4) → overview (5) → general (99)
 */
export function classifyScene(query: string): SceneType {
  const startedAt = Date.now();
  logger.debug('Phase0', `classifyScene: enter (queryLength=${query.length})`);

  const scenes = getRegisteredScenes();
  const lower = query.toLowerCase();

  // Sort by priority (ascending), exclude 'general' from active matching
  const sorted = scenes
    .filter(s => s.scene !== 'general')
    .sort((a, b) => a.priority - b.priority);

  for (const scene of sorted) {
    // Compound patterns first (more specific)
    if (scene.compoundPatterns.length > 0 && scene.compoundPatterns.some(p => p.test(query))) {
      const elapsedMs = Date.now() - startedAt;
      logger.debug('Phase0', `classifyScene: hit=${scene.scene} via compound_pattern (${elapsedMs}ms)`);
      return scene.scene;
    }
    // Then keyword matching
    if (scene.keywords.some(k => matchesKeyword(query, lower, k))) {
      const elapsedMs = Date.now() - startedAt;
      logger.debug('Phase0', `classifyScene: hit=${scene.scene} via keyword (${elapsedMs}ms)`);
      return scene.scene;
    }
  }

  const elapsedMs = Date.now() - startedAt;
  logger.debug('Phase0', `classifyScene: hit=general (no match, ${elapsedMs}ms)`);
  return 'general';
}
