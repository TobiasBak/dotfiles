---
name: implement
description: |
  TDD-based implementation workflow for feature development, bug fixes, and code changes.
  Use when: implementing features, fixing bugs, adding functionality, writing new code,
  or making any code changes. Triggers: "implement", "add feature", "fix bug", "build",
  "create", "develop", "write code", "TDD", "test-driven".
---

# Implementation

TDD-based workflow for all code changes.

## Workflow

### Phase 1: Understand & Plan

1. Explore codebase to understand context and existing patterns
2. Create detailed TodoWrite items for each test case to implement
3. Mark first todo as in_progress

### Phase 2: Red-Green-Refactor Cycle

For each todo item:

1. **Red**: Write failing test
   - Define expected behavior/contract
   - Include concrete examples and edge cases
   - Follow project test naming conventions
2. Run tests - verify new test fails
3. **Green**: Write minimal code to pass
   - Only implement what's needed to pass the test
   - No premature optimization
4. Run tests - verify all tests pass
5. **Refactor**: Opportunistic cleanup
   - Clean up touched code if beneficial
   - High test coverage ensures safety
6. Run tests - verify still passing
7. Mark todo completed, next as in_progress

### Phase 3: Verify

1. Run full test suite
2. Use available MCP servers or skills for additional verification if applicable
3. Ensure all todos completed

### Phase 4: Subagents

Run the following custom subagents parallel:
1. code-simplifier
2. test-reviewer

## Guidelines

- Investigate and fix test failures autonomously - do not ask unless stuck
- Explain key decisions only, not every step
- High test coverage enables safe opportunistic cleanup of touched code
- Run tests after each TDD cycle, not just at the end
- Use TodoWrite to track each test case for visibility
