---
name: init-project
description: Initialize a project with a CLAUDE.md file by exploring the codebase and auto-detecting development workflows. Use when user wants to set up Claude Code for a new project, create a CLAUDE.md, or run /init-project. Explores codebase structure, detects package managers, lint/test/format commands, and generates a comprehensive CLAUDE.md.
---

# init-project

Generate a CLAUDE.md file for the current project by exploring the codebase and auto-detecting tooling.

## Workflow

### Phase 1: Check for Existing CLAUDE.md

1. Check if CLAUDE.md exists in project root
2. If exists, use AskUserQuestion:
   - "A CLAUDE.md already exists. What would you like to do?"
   - Options: "Overwrite", "Cancel"
3. If user cancels, stop execution

### Phase 2: Explore Codebase

Launch 1-2 Explore agents in parallel to understand the project:

**Agent 1 - Tooling & Config:**
- Find package manager config files (package.json, Cargo.toml, pyproject.toml, go.mod)
- Identify scripts for lint, test, format, build
- Detect lock files to determine package manager

**Agent 2 - Structure & Frameworks:**
- Map top-level directory structure
- Identify frameworks (React, Vue, Next.js, Django, FastAPI, etc.)
- Find component/styling patterns (Tailwind, CSS modules, styled-components)

### Phase 3: Auto-Detection

Detect values using these heuristics:

#### Package Manager (by lock file)
| Lock File | Package Manager |
|-----------|-----------------|
| bun.lockb | bun |
| pnpm-lock.yaml | pnpm |
| yarn.lock | yarn |
| package-lock.json | npm |
| Cargo.lock | cargo |
| poetry.lock | poetry |
| uv.lock | uv |
| go.sum | go |

#### Commands (from config files and scripts)

**Lint:**
- package.json: `scripts.lint`
- .eslintrc*, eslint.config.*: `npx eslint .` or `{pkg} run lint`
- biome.json: `{pkg} biome check`
- ruff.toml, pyproject.toml [tool.ruff]: `ruff check .`
- Cargo.toml: `cargo clippy`

**Test:**
- package.json: `scripts.test`
- jest.config.*, vitest.config.*: `{pkg} test` or `{pkg} run test`
- pytest.ini, pyproject.toml [tool.pytest]: `pytest`
- Cargo.toml: `cargo test`

**Format:**
- package.json: `scripts.format`
- .prettierrc*: `npx prettier --write .`
- biome.json: `{pkg} biome format --write`
- pyproject.toml [tool.black]: `black .`
- rustfmt.toml: `cargo fmt`

Replace `{pkg}` with detected package manager.

#### Project Structure
Generate an abstract tree of top-level directories with brief descriptions:
```
src/          - Source code
tests/        - Test files
components/   - UI components
lib/          - Shared utilities
```

### Phase 4: Ask User for Missing Information

Use AskUserQuestion to gather:

1. **"Always do" rules:**
   - "What rules should Claude always follow in this project?"
   - Provide text input for project-specific rules
   - Examples to suggest: package manager preference, coding conventions, PR requirements

2. **Styling guidelines** (if UI framework detected):
   - "What styling guidelines should Claude follow?"
   - Context: mention detected framework/libraries
   - Examples: component patterns, naming conventions, accessibility requirements

### Phase 5: Generate CLAUDE.md

Read the template from [references/claude-md-template.md](references/claude-md-template.md).

Replace placeholders with detected/provided values:
- `{{LINT_COMMAND}}` - Detected lint command or fallback comment
- `{{TEST_COMMAND}}` - Detected test command or fallback comment
- `{{FORMAT_COMMAND}}` - Detected format command or fallback comment
- `{{ALWAYS_DO_RULES}}` - User-provided rules as bullet points
- `{{STYLING_GUIDELINES}}` - User-provided guidelines as bullet points
- `{{PROJECT_STRUCTURE}}` - Auto-generated directory tree

Write the final CLAUDE.md to the project root.

## Example Output

```markdown
# Development workflow

```bash
# 1. Make changes

# 2. Run lint (fast)
bun run lint

# 3. Run unit tests
bun test

# 4. Lint and format code
bun run format

# 5. Make a git commit
```

# Always do the following

- Use bun instead of npm for all package operations
- Run tests before committing
- Use conventional commit messages

# Styling guidelines

- Use Tailwind CSS utility classes
- Follow shadcn/ui component patterns
- Ensure all interactive elements are keyboard accessible

# Project structure

src/           - Application source code
components/    - React components
lib/           - Shared utilities and helpers
app/           - Next.js app router pages
public/        - Static assets

# Lessons Learned

<!-- Add lessons learned during development here -->
```
