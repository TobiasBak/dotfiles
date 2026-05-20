---
description: Commit and push current git changes
argument-hint: "[extra instructions]"
---
Commit and push current work. Extra instructions: $ARGUMENTS

Workflow:
1. Run exactly one inspection command to see changed files:
   ```bash
   git status --short && git diff --stat && git diff --cached --stat && git branch --show-current
   ```
2. Stage relevant changed files. Avoid obvious secrets like `.env`, keys, tokens, credentials, certs, logs, caches, and build outputs.
3. Commit with best message possible from context and changed file names.
4. Push current branch. If no upstream exists, set upstream to `origin/<branch>`.
5. Report commit hash and branch pushed.

Rules:
- Do not force push.
- Do not amend unless explicitly requested.
- If obvious secret would be committed, stop and ask.
