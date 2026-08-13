// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {gunzipSync} from 'zlib';

import {
  compareContentVersions,
  isAndroidInternalsPackContentVersion,
  parseAndroidInternalsPackTargetPath,
  readAndroidInternalsPackManifest,
  sha256File,
} from './manifest';
import {
  androidInternalsPackActivePointerPath,
  androidInternalsPackAssetRoot,
  androidInternalsPackBundledRoot,
  androidInternalsPackChannelStatePath,
  androidInternalsPackLastKnownGoodPointerPath,
  androidInternalsPackRuntimeRoot,
  androidInternalsPackVersionDirectory,
} from './packPaths';
import {AndroidInternalsPackStore} from './androidInternalsPackStore';
import type {
  AndroidInternalsPackChannelState,
  AndroidInternalsPackHandle,
  AndroidInternalsPackIdentity,
  AndroidInternalsPackManifest,
  AndroidInternalsPackPointer,
  AndroidInternalsPackStoreLike,
} from './types';

interface KnowledgePacksLock {
  schemaVersion: 1;
  repository: {
    metadataBaseUrl: string;
    targetBaseUrl: string;
  };
  bundled: {
    contentVersion: string;
    contentFingerprint: string;
    manifestSha256: string;
    publicRevision: string;
    targets: {
      manifest: string;
      database: string;
      audit: string;
      licenses: Record<string, string>;
    };
  };
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
}

function safeReadJson<T>(filePath: string): T | undefined {
  try {
    return readJson(filePath) as T;
  } catch {
    return undefined;
  }
}

function parseLock(value: unknown): KnowledgePacksLock {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_aiw_pack_lock');
  }
  const lock = value as KnowledgePacksLock;
  if (
    lock.schemaVersion !== 1 ||
    !lock.repository ||
    typeof lock.repository.metadataBaseUrl !== 'string' ||
    typeof lock.repository.targetBaseUrl !== 'string' ||
    !lock.bundled ||
    !isAndroidInternalsPackContentVersion(lock.bundled.contentVersion) ||
    !/^[0-9a-f]{64}$/.test(lock.bundled.contentFingerprint) ||
    !/^[0-9a-f]{64}$/.test(lock.bundled.manifestSha256) ||
    !/^[0-9a-f]{40}$/.test(lock.bundled.publicRevision) ||
    !lock.bundled.targets ||
    typeof lock.bundled.targets.manifest !== 'string' ||
    typeof lock.bundled.targets.database !== 'string' ||
    typeof lock.bundled.targets.audit !== 'string' ||
    !lock.bundled.targets.licenses
  ) {
    throw new Error('invalid_aiw_pack_lock');
  }
  const licenses = Object.fromEntries(
    Object.entries(lock.bundled.targets.licenses).map(([name, target]) => {
      if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error('invalid_aiw_pack_lock');
      return [
        name,
        parseAndroidInternalsPackTargetPath(target, `lock_license_${name}`),
      ];
    }),
  );
  return {
    ...lock,
    bundled: {
      ...lock.bundled,
      targets: {
        manifest: parseAndroidInternalsPackTargetPath(
          lock.bundled.targets.manifest,
          'lock_manifest_target',
        ),
        database: parseAndroidInternalsPackTargetPath(
          lock.bundled.targets.database,
          'lock_database_target',
        ),
        audit: parseAndroidInternalsPackTargetPath(
          lock.bundled.targets.audit,
          'lock_audit_target',
        ),
        licenses,
      },
    },
  };
}

export function readAndroidInternalsPackLock(): KnowledgePacksLock {
  return parseLock(readJson(path.join(androidInternalsPackAssetRoot(), 'knowledge-packs.lock.json')));
}

function packageVersion(): string {
  const packagePath = path.resolve(__dirname, '../../../package.json');
  const parsed = safeReadJson<{version?: unknown}>(packagePath);
  return typeof parsed?.version === 'string' ? parsed.version : '0.0.0';
}

