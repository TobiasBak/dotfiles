---
description: Commit and push relevant git changes with safe ignores and precise message
argument-hint: "[scope or extra instructions]"
---
Commit and push relevant work. Extra instructions: $ARGUMENTS

Workflow:
1. Inspect repo state:
   - `git status --short`
   - `git diff --stat`
   - `git diff -- . ':!*.lock'` when useful
   - `git diff --cached --stat` if staged files exist
2. Identify files that should not be pushed:
   - secrets: `.env`, `.env.*`, keys, tokens, certs, credentials, local settings
   - runtime/cache: logs, tmp, cache, backups, OS junk, editor state
   - generated/build outputs unless repo clearly tracks them intentionally
   - machine-local config containing absolute local paths or personal data
3. Update `.gitignore` before staging when untracked/modified unsafe files appear. Do not commit secrets. If uncertain, stop and ask.
4. Stage only relevant files for coherent commit:
   - use `git add <paths>` instead of blind `git add -A` when unrelated changes exist
   - include `.gitignore` updates needed to keep unsafe files out
   - leave unrelated work unstaged and mention it
5. Review staged changes:
   - `git diff --cached --stat`
   - `git diff --cached --check`
   - inspect staged diff enough to understand intent
6. Create precise commit:
   - subject: imperative, concise, specific, no vague "update stuff"
   - body: bullets summarizing notable changes and why, when useful
   - example:
     `git commit -m "Add pi yeet prompt" -m "- Add prompt template for safe commit/push workflow\n- Link pi prompts in installers"`
7. Push:
   - determine current branch with `git branch --show-current`
   - if upstream exists, `git push`
   - if no upstream, `git push -u origin <branch>`
8. Report:
   - commit hash
   - branch pushed
   - any ignored or unstaged files left behind

Safety rules:
- Never commit credentials or secrets.
- Never force push unless explicitly requested.
- Never amend existing commit unless explicitly requested.
- If changes look destructive or unrelated, ask before committing.
