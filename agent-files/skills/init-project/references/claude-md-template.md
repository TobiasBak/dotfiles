# CLAUDE.md Template

Use this template when generating the CLAUDE.md file. Replace placeholders with detected or user-provided values.

---

```markdown
# Development workflow

```bash
# 1. Make changes

# 2. Run lint (fast)
{{LINT_COMMAND}}

# 3. Run unit tests
{{TEST_COMMAND}}

# 4. Lint and format code
{{FORMAT_COMMAND}}
```

# Always do the following

{{ALWAYS_DO_RULES}}

# Styling guidelines

{{STYLING_GUIDELINES}}

# Project structure

{{PROJECT_STRUCTURE}}

# Lessons Learned

<!-- Add lessons learned during development here -->
```

---

## Placeholder Descriptions

| Placeholder | Source | Fallback |
|-------------|--------|----------|
| `{{LINT_COMMAND}}` | Auto-detect from package.json scripts, config files | `# No lint command detected` |
| `{{TEST_COMMAND}}` | Auto-detect from package.json scripts, test configs | `# No test command detected` |
| `{{FORMAT_COMMAND}}` | Auto-detect from package.json scripts, formatter configs | `# No format command detected` |
| `{{ALWAYS_DO_RULES}}` | Ask user | `- (Add project-specific rules here)` |
| `{{STYLING_GUIDELINES}}` | Ask user (with framework context if detected) | `- (Add styling guidelines here)` |
| `{{PROJECT_STRUCTURE}}` | Auto-generate from directory analysis | Abstract tree structure |
