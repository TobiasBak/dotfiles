# Pi extensions

Private TypeScript extensions loaded from Pi's global extension directory. Top-level `*.ts` files and `*/index.ts` files are entrypoints; the other files are internal modules.

## Entrypoints and contracts

- `current-date.ts`: appends the current date to each turn's system prompt.
- `usage.ts`: registers `/usage`, calls the selected Codex OAuth account's usage endpoint, and owns the `weekly-usage` footer status. `activity-dock.ts` only provides its direct status helper and is otherwise a no-op auto-discovered entrypoint.
- `usage-dashboard/index.ts`: registers `/usage-dashboard`, scans Pi, Codex, and benchmark JSONL history, and starts a token-protected loopback HTTP dashboard. Scans use bounded I/O, an mtime/size JSONL cache, and a short coalesced response cache.
- `web-tool-loading.ts`: keeps deferred web retrieval tools inactive until a URL or web search needs them, and adds retrieval hints to search results.
- `multipurpose-tab.ts`: installs the autocomplete-first Tab editor only when no prior custom editor exists. It preserves and warns about an existing editor rather than replacing it.
- `subtask/index.ts`: registers `subtasks`, `subtasks_wait`, and `subtasks_control`; child processes share the working tree, while fork snapshots and overflow artifacts are temporary.
- `autoresearch.ts`: registers `/autoresearch`, parent supervisor tools, worker coordination, and the program-design skill. `/autoresearch N` accepts 1 through 8 workers.
- `compact-tool-loop.ts`: shadow-compacts context crossed by a large tool result and materializes that summary through Pi's normal compaction hook.

## State and side effects

Subtask runtime state is process-global so reload can retain running children; durable results remain available through `subtasks_wait`. Autoresearch stores coordination under the target repository's `.autoresearch/`, creates worker worktrees and RPC Pi processes, and modifies Git refs only through its reviewed integration protocol. The usage dashboard reads session history, writes a private server registry in the Pi agent directory, opens a loopback listener, and may launch the system browser. Weekly usage performs an authenticated network request. Other state is session-local.

Extensions run with the user's permissions. Do not launch autoresearch or invoke installers from development checks.

## Pi coupling

The package is pinned to Pi `0.80.10` and typechecked against its public extension and TUI APIs. `compact-tool-loop/compat.ts` is the sole private API boundary: Pi has no public API for preparing a context replacement without initiating normal compaction. It pins the internal compaction module path and emits one actionable warning if that compatibility check fails. Verify the internal module and compaction behavior before changing the pin.

## Development

From this directory:

```sh
pnpm install
pnpm check
pnpm test
pnpm test:activity
pnpm test:autoresearch
pnpm test:compaction
pnpm test:subtask
```

`pnpm check` includes every extension TypeScript source. Focused scripts run one subsystem; `pnpm test` runs the complete extension suite.
