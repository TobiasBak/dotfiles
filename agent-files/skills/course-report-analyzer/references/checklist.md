# Course Report Analyzer Checklist

Quick reference for running the skill.

## Pre-flight Checks

- [ ] Lecture PDFs exist in a `lectures/` directory (or similar)
- [ ] Report PDF exists
- [ ] Requirements file(s) exist
- [ ] You have write access to create `summary/` directory

## Execution Checklist

### Phase 1: Discovery
- [ ] Glob for lecture PDFs
- [ ] Glob for report PDF
- [ ] Glob for requirements files
- [ ] Count unique lectures (group parts)

### Phase 2: Setup
- [ ] Create `summary/` directory
- [ ] Plan agent prompts for each lecture

### Phase 3: Parallel Summarization
- [ ] Launch ALL agents in ONE message (critical for parallelism)
- [ ] Use `run_in_background: true`
- [ ] Use absolute file paths in prompts
- [ ] Specify output file path in each prompt

### Phase 4: Collection
- [ ] Check agent progress with `block: false`
- [ ] Wait for completion with `block: true`
- [ ] Verify all summary files created

### Phase 5: Analysis
- [ ] Read ALL summary files
- [ ] Read report PDF
- [ ] Read requirements files
- [ ] Build coverage matrix

### Phase 6: Output
- [ ] Generate `report_suggestions.md` with:
  - [ ] Executive summary
  - [ ] Coverage analysis tables
  - [ ] Section-by-section suggestions
  - [ ] Quick wins table
  - [ ] Terminology reference
  - [ ] Priority list

## Agent Prompt Checklist

Each summarization agent prompt should include:

- [ ] Absolute path to lecture file(s)
- [ ] Instruction to read ALL parts if split
- [ ] Absolute path for output file
- [ ] Required sections (Key Concepts, Topics, Applications, Features)
- [ ] Course context (what type of course)
- [ ] Word/length guidance

## Quality Checks

After completion, verify:

- [ ] All lectures have summaries
- [ ] Summaries have all required sections
- [ ] Suggestions reference specific page numbers
- [ ] Suggestions include example text, not just "add X"
- [ ] Terminology table maps generic → course-specific terms
- [ ] Missing topics are flagged with relevance explanation
