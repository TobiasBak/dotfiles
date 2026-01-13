---
name: brainstorm
description: Brainstorm ideas from simple features to entire projects. Use when user wants to explore an idea, brainstorm, plan something new, or think through changes. Triggers on "brainstorm", "I have an idea", "let's think through", "help me plan", or ideation requests. Creates minimal SPEC.md, then invokes interview-project for large-scope ideas (new projects, major refactors, infrastructure changes).
---

# Brainstorm Skill

## Workflow

1. **Gather idea + category** via AskUserQuestion:
   - Idea description (free text)
   - Category: New project | New feature | Major refactor | Infrastructure change | Something else

2. **Ask 2-4 follow-up questions** based on category (see below)

3. **Write minimal SPEC.md** at project root

4. **Evaluate scope**:
   - Large (New project, Major refactor, Infrastructure change) → invoke `interview-project` skill
   - Small (New feature, Something else) → done
   - Uncertain → ask user if they want deeper interview

5. **If large**: Use `Skill` tool to invoke `interview-project`. Do NOT read that skill's content beforehand.

## Category Questions

**New project**: Value proposition? Target user? Key features?
**New feature**: Problem solved? Location in codebase? Dependencies?
**Major refactor**: What's painful? Desired state? Boundaries?
**Infrastructure**: Pain points? Target architecture? Constraints?
**Something else**: Desired outcome? Success criteria?

## Minimal SPEC.md Template

```markdown
# [Idea Name]

**Category**: [category]

## Summary
[1-2 sentence description]

## Key Points
- [bullet]
- [bullet]

## Open Questions
- [if any]
```

## Delegation

When scope is large, invoke interview-project:
```
Use Skill tool with skill: "interview-project"
```
Brainstorm skill completes when interview-project finishes.
