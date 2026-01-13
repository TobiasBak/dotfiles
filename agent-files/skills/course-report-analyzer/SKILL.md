---
name: course-report-analyzer
description: |
  Use this skill when the user wants to analyze a student report against course lecture materials.
  Triggers when user asks to: "analyze my report against the course", "check course coverage",
  "compare report to lectures", "suggest report improvements based on course material",
  or "create lecture summaries and analyze report".
version: 1.0.0
---

# Course Report Analyzer

Analyzes student project reports against course lecture materials to identify coverage gaps and suggest improvements.

## Workflow Overview

```
1. Discover Files → 2. Create Summary Dir → 3. Parallel Agents → 4. Read All → 5. Generate Suggestions
```

## Step 1: Discover and Validate Files

Find all required files using Glob:

```
Lectures:    **/*lecture*.pdf OR **/*lesson*.pdf OR **/lectures/**/*.pdf
Report:      **/*report*.pdf
Requirements: **/*requirement*.txt OR **/*requirement*.md
```

## Step 2: Create Summary Directory

```bash
mkdir summary
```

## Step 3: Launch Parallel Background Agents

**CRITICAL: Launch ALL agents in a SINGLE message for true parallelism.**

For each lecture, use the Task tool with these parameters:

| Parameter | Value |
|-----------|-------|
| subagent_type | `general-purpose` |
| run_in_background | `true` |
| description | `Write lesson_XX summary` |

**Agent Prompt Template:**

```
Read the lecture file(s) at [LECTURE_PATH] and write a concise summary to [SUMMARY_DIR]/lesson_XX_[topic].md

The summary MUST include these sections:
## Key Concepts
## Main Topics and Techniques
## Practical Applications
## Important [Engine/Framework] Features

If the lecture is split into multiple parts (part1.pdf, part2.pdf), read ALL parts before writing.
Keep it focused and practical for a [COURSE_TYPE] course.
```

**Example - launching 10 agents in parallel:**

```xml
<function_calls>
<invoke name="Task">
  <parameter name="description">Write lesson_02 summary</parameter>
  <parameter name="prompt">Read lectures/Lesson_02*.pdf, write to summary/lesson_02_blueprints.md...</parameter>
  <parameter name="subagent_type">general-purpose</parameter>
  <parameter name="run_in_background">true</parameter>
</invoke>
<invoke name="Task">
  <parameter name="description">Write lesson_03 summary</parameter>
  <parameter name="prompt">Read lectures/Lesson_03*.pdf, write to summary/lesson_03_cpp.md...</parameter>
  <parameter name="subagent_type">general-purpose</parameter>
  <parameter name="run_in_background">true</parameter>
</invoke>
<!-- ... repeat for all lectures ... -->
</function_calls>
```

## Step 4: Wait and Collect Results

While agents run, you can work on other tasks. Check progress with:

```xml
<invoke name="TaskOutput">
  <parameter name="task_id">[AGENT_ID]</parameter>
  <parameter name="block">false</parameter>
</invoke>
```

When ready to wait for completion:

```xml
<invoke name="TaskOutput">
  <parameter name="task_id">[AGENT_ID]</parameter>
  <parameter name="block">true</parameter>
  <parameter name="timeout">120000</parameter>
</invoke>
```

## Step 5: Read All Content

After all agents complete, read in parallel:

1. **All lecture summaries** - Use Read tool for each `summary/*.md`
2. **The report PDF** - Read tool handles PDFs directly
3. **Requirements files** - Both project and report requirements

## Step 6: Generate report_suggestions.md

Create a comprehensive suggestions file with this structure:

```markdown
# Report Improvement Suggestions

## Executive Summary
[3-4 bullet points on main improvement areas]

## Course Coverage Analysis

### Strong Coverage (Keep/Minor Enhancements)
| Lesson | Topic | Report Section | Notes |

### Partial Coverage (Should Expand)
| Lesson | Topic | What's Missing |

### Not Covered (Should Add)
| Lesson | Topic | Relevance to Project |

## Section-by-Section Suggestions

### [Section Name] (Page X)
**Current State**: [Assessment]
**Suggestions**:
- [Specific suggestion with example text]

### NEW SECTION: [Suggested Addition]
[Proposed content]

## Quick Wins - Easy Additions
| Location | Addition |

## Missing Topics to Address
### [Topic from course]
[Why relevant, suggested text]

## Terminology Reference
| Generic Term | Course-Specific Term |

## Summary
[Priority improvements list]
```

## File Naming Conventions

| Type | Pattern | Example |
|------|---------|---------|
| Lecture Summary | `lesson_XX_[topic].md` | `lesson_02_blueprints.md` |
| Suggestions | `report_suggestions.md` | - |
| Summary Dir | `summary/` | - |

## Tips for Quality Results

1. **Agents should read ALL parts** of split lectures before summarizing
2. **Summaries should be practical** - focus on what's applicable to projects
3. **Cross-reference carefully** - map report sections to specific lessons
4. **Include example text** - don't just say "add X", show what to add
5. **Use course terminology** - identify generic vs course-specific terms
6. **Be specific about pages/sections** - reference exact locations in report
