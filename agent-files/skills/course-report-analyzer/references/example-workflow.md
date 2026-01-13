# Example Workflow: Unreal Engine Game Development Course

This shows a complete example of analyzing a game development report against course lectures.

## Project Structure

```
C:\apps\gamedev\
├── lectures/
│   ├── Lesson_2_-_Blueprints_part1.pdf
│   ├── Lesson_2_-_Blueprints_part2.pdf
│   ├── ...
│   ├── Lesson_3_-_C--_part1.pdf
│   ├── ...
│   └── _11_Sound_and_Light_part15.pdf
├── report.pdf
├── project_requirements.txt
├── report_requirement.txt
├── summary/                          # Created by skill
│   ├── lesson_02_blueprints.md
│   ├── lesson_03_cpp.md
│   ├── lesson_04_debugging_git.md
│   ├── lesson_05_inputs_meshes_collisions.md
│   ├── lesson_06_physics.md
│   ├── lesson_07_ui.md
│   ├── lesson_08_bsp_geometry_vfx.md
│   ├── lesson_09_large_environments.md
│   ├── lesson_10_ai.md
│   └── lesson_11_sound_light.md
└── report_suggestions.md             # Final output
```

## Step 1: Discover Files

```
Glob: **/lectures/**/*.pdf
Found: 80+ PDF files (lectures split into parts)

Glob: **/*report*.pdf
Found: report.pdf

Glob: **/*requirement*.txt
Found: project_requirements.txt, report_requirement.txt
```

## Step 2: Group Lectures by Topic

Analyze filenames to identify unique lectures:

| Lecture | Files | Output Summary |
|---------|-------|----------------|
| Lesson 2 | Lesson_2_-_Blueprints_part1-6.pdf | lesson_02_blueprints.md |
| Lesson 3 | Lesson_3_-_C--_part1-8.pdf | lesson_03_cpp.md |
| Lesson 4 | _4_Debugging_and_Git_part1-7.pdf | lesson_04_debugging_git.md |
| ... | ... | ... |
| Lesson 11 | _11_Sound_and_Light_part1-15.pdf | lesson_11_sound_light.md |

## Step 3: Launch Parallel Agents

**All 10 agents launched in ONE message:**

```python
# Pseudocode for the parallel launch
agents = []
for lecture_num, topic, files in lectures:
    agent = Task(
        description=f"Write lesson_{lecture_num} summary",
        prompt=f"""
Read the lecture files at C:\\apps\\gamedev\\lectures\\{files}
and write a concise summary to C:\\apps\\gamedev\\summary\\lesson_{lecture_num}_{topic}.md

The summary should include:
- Key concepts covered
- Main topics and techniques
- Practical applications for game development
- Important Unreal Engine features mentioned

If the lecture is split into multiple parts, read ALL parts before writing.
Keep it focused and practical - this is for a game development course.
""",
        subagent_type="general-purpose",
        run_in_background=True
    )
    agents.append(agent)
```

## Step 4: Monitor Progress

```python
# Check status without blocking
for agent_id in agent_ids:
    TaskOutput(task_id=agent_id, block=False)

# When ready, wait for all to complete
for agent_id in agent_ids:
    TaskOutput(task_id=agent_id, block=True, timeout=120000)
```

## Step 5: Read All Materials

**In parallel:**
- Read all 10 summary files from `summary/`
- Read `report.pdf` (18 pages)
- Read `project_requirements.txt`
- Read `report_requirement.txt`

## Step 6: Analyze and Generate Suggestions

**Coverage Matrix Built:**

| Lesson | Topic | Covered in Report | Level |
|--------|-------|-------------------|-------|
| 2 | Blueprints | Yes - Section 3.2.1 | Good |
| 3 | C++ | Mentioned in reflection only | Partial |
| 4 | Debugging & Git | Yes - Section 3.1 | Good |
| 5 | Inputs/Collisions | Controls table, no system names | Partial |
| 6 | Physics | Not mentioned | Missing |
| 7 | UI | Yes - Section 2.6 | Good |
| 8 | BSP/VFX | Not mentioned | Missing |
| 9 | Large Environments | Mentioned, no detail | Partial |
| 10 | AI | Yes - behavior trees | Good |
| 11 | Sound & Light | Day/night only, no audio | Partial |

**Output: report_suggestions.md with:**
- Executive summary of gaps
- Section-by-section suggestions with example text
- Quick wins table
- Terminology reference
- Priority list

## Performance Notes

- 10 agents running in parallel: ~2-3 minutes total
- Sequential would take: ~15-20 minutes
- Token usage per agent: ~100k-300k (reading multi-part PDFs)

## Common Issues

1. **Agents can't find files**: Use absolute paths in prompts
2. **Split lectures missed**: Explicitly tell agents to read ALL parts
3. **Summary too long**: Set word limits in prompt
4. **Summary too shallow**: Require specific sections in prompt
