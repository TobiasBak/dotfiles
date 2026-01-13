---
name: plan-to-features
description: Convert a plan into ordered, self-contained feature documents for cross-session development. Use when user says "plan to features", "split plan into features", "create feature docs", or after completing a large plan that should be broken into separate development tasks. Creates numbered feature files in /.agent-features/ folder.
---

# Plan to Features

Convert a plan into numbered, self-contained feature documents.

## Workflow

1. **Locate the plan source**
   - Check for plan file in project root (plan.md, PLAN.md)
   - If not found, analyze recent conversation for the plan content
   - If no plan exists, inform user and exit

2. **Analyze and split the plan**
   - Identify logical feature boundaries using AI judgment
   - Order features by dependency and logical sequence
   - Ensure each feature is independently implementable

3. **Create the feature directory**
   - Create `/.agent-features/` at project root if it doesn't exist
   - Create `/.agent-features/completed/` subdirectory

4. **Generate feature documents**
   - Create numbered files: `01-feature-name.md`, `02-feature-name.md`, etc.
   - Each document must be fully self-contained (see format below)
   - Include all context needed - no external references

5. **Report completion**
   - List all created feature files
   - Summarize what each feature covers

## Feature Document Format

```markdown
# Feature: [Name]

## Overview
[1-2 paragraph description of what this feature accomplishes and why it matters]

## Requirements
- [Detailed requirement 1]
- [Detailed requirement 2]

## Acceptance Criteria
- [ ] [Specific, checkable item]
- [ ] [Another checkable item]

## Constraints
- [Technical constraints]
- [Dependencies on other features if any]
```

## Key Principles

- **Self-contained**: Each feature doc has ALL context needed. No references to SPEC.md, conversation, or other features.
- **Ordered**: Number prefix indicates suggested implementation order.
- **No preview**: Generate files directly. User can edit afterward.
- **Trust AI judgment**: Determine feature boundaries based on logical cohesion.

## Output Location

```
project-root/
└── .agent-features/
    ├── 01-first-feature.md
    ├── 02-second-feature.md
    └── completed/
```
