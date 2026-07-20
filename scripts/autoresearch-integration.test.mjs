import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  integrateTerminalRef,
  preserveTerminalRef,
  resetIntegratedLane,
} from "../configs/pi/extensions/autoresearch/git.ts";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commitFile(cwd, file, content, message) {
  writeFileSync(join(cwd, file), content);
  git(cwd, "add", file);
  git(cwd, "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

function repository(laneCount = 1) {
  const dir = mkdtempSync(join(tmpdir(), "autoresearch-integration-"));
  const root = join(dir, "repo");
  git(dir, "init", "-b", "main", root);
  git(root, "config", "user.name", "Autoresearch Test");
  git(root, "config", "user.email", "autoresearch@example.invalid");
  const base = commitFile(root, "shared.txt", "base\n", "base");
  const lanes = [];
  for (let index = 1; index <= laneCount; index += 1) {
    const path = join(dir, `lane-${index}`);
    const branch = `autoresearch/worker-${index}`;
    git(root, "worktree", "add", "-b", branch, path, base);
    lanes.push({ workerId: `w${index}`, index, path, branch });
  }
  return { dir, root, base, lanes };
}

function terminal(repo, laneIndex, file, content) {
  return commitFile(repo.lanes[laneIndex].path, file, content, `terminal ${laneIndex + 1}`);
}

test("serial terminal merges preserve commit ids and never alter other stale-base lanes", () => {
  const repo = repository(3);
  try {
    const first = terminal(repo, 0, "first.txt", "first\n");
    const second = terminal(repo, 1, "second.txt", "second\n");
    const active = terminal(repo, 2, "active.txt", "still active\n");
    const ref1 = preserveTerminalRef({
      canonicalRoot: repo.root, lane: repo.lanes[0], generation: 7, intentId: 11,
      baselineHead: repo.base, terminalHead: first,
    });
    const ref2 = preserveTerminalRef({
      canonicalRoot: repo.root, lane: repo.lanes[1], generation: 7, intentId: 12,
      baselineHead: repo.base, terminalHead: second,
    });

    assert.equal(preserveTerminalRef({
      canonicalRoot: repo.root, lane: repo.lanes[0], generation: 7, intentId: 11,
      baselineHead: repo.base, terminalHead: first,
    }), ref1, "an existing identical terminal ref is idempotent");
    const merged1 = integrateTerminalRef({
      canonicalRoot: repo.root, canonicalBranch: "main", expectedHead: repo.base, terminalRef: ref1,
    });
    assert.notEqual(merged1.resultHead, first, "--no-ff produces a canonical merge commit");
    assert.deepEqual(integrateTerminalRef({
      canonicalRoot: repo.root, canonicalBranch: "main", expectedHead: repo.base, terminalRef: ref1, recoverMerged: true,
    }), { resultHead: merged1.resultHead, alreadyIntegrated: true }, "a merge completed before its DB update is recoverable");
    assert.equal(git(repo.root, "rev-parse", `${merged1.resultHead}^2`), first);
    assert.equal(git(repo.lanes[1].path, "rev-parse", "HEAD"), second, "waiting stale-base lane is untouched");
    assert.equal(git(repo.lanes[2].path, "rev-parse", "HEAD"), active, "active lane is untouched");

    resetIntegratedLane({ lane: repo.lanes[0], terminalHead: first, resultHead: merged1.resultHead });
    const merged2 = integrateTerminalRef({
      canonicalRoot: repo.root, canonicalBranch: "main", expectedHead: merged1.resultHead, terminalRef: ref2,
    });
    resetIntegratedLane({ lane: repo.lanes[1], terminalHead: second, resultHead: merged2.resultHead });

    assert.equal(git(repo.root, "merge-base", "--is-ancestor", first, merged2.resultHead), "");
    assert.equal(git(repo.root, "merge-base", "--is-ancestor", second, merged2.resultHead), "");
    assert.equal(git(repo.root, "rev-parse", `${merged2.resultHead}^1`), merged1.resultHead);
    assert.equal(git(repo.lanes[0].path, "rev-parse", "HEAD"), merged1.resultHead);
    assert.equal(git(repo.lanes[1].path, "rev-parse", "HEAD"), merged2.resultHead);
    assert.equal(git(repo.lanes[2].path, "rev-parse", "HEAD"), active);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("merge conflict aborts cleanly, preserves terminal ref and lane, and produces no result", () => {
  const repo = repository(1);
  try {
    const terminalHead = terminal(repo, 0, "shared.txt", "worker\n");
    const canonicalHead = commitFile(repo.root, "shared.txt", "canonical\n", "canonical conflict");
    const ref = preserveTerminalRef({
      canonicalRoot: repo.root, lane: repo.lanes[0], generation: 2, intentId: 5,
      baselineHead: repo.base, terminalHead,
    });
    assert.throws(() => integrateTerminalRef({
      canonicalRoot: repo.root, canonicalBranch: "main", expectedHead: canonicalHead, terminalRef: ref,
    }), /merge failed/i);
    assert.equal(git(repo.root, "rev-parse", "HEAD"), canonicalHead);
    assert.equal(git(repo.root, "status", "--porcelain"), "");
    assert.equal(git(repo.root, "rev-parse", ref), terminalHead);
    assert.equal(git(repo.lanes[0].path, "rev-parse", "HEAD"), terminalHead);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("canonical dirty and head-changed states fail closed before merge", () => {
  const repo = repository(1);
  try {
    const terminalHead = terminal(repo, 0, "terminal.txt", "terminal\n");
    const ref = preserveTerminalRef({
      canonicalRoot: repo.root, lane: repo.lanes[0], generation: 3, intentId: 8,
      baselineHead: repo.base, terminalHead,
    });
    writeFileSync(join(repo.root, "dirty.txt"), "dirty\n");
    assert.throws(() => integrateTerminalRef({
      canonicalRoot: repo.root, canonicalBranch: "main", expectedHead: repo.base, terminalRef: ref,
    }), /dirty/i);
    rmSync(join(repo.root, "dirty.txt"));
    const changed = commitFile(repo.root, "canonical.txt", "changed\n", "canonical changed");
    assert.throws(() => integrateTerminalRef({
      canonicalRoot: repo.root, canonicalBranch: "main", expectedHead: repo.base, terminalRef: ref,
    }), /HEAD changed/i);
    assert.equal(git(repo.root, "rev-parse", "HEAD"), changed);
    assert.equal(git(repo.lanes[0].path, "rev-parse", "HEAD"), terminalHead);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("terminal refs are create-only and reject an existing ref pointing elsewhere", () => {
  const repo = repository(1);
  try {
    const terminalHead = terminal(repo, 0, "terminal.txt", "terminal\n");
    const ref = "refs/autoresearch/terminals/g4/i9";
    git(repo.root, "update-ref", ref, repo.base);
    assert.throws(() => preserveTerminalRef({
      canonicalRoot: repo.root, lane: repo.lanes[0], generation: 4, intentId: 9,
      baselineHead: repo.base, terminalHead,
    }), /modified/i);
    assert.equal(git(repo.root, "rev-parse", ref), repo.base);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});
