---
name: reflect
description: |
  Analyze and improve skills based on session outcomes. Use when: user says "reflect",
  "improve the skill", "what went wrong with the skill", "optimize skills", or wants to
  analyze skill effectiveness after using one. Triggers: "reflect", "skill improvement",
  "fix the skill", "update skill based on session".
---

# Reflect

Analyze conversation context to identify used skills, evaluate effectiveness, and apply improvements.

## Workflow

1. **Check for skill usage** - Scan context for `Skill` tool calls or `<command-name>` tags. If none found, inform user "No skills were used this session" and stop.
2. **Analyze context** - Identify issues and outcomes from the skills that were used
3. **Gather feedback** - Use AskUserQuestion if issues aren't clear from context
4. **Read skill files** - Glob for `~/.claude/skills/*/SKILL.md`, read relevant ones
5. **Identify gaps** - Compare skill instructions vs actual behavior vs user expectations
6. **Apply changes** - Edit skill files, preserve YAML frontmatter + markdown structure
7. **Report** - Summarize what was analyzed, identified, and changed

## Common Issues to Look For

- Missing/wrong trigger phrases in description
- Unclear or ambiguous workflow steps
- Missing edge case handling
- Overly verbose instructions (violates "concise is key")
- Missing tool usage patterns

## Guidelines

- Be conservative - only fix clear issues
- Focus on root causes, not symptoms
- Consider if issue was with skill or how it was invoked
