---
name: develop-feature
description: Pick up and implement the next available feature from /.agent-features/. Use when user says "develop feature", "work on next feature", "implement feature", or starts a new session to continue feature-driven development. Handles the full cycle from implementation through code review to commit.
---

# Develop Feature

Pick up, implement, and complete the next available feature.

## Workflow

### 1. Select Feature

```
1. Check for started-*.md files (resume interrupted work)
2. If none, find lowest-numbered NN-*.md file
3. If no features available, inform user and exit
```

### 2. Claim Feature

- Rename selected file to `started-<original-name>.md`
- Read the feature document thoroughly

### 3. Implement

- Implement all requirements from the feature document
- Write tests for the implementation (required)
- Run tests - must pass before proceeding

**On blocker**: If unclear requirements or missing dependencies, pause and ask user. Do not guess.

### 4. Review Cycle

Run subagents in sequence:

```
1. Invoke code-simplifier subagent on changed files
2. Invoke test-reviewer subagent on test files
3. Run tests again
4. If tests fail → fix issues and repeat from step 1
5. If tests pass → proceed to commit
```

### 5. Complete

1. **Commit changes** with message: `feat: <feature-name>`
2. **Move feature doc** to `/.agent-features/completed/`
3. **Report completion** with summary of what was implemented

## Feature Selection Logic

```
/.agent-features/
├── started-02-profile.md    ← Pick this first (resume)
├── 01-auth.md               ← Pick this if no started-*
├── 03-dashboard.md
└── completed/
```

Priority:
1. Any `started-*.md` file (resume interrupted work)
2. Lowest numbered `NN-*.md` file

## Subagent Integration

Invoke using Task tool with subagent_type:

- **code-simplifier**: Simplifies implementation code
- **test-reviewer**: Reviews test quality

These run autonomously. If their changes break tests, fix and retry.

## Completion Checklist

Before marking complete, verify:
- [ ] All requirements from feature doc implemented
- [ ] All acceptance criteria checkboxes satisfiable
- [ ] Tests written and passing
- [ ] Code reviewed by code-simplifier
- [ ] Tests reviewed by test-reviewer
- [ ] Changes committed
- [ ] Feature doc moved to completed/
