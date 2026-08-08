#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Gracker. All rights reserved.
//
// check-line-endings.mjs
//
// Enforce the repository's LF canonical line ending.
//
// Walks every tracked file, asks Git for its authoritative text/binary
// classification (via `git ls-files --eol`), then scans the working tree
// for stray CR (\r) bytes. Files Git considers binary (`-text`) are
// skipped. Files under any `linguist-generated` path are also skipped
// (e.g. `frontend/v*/**`, `report-sample/**`) so re-emitted bundles do not
// churn.
//
// Usage:
//   node scripts/check-line-endings.mjs              # read-only check, exit 1 on violations
//   node scripts/check-line-endings.mjs --write      # rewrite offending files in place (CR -> LF)
//
// The script uses pure Node + git plumbing only; no third-party deps.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const ROOT = process.cwd();
const WRITE = process.argv.includes('--write');

// --- 1. Authoritative text/binary classification from `git ls-files --eol` ---
// Output format (one record per line):
//   <i-eol>\t<w-eol>\t[attr/<attrs>]\t<path>
// Binary files show `i/-text w/-text`. We treat anything that begins with
// `i/-text` as binary and skip it.
const ls = spawnSync('git', ['ls-files', '-z', '--eol'], { cwd: ROOT, encoding: 'buffer' });
if (ls.status !== 0) {
  process.stderr.write(`git ls-files failed:\n${ls.stderr.toString('utf8')}\n`);
  process.exit(2);
}
const records = ls.stdout.toString('utf8').split('\0').filter(Boolean);

// --- 2. Linguist-generated paths from .gitattributes ---
// `git check-attr -z --stdin linguist-generated` reads NUL-separated paths
// from stdin. We record only paths whose value is `set` (boolean attribute
// declared in .gitattributes) — those are the linguist-generated ones.
const paths = records.map((line) => {
  // Path is the last TAB-separated field. The output uses \t before the
  // path; split on the last tab and take the suffix.
  const tab = line.lastIndexOf('\t');
  return tab >= 0 ? line.slice(tab + 1) : '';
});
const check = spawnSync('git', ['check-attr', '-z', '--stdin', 'linguist-generated'], {
  cwd: ROOT,
  encoding: 'buffer',
  input: Buffer.from(paths.join('\0'), 'utf8'),
});
if (check.status !== 0) {
  process.stderr.write(`git check-attr failed:\n${check.stderr.toString('utf8')}\n`);
  process.exit(2);
}
// Records come as: <path>\0<attr>\0<value>\0<path>\0<attr>\0<value>\0...
const fields = check.stdout.toString('utf8').split('\0');
const generated = new Set();
for (let i = 0; i < fields.length; ) {
  const p = fields[i++];
  if (!p) break;
  const attr = fields[i++],
    value = fields[i++];
  if (attr === 'linguist-generated' && value === 'set') generated.add(p);
}

// --- 3. Scan and (optionally) fix -------------------------------------------
let fixed = 0;
const violations = [];

for (const line of records) {
  // Parse "<i-eol> <w-eol> [attr/...] <path>". Path is after the last \t.
  const tab = line.lastIndexOf('\t');
  const path = tab >= 0 ? line.slice(tab + 1) : '';
  if (!path) continue;

  // i/-text means Git considers this file binary. Skip it. i/none means a
  // single-line file with no trailing newline; we also skip those because
  // there are no line endings to normalize.
  const spaceIdx = line.indexOf(' ');
  const iEol = line.slice(0, spaceIdx);
  if (iEol === 'i/-text' || iEol === 'i/none') continue;

  // Linguist-generated assets (prebuilt bundles, report samples): skip so
  // re-emitted bundles don't churn.
  if (generated.has(path)) continue;

  let bytes;
  try {
    bytes = readFileSync(path);
  } catch {
    // Missing or unreadable (e.g. submodule not initialized).
    continue;
  }

  // Scan the first 64 KiB only. Text files are all-LF-or-CRLF in that
  // window; if no CR is found, the file is clean.
  const limit = Math.min(bytes.length, 64 * 1024);
  let firstCr = -1;
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0x0d) {
      firstCr = i;
      break;
    }
  }
  if (firstCr < 0) continue;

  // Convert byte offset to a 1-indexed line number for the report.
  let lineNo = 1;
  for (let i = 0; i < firstCr; i++) {
    if (bytes[i] === 0x0a) lineNo++;
  }

  if (WRITE) {
    // Pure byte-level CR removal. Do NOT route through `toString('utf8')` —
    // a future bug that misclassifies a binary as text would corrupt it.
    const out = Buffer.allocUnsafe(bytes.length);
    let w = 0;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b !== 0x0d) out[w++] = b;
    }
    writeFileSync(path, out.subarray(0, w));
    fixed++;
    process.stdout.write(`fixed  ${path}:${lineNo}\n`);
  } else {
    violations.push(`${path}:${lineNo}`);
  }
}

if (WRITE) {
  process.stdout.write(`Done. Rewrote ${fixed} file(s) with stray CR bytes.\n`);
  // --write mode is intentionally permissive: the next `check:line-endings`
  // run is the source of truth.
  process.exit(0);
}

if (violations.length > 0) {
  process.stdout.write(`${violations.length} file(s) contain stray CR bytes:\n`);
  for (const v of violations) process.stdout.write(`  ${v}\n`);
  process.stdout.write(`Run \`npm run fix:line-endings\` to normalize.\n`);
  process.exit(1);
}

process.exit(0);
