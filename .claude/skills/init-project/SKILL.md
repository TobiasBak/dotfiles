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

### Phase 3.5: Ask User for Tooling (if not auto-detected)

If lint, format, or test commands could NOT be auto-detected from config files, use AskUserQuestion to ask the user which tool they want to use. Provide up to 5 common options based on the detected language/ecosystem.

#### Linting Tools by Language

| Language | Options |
|----------|---------|
| JavaScript/TypeScript | ESLint, Biome, TSLint (deprecated), Standard, XO |
| Python | Ruff, Pylint, Flake8, Pyflakes, Bandit |
| Rust | Clippy (built-in) |
| Go | golangci-lint, staticcheck, go vet, revive, errcheck |
| Ruby | RuboCop, Standard Ruby, Reek, Brakeman, Fasterer |
| Java | Checkstyle, SpotBugs, PMD, SonarLint, Error Prone |
| C/C++ | clang-tidy, cppcheck, cpplint, include-what-you-use, Flawfinder |

#### Formatting Tools by Language

| Language | Options |
|----------|---------|
| JavaScript/TypeScript | Prettier, Biome, dprint, StandardJS, ESLint --fix |
| Python | Black, Ruff format, autopep8, YAPF, Blue |
| Rust | rustfmt (built-in) |
| Go | gofmt (built-in), goimports, gofumpt, golines, gci |
| Ruby | RuboCop --autocorrect, Standard Ruby, rufo, prettier-ruby, Syntax Tree |
| Java | google-java-format, Spotless, Palantir Java Format, Eclipse formatter, AOSP formatter |
| C/C++ | clang-format, astyle, uncrustify, indent, editorconfig |

#### Testing Tools by Language

| Language | Options |
|----------|---------|
| JavaScript/TypeScript | Vitest, Jest, Mocha, AVA, Playwright |
| Python | pytest, unittest, nose2, doctest, ward |
| Rust | cargo test (built-in), nextest |
| Go | go test (built-in), testify, ginkgo, gocheck, goconvey |
| Ruby | RSpec, Minitest, Test::Unit, Shoulda, Cucumber |
| Java | JUnit, TestNG, Spock, Mockito, AssertJ |
| C/C++ | Google Test, Catch2, CTest, doctest, Boost.Test |

#### AskUserQuestion Format

Ask up to 3 questions in a single AskUserQuestion call (one for each missing tool type). Example:

```
Question 1 (if lint not detected):
- header: "Linter"
- question: "Which linter would you like to use for this project?"
- options: [appropriate options for detected language]

Question 2 (if formatter not detected):
- header: "Formatter"
- question: "Which formatter would you like to use for this project?"
- options: [appropriate options for detected language]

Question 3 (if test runner not detected):
- header: "Test Runner"
- question: "Which test runner would you like to use for this project?"
- options: [appropriate options for detected language]
```

If the user selects "Other", ask them to provide the command manually.

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

### Phase 6: Setup PostToolUse Lint Hook

After generating CLAUDE.md, set up a PostToolUse hook that automatically runs the lint command after Write and Edit tool calls. This ensures code quality is checked immediately after any file modifications.

#### Ask User About Hook Setup

Use AskUserQuestion:
- header: "Lint Hook"
- question: "Would you like to set up an automatic lint hook that runs after file edits?"
- options:
  - "Yes - Run lint after Write/Edit (Recommended)" - Automatically check code quality after modifications
  - "No - I'll run lint manually" - Skip automatic hook setup

#### Hook Configuration

If user chooses yes, create or update `.claude/settings.local.json` in the project root with the following structure:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "{{LINT_COMMAND}}",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

Replace `{{LINT_COMMAND}}` with the detected or user-selected lint command from Phase 3/3.5.

#### Important Notes

- Use `.claude/settings.local.json` (project-local) rather than global settings
- If the file already exists, merge the new hook with existing hooks (don't overwrite)
- Set a reasonable timeout (30 seconds) for the lint command
- The matcher `Write|Edit` uses regex to match both tool names
- If lint command was not detected/selected, skip this phase and inform the user
