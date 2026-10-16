# pr-merge

Requires Python 3.11+, Git, and an authenticated `gh` with repository access.

```sh
pr-merge post gate --sha FULL_SHA --state success --target https://example.com/gate
pr-merge post review --sha FULL_SHA --state failure --target https://example.com/review --repo owner/name
pr-merge https://github.com/owner/name/pull/123
```

`post` writes a REST commit status with context exactly `gate` or `review`.
The SHA must be a full 40-character hash. `gate` requires local HEAD to match
and a clean Git tree, including untracked files. Git-ignored files do not count.
`review` has no local-tree requirement. Without `--repo`, `gh repo view` supplies
the repository. Posting is silent on success. The caller owns the evidence:
this command neither runs a gate nor performs a review.

## Merge contract

The PR must be open and unmerged, and all these checks must pass:

- The latest REST commit statuses for `gate` and `review` are `success` on
  the exact PR head. GitHub Actions checks are not commit statuses.
- The current base branch tip is an ancestor of that head.
- `.github/merge-gate.toml` at that exact base tip declares top-level
  `protected` and `tests` arrays of strings. Missing or malformed config refuses.
- A formal review on the exact head names every flagged protected/test path,
  as described below. Content-detected renames check both old and new paths,
  so moving a test outside the test globs cannot hide edits.
- The body contains a line in this form, with nonnegative integer counts:

  ```text
  subagents: tasks=1 accepted=1 reworked=0 rejected=0 throttled=0
  ```

Example base-tip config:

```toml
protected = ["AGENTS.md", "verify", ".github/*"]
tests = ["tests/*"]
```

Globs use case-sensitive Python `fnmatch` on root-relative Git paths.
`*` matches `/`; `**` has no special recursive meaning. Directory names are
not implicit globs. Empty arrays impose no restrictions for that category.
The config comes from the base, never the PR version.

## Protected and test changes

Flagged paths are changed paths matching `protected`, and paths matching
`tests` with removed lines or binary changes. Replacing lines counts as removal;
both sides of content-detected renames are checked.

When any paths are flagged, the latest `review` status's target URL must be
`https://github.com/OWNER/REPO/pull/N#pullrequestreview-ID` for this repository
and PR. The command fetches that formal review through the GitHub API and
requires its `commit_id` to equal the exact head and its body to contain every
flagged root-relative path verbatim. A bad URL, commit mismatch or missing path
refuses. With no flagged paths, no review fetch is needed.

Review authorship is not verified. A review body is evidence, not identity;
neither it nor the metrics line proves who approved or performed work.

## Merge recheck

The command fetches complete base/head histories into a temporary bare repo
under `~/.cache/agent-tmp`, using `gh auth git-credential` for private access.
Local Git proves ancestry and inspects the diff, without GitHub patch limits.
It rereads the head, current base tip/ref, body, PR state, and latest
relevant statuses before merging; observed changes refuse. There is still a
race after that reread. Only the head is guarded by GitHub's merge command:

```sh
gh pr merge URL --merge --match-head-commit HEAD
```

## Independent reviewer

[The reviewer prompt](pr-review.prompt.md) is the source template for a T3
webhook schedule in each adopting repository's project. Create it from a Pi
`openai-codex/gpt-6.1-sol` thread with thinking `high`, using
`bindToCurrentThread: false` and the adopting project's
`defaultThreadEnvMode=local`. Each event gets a fresh thread; a T3-created wrapper
worktree is its read-only host, not its review checkout. Verify provider, model
and thinking from a real run's metadata. Never use a bound dispatcher.

Subscribe GitHub to `pull_request` events. The prompt handles only `opened`,
`synchronize` and `ready_for_review`, and ignores drafts. Use the public
`webhookUrl` returned by T3, never an internal path. If T3 returns no public
URL, enable T3 Connect remote access. Configure HMAC-SHA256 with header
`x-hub-signature-256`, hex encoding and prefix `sha256=`. The Sol thread first
creates the schedule disabled with no signature. Tobias privately provisions
`~/.config/pr-review/webhook-secret`, mode 600, with no trailing newline. Both
ends must use identical raw file bytes, without stripping. From the creating
Sol thread, read that file at call time and pass its value as `signature.secret` to
`update_scheduled_task`, keeping the schedule disabled. Do not print or log the
value. Cross-thread secret refs are rejected; do not retry them or enable an
unsigned schedule. Enable only after signature attachment and public URL
availability. This preserves the creator's Sol model selection.

For the GitHub repository hook, read the matching secret from
`~/.config/pr-review/webhook-secret`, mode 600, by file path, for example with
`gh api -F 'config[secret]=@/home/tb/.config/pr-review/webhook-secret'` as part of
the hook-create request. Hook updates also require the existing URL in the
config object. Never print, log or commit the secret. Enable the signed schedule
before delivering a ping: disabled schedules return `409 hook_disabled`.
Confirm a signed request is accepted and an unsigned request is rejected, then
confirm GitHub's ping starts a run that posts nothing. A signature mismatch
blocks PR proof and adoption.

The reviewer fetches the PR, linked issue and plan comment, diff, repository
instructions, and exact-head gate status and artifacts. Missing gate evidence
is failure, not permission to run a replacement gate. Publish the gate before
the review trigger, for example by creating a draft PR, posting the completed
gate, then marking the PR ready.

The shared root and T3 host are used only for Git metadata, fetching and
worktree administration. Neither gets edits, commits, builds or probes.
Repository code runs in a unique detached worktree keyed by repo and payload SHA. The reviewer may build and run focused probes through the repo's
entry points, but never pushes or edits the PR branch. It removes its worktree
and prunes on success or failure, preserving cited receipts under
`~/.cache/pr-review/OWNER/REPO/SHA-evidence/RUN_ID/`.

Before admission, even for ignored events, the reviewer prunes only this
schedule's prior single-run terminal wrappers. It joins paginated T3 owner
metadata to Git worktrees, rechecks no active or queued owner, requires a clean
checkout including ignored/untracked files and a reflog containing only the
creation-base SHA, then removes that wrapper and its `t3/*` branch. Live,
unknown, dirty or committed wrappers remain untouched. The running thread's
host remains until a later run. Sequential completed runs leave at most one
wrapper; concurrent live wrappers are not disposable. Prune receipts live under
`~/.cache/pr-review/OWNER/REPO/wrapper-evidence/RUN_ID/`. Verify that a pruned
thread still opens in T3 and that the next scheduled run starts normally.

The payload includes its draft boolean, so a delayed opened-draft event is
ignored even after the PR becomes ready.

After cleanup, a moved head gets no comment or status. Otherwise the reviewer
posts one formal PR review comment and an exact-head `review` commit status,
with the comment URL as its target. Success means no blocking finding, not a
clean review. Every finding is tagged blocking or non-blocking with a one-line
reason. Normal-use or written-requirement defects, security/data loss, broken
contracts, unauthorized protected/test changes and missing gate/plan evidence
block. Style, speculative hostile-environment hardening, unlisted edge cases
and nits remain in the comment with a suggested follow-up issue and do not
block. The reviewer rechecks the head before each write; those separate GitHub
writes are not atomic. The reviewer never merges.

## Results

On success, the command queries the merged PR and prints only its merge SHA.
Refusals and API/Git errors go to stderr, one line per failed check or path,
with a nonzero exit. An error after the merge may mean the PR merged even
though no SHA was printed; inspect GitHub before retrying.
