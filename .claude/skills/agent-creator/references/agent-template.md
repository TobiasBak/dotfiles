# Agent Template Reference

This file contains the complete template for generating Claude Code sub-agent configuration files.

## Complete Agent Template

```markdown
---
name: <kebab-case-agent-name>
description: <action-oriented-description-stating-when-to-use>
tools: <tool-1>, <tool-2>, <tool-3>
color: <red|blue|green|yellow|purple|orange|pink|cyan>
---

# Purpose

You are an expert agent in <domain/role-definition>. Your primary responsibility is to <main-task-description>.

## Instructions

When invoked, follow these steps:

1. **<First Action>**: <Detailed description of the first step>
2. **<Second Action>**: <Detailed description of the second step>
3. **<Third Action>**: <Detailed description of the third step>
4. **<Continue as needed>**: <Additional steps>

## Best Practices

- <Best practice specific to this agent's domain>
- <Another relevant best practice>
- <Additional guidelines as needed>

## Report / Response

Provide your final response in the following format:

### Summary
<Brief overview of what was accomplished>

### Details
<Detailed findings, changes made, or analysis results>

### Recommendations
<If applicable, next steps or suggestions>
```

