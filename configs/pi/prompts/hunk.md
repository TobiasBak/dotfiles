---
description: Address every actionable human Hunk review comment in the working tree
argument-hint: "[additional instructions]"
---
You explicitly asked me to modify the working tree to address every actionable human-authored Hunk comment, not merely review the diff or add agent comments.

1. Run `hunk skill path`, then read the exact returned SKILL.md path completely and follow it.
2. Use only noninteractive `hunk session` commands. Never launch `hunk diff`, `hunk show`, or any other interactive Hunk TUI. If no live session exists, ask the user to launch Hunk first and stop.
3. List human comments with `hunk session comment list --repo . --type user`. Inspect the necessary files, diff, and surrounding code, then address every actionable comment. Preserve all comments: never clear or delete them unless explicitly asked.
4. Treat the additional instructions below as context, while keeping the explicit comment-addressing goal:

$ARGUMENTS

Ask the user when a comment is ambiguous or would require unapproved product, API, or architecture scope. Run focused validation after making changes. Refresh or reinspect the live Hunk review with noninteractive session commands as useful, without clearing comments.

Summarize which comments were addressed or deferred, files changed, validation run, and any remaining ambiguity or risk.
