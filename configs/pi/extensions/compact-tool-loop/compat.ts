import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  compact as exportedCompact,
  getPackageDir,
  type SessionEntry,
  VERSION,
} from "@earendil-works/pi-coding-agent";

/**
 * Pi does not expose context-safe compaction preparation as a public extension
 * API. Shadow compaction therefore has one deliberately isolated compatibility
 * boundary. Verify this path and behavior before changing the pinned version.
 */
export const PI_COMPACTION_COMPATIBILITY = {
  piVersion: "0.80.10",
  internalModule: "./core/compaction/compaction.js",
} as const;

export type CoreCompact = typeof exportedCompact;
export type CompactionPreparation = Parameters<CoreCompact>[0];
export type CompactionResult = Awaited<ReturnType<CoreCompact>>;

export interface InternalCompactionModule {
  prepareCompaction(
    entries: SessionEntry[],
    settings: { enabled: boolean; reserveTokens: number; keepRecentTokens: number },
  ): CompactionPreparation | undefined;
  compact: CoreCompact;
}

export type CompactionCompatibility =
  | { ok: true; module: InternalCompactionModule }
  | { ok: false; reason: string };

let compatibilityPromise: Promise<CompactionCompatibility> | undefined;

export function loadInternalCompactionModule(): Promise<CompactionCompatibility> {
  compatibilityPromise ??= (async () => {
    const expected = PI_COMPACTION_COMPATIBILITY.piVersion;
    try {
      if (VERSION !== expected) {
        return { ok: false, reason: `loaded Pi ${VERSION}, expected ${expected}` };
      }
      const packageDir = getPackageDir();
      const manifest = JSON.parse(await readFile(resolve(packageDir, "package.json"), "utf8")) as {
        main?: unknown;
        version?: unknown;
      };
      if (manifest.version !== expected || typeof manifest.main !== "string") {
        return { ok: false, reason: "the installed Pi package manifest does not match the pinned layout" };
      }

      const rootUrl = pathToFileURL(resolve(packageDir, manifest.main)).href;
      const root = (await import(rootUrl)) as { VERSION?: unknown };
      if (root.VERSION !== expected) {
        return { ok: false, reason: "the loaded Pi module does not match the pinned version" };
      }

      const moduleUrl = new URL(PI_COMPACTION_COMPATIBILITY.internalModule, rootUrl);
      const internal = (await import(moduleUrl.href)) as Partial<InternalCompactionModule>;
      if (typeof internal.prepareCompaction !== "function" || typeof internal.compact !== "function") {
        return { ok: false, reason: "the pinned private compaction exports are unavailable" };
      }
      return { ok: true, module: internal as InternalCompactionModule };
    } catch (error) {
      return {
        ok: false,
        reason: `the pinned private compaction module could not load (${error instanceof Error ? error.message : String(error)})`,
      };
    }
  })();
  return compatibilityPromise;
}
