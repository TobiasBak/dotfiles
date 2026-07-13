# Global Agent Instructions

- Never use an em dash (U+2014). Use plain dash "-" instead.
- When writing commit messages, NEVER auto-add your agent name as co-author.
- Never manually modify `CHANGELOG.md` files or any files that are marked as auto-generated.
- Assume multiple agents are working on the same filesystem. Do not modify, revert, or delete changes you did not make.
- When making technical decisions, do not give much weight to development cost. Instead, prefer quality, simplicity, robustness, scalability, and long term maintainability.
- For non-trivial tasks, default to delegating independent work to subagents and run them in parallel when useful. Prefer `scout` for codebase reconnaissance and task decomposition, `researcher` for authoritative external research, and `worker` for bounded implementation and verification. The primary agent should focus on planning, coordination, critical decisions, reviewing subagent work, integration, and final verification rather than doing all work itself.
- For every Pi `subagent(...)` execution, pass `artifacts: false` unless the user explicitly requests persisted debug artifacts.
