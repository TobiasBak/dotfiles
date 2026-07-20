import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

export interface CommandRunner {
  (command: string, args: string[], options?: { cwd?: string }): string;
}

const defaultRun: CommandRunner = (command, args, options) =>
  execFileSync(command, args, { cwd: options?.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export interface RepositoryInfo {
  canonicalRoot: string;
  commonDir: string;
  branch: string;
  head: string;
  dirty: boolean;
}

export interface WorkerLane {
  workerId: string;
  index: number;
  path: string;
  branch: string;
}

export function inspectRepository(cwd: string, run: CommandRunner = defaultRun): RepositoryInfo {
  const commonDirRaw = run("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const commonDir = realpathSync(resolve(cwd, commonDirRaw));
  const canonicalRoot = dirname(commonDir);
  const topLevel = realpathSync(run("git", ["-C", canonicalRoot, "rev-parse", "--show-toplevel"]));
  if (topLevel !== realpathSync(canonicalRoot)) {
    throw new Error(`Cannot identify canonical checkout from Git common dir: ${commonDir}`);
  }
  const branch = run("git", ["-C", canonicalRoot, "symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!branch) throw new Error("Canonical checkout must be on a named branch");
  const head = run("git", ["-C", canonicalRoot, "rev-parse", "HEAD"]);
  const dirty = run("git", ["-C", canonicalRoot, "status", "--porcelain"]).length > 0;
  return { canonicalRoot, commonDir, branch, head, dirty };
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

export function isGitAncestor(canonicalRoot: string, ancestor: string, descendant: string, run: CommandRunner = defaultRun): boolean {
  try {
    run("git", ["-C", canonicalRoot, "merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

function canonicalOperationState(canonicalRoot: string, run: CommandRunner): string | undefined {
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
    const path = run("git", ["-C", canonicalRoot, "rev-parse", "--git-path", name]);
    if (existsSync(resolve(canonicalRoot, path))) return name.toLowerCase();
  }
  for (const name of ["rebase-merge", "rebase-apply"]) {
    const path = run("git", ["-C", canonicalRoot, "rev-parse", "--git-path", name]);
    if (existsSync(resolve(canonicalRoot, path))) return name;
  }
  return undefined;
}

export class TerminalIntegrationCleanupError extends Error {}

export function preserveTerminalRef(input: {
  canonicalRoot: string;
  lane: WorkerLane;
  generation: number;
  intentId: number;
  baselineHead: string;
  terminalHead: string;
  integratedHead?: string;
  run?: CommandRunner;
}): string {
  const run = input.run ?? defaultRun;
  const lane = laneGitState(input.lane.path, run);
  const allowedHeads = [input.terminalHead, input.integratedHead].filter((head): head is string => Boolean(head));
  if (lane.dirty || !allowedHeads.includes(lane.head)) {
    throw new Error(`${input.lane.workerId} lane must be clean at its exact terminal or integrated head`);
  }
  const branch = run("git", ["-C", input.lane.path, "symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch !== input.lane.branch) throw new Error(`${input.lane.workerId} lane is not on ${input.lane.branch}`);
  if (!isGitAncestor(input.canonicalRoot, input.baselineHead, input.terminalHead, run)) {
    throw new Error(`Campaign baseline ${input.baselineHead} is not an ancestor of terminal ${input.terminalHead}`);
  }

  const ref = `refs/autoresearch/terminals/g${input.generation}/i${input.intentId}`;
  try {
    run("git", ["-C", input.canonicalRoot, "update-ref", ref, input.terminalHead, ""]);
  } catch {
    let existing: string;
    try {
      existing = run("git", ["-C", input.canonicalRoot, "rev-parse", "--verify", ref]);
    } catch {
      throw new Error(`Could not create terminal ref ${ref}`);
    }
    if (existing !== input.terminalHead) throw new Error(`Terminal ref ${ref} was modified to ${existing}`);
  }
  return ref;
}

export function integrateTerminalRef(input: {
  canonicalRoot: string;
  canonicalBranch: string;
  expectedHead: string;
  terminalRef: string;
  recoverMerged?: boolean;
  run?: CommandRunner;
}): { resultHead: string; alreadyIntegrated: boolean } {
  const run = input.run ?? defaultRun;
  const branch = run("git", ["-C", input.canonicalRoot, "symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch !== input.canonicalBranch) throw new Error(`Canonical checkout is on ${branch || "detached HEAD"}, expected ${input.canonicalBranch}`);
  const state = canonicalOperationState(input.canonicalRoot, run);
  if (state) throw new Error(`Canonical checkout has active ${state} state`);
  if (run("git", ["-C", input.canonicalRoot, "status", "--porcelain"])) throw new Error("Canonical checkout is dirty");
  const head = run("git", ["-C", input.canonicalRoot, "rev-parse", "HEAD"]);
  if (head !== input.expectedHead) {
    if (input.recoverMerged && isGitAncestor(input.canonicalRoot, input.terminalRef, head, run)) {
      const firstParent = run("git", ["-C", input.canonicalRoot, "rev-parse", `${head}^1`]);
      if (firstParent === input.expectedHead) return { resultHead: head, alreadyIntegrated: true };
    }
    throw new Error(`Canonical HEAD changed from expected ${input.expectedHead} to ${head}`);
  }
  if (isGitAncestor(input.canonicalRoot, input.terminalRef, head, run)) {
    return { resultHead: head, alreadyIntegrated: true };
  }

  try {
    run("git", [
      "-C", input.canonicalRoot,
      "-c", "core.hooksPath=/dev/null",
      "-c", "commit.gpgSign=false",
      "-c", "merge.gpgSign=false",
      "merge", "--no-ff", "--no-edit", input.terminalRef,
    ]);
  } catch (mergeError) {
    let cleanupError: unknown;
    try {
      if (canonicalOperationState(input.canonicalRoot, run)) {
        run("git", ["-C", input.canonicalRoot, "-c", "core.hooksPath=/dev/null", "merge", "--abort"]);
      }
      const restoredBranch = run("git", ["-C", input.canonicalRoot, "symbolic-ref", "--quiet", "--short", "HEAD"]);
      const restoredHead = run("git", ["-C", input.canonicalRoot, "rev-parse", "HEAD"]);
      const dirty = run("git", ["-C", input.canonicalRoot, "status", "--porcelain"]);
      const operation = canonicalOperationState(input.canonicalRoot, run);
      if (restoredBranch !== input.canonicalBranch || restoredHead !== input.expectedHead || dirty || operation) {
        cleanupError = new Error(`canonical cleanup verification failed: branch=${restoredBranch}, head=${restoredHead}, dirty=${Boolean(dirty)}, operation=${operation ?? "none"}`);
      }
    } catch (error) {
      cleanupError = error;
    }
    if (cleanupError) {
      throw new TerminalIntegrationCleanupError(`Merge failed and canonical checkout could not be restored: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    }
    throw new Error(`Terminal integration merge failed: ${mergeError instanceof Error ? mergeError.message : String(mergeError)}`);
  }

  const resultHead = run("git", ["-C", input.canonicalRoot, "rev-parse", "HEAD"]);
  const postconditionError = run("git", ["-C", input.canonicalRoot, "status", "--porcelain"]) || canonicalOperationState(input.canonicalRoot, run)
    ? "Canonical checkout was not clean after terminal integration"
    : !isGitAncestor(input.canonicalRoot, input.terminalRef, resultHead, run)
      ? "Terminal ref is not reachable from canonical integration result"
      : undefined;
  if (postconditionError) {
    try {
      run("git", ["-C", input.canonicalRoot, "-c", "core.hooksPath=/dev/null", "reset", "--hard", input.expectedHead]);
      const restoredHead = run("git", ["-C", input.canonicalRoot, "rev-parse", "HEAD"]);
      const dirty = run("git", ["-C", input.canonicalRoot, "status", "--porcelain"]);
      if (restoredHead !== input.expectedHead || dirty || canonicalOperationState(input.canonicalRoot, run)) {
        throw new Error("canonical checkout did not return to its expected clean HEAD");
      }
    } catch (error) {
      throw new TerminalIntegrationCleanupError(`${postconditionError}; cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    throw new Error(postconditionError);
  }
  return { resultHead, alreadyIntegrated: false };
}

export function resetIntegratedLane(input: {
  lane: WorkerLane;
  terminalHead: string;
  resultHead: string;
  run?: CommandRunner;
}): void {
  const run = input.run ?? defaultRun;
  const branch = run("git", ["-C", input.lane.path, "symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch !== input.lane.branch) throw new Error(`${input.lane.workerId} lane is not on ${input.lane.branch}`);
  const state = laneGitState(input.lane.path, run);
  if (state.dirty) throw new Error(`${input.lane.workerId} lane is dirty after integration`);
  if (state.head !== input.terminalHead && state.head !== input.resultHead) {
    throw new Error(`${input.lane.workerId} lane changed from terminal head before reset`);
  }
  if (state.head !== input.resultHead) run("git", ["-C", input.lane.path, "reset", "--hard", input.resultHead]);
}

export { defaultRun as runGitCommand };
