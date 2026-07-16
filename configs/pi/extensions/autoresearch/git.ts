import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

import { DEFAULT_MAX_EVIDENCE_STAGES } from "./state.ts";

export interface CommandRunner {
  (command: string, args: string[], options?: { cwd?: string }): string;
}

const defaultRun: CommandRunner = (command, args, options) =>
  execFileSync(command, args, { cwd: options?.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export interface RepositoryInfo {
  canonicalRoot: string;
  commonDir: string;
  head: string;
  dirty: boolean;
  maxEvidenceStages: number;
}

export interface WorkerLane {
  workerId: string;
  index: number;
  path: string;
  branch: string;
}

export function readMaxEvidenceStages(canonicalRoot: string): number {
  const configPath = join(canonicalRoot, ".autoresearch", "config.json");
  if (!existsSync(configPath)) return DEFAULT_MAX_EVIDENCE_STAGES;
  const parsed = JSON.parse(readFileSync(configPath, "utf8")) as { maxEvidenceStages?: unknown };
  if (parsed.maxEvidenceStages === undefined) return DEFAULT_MAX_EVIDENCE_STAGES;
  if (!Number.isInteger(parsed.maxEvidenceStages) || Number(parsed.maxEvidenceStages) < 1) {
    throw new Error(".autoresearch/config.json maxEvidenceStages must be a positive integer");
  }
  return Number(parsed.maxEvidenceStages);
}

export function inspectRepository(cwd: string, run: CommandRunner = defaultRun): RepositoryInfo {
  const commonDirRaw = run("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const commonDir = realpathSync(resolve(cwd, commonDirRaw));
  const canonicalRoot = dirname(commonDir);
  const topLevel = realpathSync(run("git", ["-C", canonicalRoot, "rev-parse", "--show-toplevel"]));
  if (topLevel !== realpathSync(canonicalRoot)) {
    throw new Error(`Cannot identify canonical checkout from Git common dir: ${commonDir}`);
  }
  const head = run("git", ["-C", canonicalRoot, "rev-parse", "HEAD"]);
  const dirty = run("git", ["-C", canonicalRoot, "status", "--porcelain"]).length > 0;
  return { canonicalRoot, commonDir, head, dirty, maxEvidenceStages: readMaxEvidenceStages(canonicalRoot) };
}

export function workerLanes(canonicalRoot: string, count: number): WorkerLane[] {
  const parent = dirname(canonicalRoot);
  const repoName = basename(canonicalRoot);
  return Array.from({ length: count }, (_, offset) => {
    const index = offset + 1;
    return {
      workerId: `w${index}`,
      index,
      path: join(parent, `${repoName}-worker-${index}`),
      branch: `autoresearch/worker-${index}`,
    };
  });
}

function gitBranchExists(canonicalRoot: string, branch: string, run: CommandRunner): boolean {
  try {
    run("git", ["-C", canonicalRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

export function ensureAutoresearchIgnored(canonicalRoot: string, run: CommandRunner = defaultRun): void {
  const excludePathRaw = run("git", ["-C", canonicalRoot, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]);
  const excludePath = isAbsolute(excludePathRaw) ? excludePathRaw : resolve(canonicalRoot, excludePathRaw);
  mkdirSync(dirname(excludePath), { recursive: true });
  const current = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  if (!current.split(/\r?\n/).includes("/.autoresearch/")) {
    appendFileSync(excludePath, `${current.endsWith("\n") || current.length === 0 ? "" : "\n"}/.autoresearch/\n`);
  }
}

export function ensureWorkerLane(
  canonicalRoot: string,
  commonDir: string,
  lane: WorkerLane,
  run: CommandRunner = defaultRun,
): WorkerLane {
  if (!existsSync(lane.path)) {
    if (gitBranchExists(canonicalRoot, lane.branch, run)) {
      run("git", ["-C", canonicalRoot, "worktree", "add", lane.path, lane.branch]);
    } else {
      run("git", ["-C", canonicalRoot, "worktree", "add", "-b", lane.branch, lane.path, "HEAD"]);
    }
  }

  const laneRoot = realpathSync(run("git", ["-C", lane.path, "rev-parse", "--show-toplevel"]));
  if (laneRoot !== realpathSync(lane.path)) throw new Error(`${lane.path} is not a worktree root`);
  const laneCommonRaw = run("git", ["-C", lane.path, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (realpathSync(resolve(lane.path, laneCommonRaw)) !== realpathSync(commonDir)) {
    throw new Error(`${lane.path} belongs to a different Git repository`);
  }
  const branch = run("git", ["-C", lane.path, "symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch !== lane.branch) {
    throw new Error(`${lane.path} is on ${branch || "detached HEAD"}, expected ${lane.branch}`);
  }
  return lane;
}

export function laneGitState(path: string, run: CommandRunner = defaultRun): { head: string; dirty: boolean } {
  return {
    head: run("git", ["-C", path, "rev-parse", "HEAD"]),
    dirty: run("git", ["-C", path, "status", "--porcelain"]).length > 0,
  };
}

export function syncLaneToCanonical(input: {
  canonicalRoot: string;
  lane: WorkerLane;
  generation: number;
  canonicalHead?: string;
  now?: number;
  run?: CommandRunner;
}): { candidateRef: string; canonicalHead: string } {
  const run = input.run ?? defaultRun;
  const state = laneGitState(input.lane.path, run);
  if (state.dirty) throw new Error(`${input.lane.workerId} worktree is dirty`);
  const canonicalHead = input.canonicalHead ?? run("git", ["-C", input.canonicalRoot, "rev-parse", "HEAD"]);
  const timestamp = input.now ?? Date.now();
  const candidateRef = `refs/autoresearch/candidates/${input.lane.workerId}/g${input.generation}-${timestamp}`;
  run("git", ["-C", input.lane.path, "update-ref", candidateRef, state.head]);
  run("git", ["-C", input.lane.path, "reset", "--hard", canonicalHead]);
  return { candidateRef, canonicalHead };
}

export { defaultRun as runGitCommand };
