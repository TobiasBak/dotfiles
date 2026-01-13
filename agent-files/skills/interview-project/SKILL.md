---
name: interview-project
description: Interview users in-depth about project requirements to create a comprehensive specification. Use when starting a new project, gathering requirements, or when user wants to document project decisions. Triggers on requests like "interview me about my project", "gather requirements", "create spec", "help me plan this project", or when user wants to build/update SPEC.md.
---

# Project Interview Skill

## Workflow

1. **Understand existing context**
   - Check for existing project structure (use Glob to find source files, configs, etc.)
   - If project exists, analyze its architecture and patterns
   - If no project structure, check for existing SPEC.md and read it

2. **Conduct in-depth interview using AskUserQuestionTool**
   - Ask non-obvious, probing questions - avoid surface-level queries
   - Cover these areas systematically:
     - **Technical implementation**: Architecture decisions, data models, API design, state management, dependencies, integrations
     - **UI & UX**: User flows, edge cases in interactions, accessibility, error states, loading states, responsive behavior
     - **Concerns**: Security considerations, performance bottlenecks, scalability limits, maintenance burden
     - **Tradeoffs**: Build vs buy, simplicity vs flexibility, speed vs correctness, consistency vs availability
   - Ask follow-up questions based on answers - dig deeper into interesting or unclear areas
   - Challenge assumptions politely - "Have you considered X?" or "What happens when Y?"

3. **Continue until comprehensive**
   - Keep interviewing until all major areas are covered
   - Let user indicate when they feel the interview is complete
   - Summarize key decisions periodically to confirm understanding

4. **Write the specification**
   - Write comprehensive spec to SPEC.md in the project root
   - Include all gathered requirements, decisions, and rationale
   - Structure clearly with sections for overview, technical details, UI/UX, constraints, and open questions

## Question Guidelines

Avoid asking obvious questions.