function majorMinorPatch(value: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function compareSemver(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function assertCompatible(manifest: AndroidInternalsPackManifest): void {
  const current = majorMinorPatch(packageVersion());
  const minimum = majorMinorPatch(manifest.compatibility.smartPerfettoMinVersion);
  if (!current || !minimum || compareSemver(current, minimum) < 0) {
    throw new Error('aiw_pack_smartperfetto_version_too_old');
  }
  const maxMatch = /^(\d+)\.x$/.exec(manifest.compatibility.smartPerfettoMaxVersion);
  if (maxMatch && current[0] > Number(maxMatch[1])) {
    throw new Error('aiw_pack_smartperfetto_version_too_new');
  }
}

function assertManifestIdentity(
  manifest: AndroidInternalsPackManifest,
  expected?: Partial<AndroidInternalsPackIdentity>,
): void {
  assertCompatible(manifest);
  if (
    (expected?.contentVersion && expected.contentVersion !== manifest.contentVersion) ||
    (expected?.contentFingerprint &&
      expected.contentFingerprint !== manifest.contentFingerprint) ||
    (expected?.sourceRevision && expected.sourceRevision !== manifest.sourceRevision)
  ) {
    throw new Error('aiw_pack_identity_mismatch');
  }
  if (manifest.revocation.revoked) throw new Error('aiw_pack_manifest_revoked');
}

export function verifyAndroidInternalsPackDirectory(
  directory: string,
  origin: AndroidInternalsPackHandle['origin'],
  expected?: Partial<AndroidInternalsPackIdentity>,
): AndroidInternalsPackHandle {
  const manifestPath = path.join(directory, 'manifest.json');
  const databasePath = path.join(directory, 'content.sqlite');
  const auditPath = path.join(directory, 'audit-summary.json');
  const manifest = readAndroidInternalsPackManifest(manifestPath);
  assertManifestIdentity(manifest, expected);
  if (
    fs.statSync(databasePath).size !== manifest.database.uncompressedBytes ||
    sha256File(databasePath) !== manifest.database.uncompressedSha256 ||
    sha256File(auditPath) !== manifest.audit.sha256
  ) {
    throw new Error('aiw_pack_installed_hash_mismatch');
  }
  for (const [name, expectedHash] of Object.entries(manifest.licenses.files)) {
    if (sha256File(path.join(directory, 'licenses', name)) !== expectedHash) {
      throw new Error(`aiw_pack_license_hash_mismatch_${name}`);
    }
  }
  const handle: AndroidInternalsPackHandle = {
    origin,
    directory,
    databasePath,
    manifest,
    contentVersion: manifest.contentVersion,
    contentFingerprint: manifest.contentFingerprint,
    sourceRevision: manifest.sourceRevision,
  };
  const validationStore = new AndroidInternalsPackStore(handle);
  validationStore.close();
  return handle;
}

function copyRequiredFile(source: string, target: string): void {
  fs.mkdirSync(path.dirname(target), {recursive: true});
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
}

function materializeBundledDirectory(): AndroidInternalsPackHandle {
  const lock = readAndroidInternalsPackLock();
  const source = path.join(androidInternalsPackBundledRoot(), lock.bundled.contentVersion);
  const manifestSource = path.join(source, 'manifest.json');
  if (sha256File(manifestSource) !== lock.bundled.manifestSha256) {
    throw new Error('aiw_pack_bundled_manifest_lock_mismatch');
  }
  const manifest = readAndroidInternalsPackManifest(manifestSource);
  assertManifestIdentity(manifest, lock.bundled);
  const stableName = `${manifest.contentVersion}-${manifest.contentFingerprint.slice(0, 16)}`;
  const preferred = path.join(androidInternalsPackRuntimeRoot(), 'bundled-cache', stableName);
  const fallback = path.join(os.tmpdir(), 'smartperfetto-aiw-pack', stableName);
  for (const destination of [preferred, fallback]) {
    try {
      if (fs.existsSync(path.join(destination, 'content.sqlite'))) {
        return verifyAndroidInternalsPackDirectory(destination, 'bundled', lock.bundled);
      }
      const parent = path.dirname(destination);
      fs.mkdirSync(parent, {recursive: true});
      const staging = fs.mkdtempSync(path.join(parent, `.${stableName}.staging-`));
      try {
        const compressedPath = path.join(source, manifest.database.file);
        const compressed = fs.readFileSync(compressedPath);
        if (
          compressed.length !== manifest.database.compressedBytes ||
          createHash('sha256').update(compressed).digest('hex') !== manifest.database.sha256
        ) {
          throw new Error('aiw_pack_bundled_database_hash_mismatch');
        }
        const database = gunzipSync(compressed, {
          maxOutputLength: manifest.database.uncompressedBytes,
        });
        if (
          database.length !== manifest.database.uncompressedBytes ||
          createHash('sha256').update(database).digest('hex') !==
            manifest.database.uncompressedSha256
        ) {
          throw new Error('aiw_pack_bundled_uncompressed_hash_mismatch');
        }
        fs.writeFileSync(path.join(staging, 'content.sqlite'), database, {flag: 'wx'});
        copyRequiredFile(manifestSource, path.join(staging, 'manifest.json'));
        copyRequiredFile(
          path.join(source, manifest.audit.file),
          path.join(staging, manifest.audit.file),
        );
        for (const name of Object.keys(manifest.licenses.files)) {
          copyRequiredFile(
            path.join(source, 'licenses', name),
            path.join(staging, 'licenses', name),
          );
        }
        const handle = verifyAndroidInternalsPackDirectory(staging, 'bundled', lock.bundled);
        try {
          fs.renameSync(staging, destination);
        } catch (error) {
          if (!fs.existsSync(destination)) throw error;
        }
        return verifyAndroidInternalsPackDirectory(destination, 'bundled', handle);
      } finally {
        fs.rmSync(staging, {recursive: true, force: true});
      }
    } catch (error) {
      if (destination === fallback) throw error;
    }
  }
  throw new Error('aiw_pack_bundled_materialization_failed');
}

function validPointer(value: unknown): AndroidInternalsPackPointer | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as AndroidInternalsPackPointer;
  return (
    candidate.origin === 'runtime' &&
    typeof candidate.installedAt === 'string' &&
    isAndroidInternalsPackContentVersion(candidate.contentVersion) &&
    /^[0-9a-f]{64}$/.test(candidate.contentFingerprint) &&
    /^[0-9a-f]{40}$/.test(candidate.sourceRevision)
  ) ? candidate : undefined;
}

export function readAndroidInternalsPackChannelState(): AndroidInternalsPackChannelState | undefined {
  const state = safeReadJson<AndroidInternalsPackChannelState>(
    androidInternalsPackChannelStatePath(),
  );
  if (
    !state ||
    typeof state.checkedAt !== 'string' ||
    (
      state.contentVersion !== undefined &&
      !isAndroidInternalsPackContentVersion(state.contentVersion)
    ) ||
    (
      state.minimumSafeVersion !== undefined &&
      !isAndroidInternalsPackContentVersion(state.minimumSafeVersion)
    ) ||
    !Array.isArray(state.revokedVersions) ||
    !state.revokedVersions.every(isAndroidInternalsPackContentVersion)
  ) {
    return undefined;
  }
  return state;
}

export function isAndroidInternalsPackRevoked(identity: AndroidInternalsPackIdentity): boolean {
  const channel = readAndroidInternalsPackChannelState();
  return Boolean(
    channel?.revokedVersions.includes(identity.contentVersion) ||
    (
      channel?.minimumSafeVersion &&
      compareContentVersions(identity.contentVersion, channel.minimumSafeVersion) < 0
    ),
  );
}

function resolvePointer(
  pointerPath: string,
  origin: AndroidInternalsPackHandle['origin'],
): AndroidInternalsPackHandle | undefined {
  const pointer = validPointer(safeReadJson(pointerPath));
  if (!pointer || isAndroidInternalsPackRevoked(pointer)) return undefined;
  try {
    return verifyAndroidInternalsPackDirectory(
      androidInternalsPackVersionDirectory(pointer.contentVersion),
      origin,
      pointer,
    );
  } catch {
    return undefined;
  }
}

export class AndroidInternalsPackResolver {
  /**
   * Memoization cache for resolve(). The pin-aware cache prevents re-running
   * manifest verification + pointer reads + bundled directory materialization
   * on every analyze request. TTL is intentionally short so revocations or
   * pin updates pick up within a few minutes.
   *
   * Key shape: serialized pin (or 'null' for the no-pin lookup). Different
   * pins cache independently because they resolve to different handles.
   */
  private static readonly CACHE_TTL_MS = 5 * 60 * 1000;
  private cache:
    | { key: string; result: AndroidInternalsPackHandle | undefined; expiresAt: number }
    | null = null;

  resolve(pin?: Partial<AndroidInternalsPackIdentity>): AndroidInternalsPackHandle | undefined {
    // Bypass cache when the feature is explicitly disabled so an operator's
    // env-var flip takes effect immediately.
    if (process.env.SMARTPERFETTO_AIW_PACK_ENABLED !== '0') {
      const cacheKey = pin ? JSON.stringify(pin) : 'null';
      const now = Date.now();
      if (this.cache && this.cache.key === cacheKey && this.cache.expiresAt > now) {
        return this.cache.result;
      }
    }

    const result = this.resolveUncached(pin);

    if (process.env.SMARTPERFETTO_AIW_PACK_ENABLED !== '0') {
      const cacheKey = pin ? JSON.stringify(pin) : 'null';
      this.cache = {
        key: cacheKey,
        result,
        expiresAt: Date.now() + AndroidInternalsPackResolver.CACHE_TTL_MS,
      };
    }
    return result;
  }

  private resolveUncached(pin?: Partial<AndroidInternalsPackIdentity>): AndroidInternalsPackHandle | undefined {
    if (process.env.SMARTPERFETTO_AIW_PACK_ENABLED === '0') return undefined;
    const configuredVersion = pin?.contentVersion || process.env.SMARTPERFETTO_AIW_PACK_PIN;
    if (configuredVersion) {
      let configured: AndroidInternalsPackHandle;
      try {
        configured = verifyAndroidInternalsPackDirectory(
          androidInternalsPackVersionDirectory(configuredVersion),
          'pinned',
          pin,
        );
      } catch (runtimeError) {
        const bundled = materializeBundledDirectory();
        if (bundled.contentVersion !== configuredVersion) throw runtimeError;
        assertManifestIdentity(bundled.manifest, pin);
        configured = {...bundled, origin: 'pinned'};
      }
      return isAndroidInternalsPackRevoked(configured) ? undefined : configured;
    }
    const active = resolvePointer(androidInternalsPackActivePointerPath(), 'runtime');
    if (active) return active;
    const lastKnownGood = resolvePointer(
      androidInternalsPackLastKnownGoodPointerPath(),
      'runtime',
    );
    if (lastKnownGood) return lastKnownGood;
    try {
      const bundled = materializeBundledDirectory();
      if (!isAndroidInternalsPackRevoked(bundled)) return bundled;
    } catch {
      // Invalid bundled data disables the Pack when no verified runtime copy exists.
    }
    return undefined;
  }
}

const defaultResolver = new AndroidInternalsPackResolver();
const defaultStores = new Map<string, AndroidInternalsPackStore>();

export function getDefaultAndroidInternalsPackResolver(): AndroidInternalsPackResolver {
  return defaultResolver;
}

export function getDefaultAndroidInternalsPackStore(
  pin?: Partial<AndroidInternalsPackIdentity>,
): AndroidInternalsPackStoreLike | undefined {
  const handle = defaultResolver.resolve(pin);
  if (!handle) return undefined;
  const key = `${handle.contentVersion}:${handle.contentFingerprint}`;
  const current = defaultStores.get(key);
  if (current) return current;
  const store = new AndroidInternalsPackStore(handle);
  defaultStores.set(key, store);
  return store;
}

export function __resetAndroidInternalsPackStoresForTests(): void {
  for (const store of defaultStores.values()) store.close();
  defaultStores.clear();
}
