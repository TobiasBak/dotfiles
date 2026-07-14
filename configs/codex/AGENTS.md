# Global Agent Instructions

- Never use an em dash (U+2014). Use plain dash "-" instead.
- When writing commit messages, NEVER auto-add your agent name as co-author.
- Never manually modify `CHANGELOG.md` files or any files that are marked as auto-generated.
- Assume multiple agents are working on the same filesystem. Do not modify, revert, or delete changes you did not make.
- When making technical decisions, do not give much weight to development cost. Instead, prefer quality, simplicity, robustness, scalability, and long term maintainability.

## Decomposing work

- Break broad work into coherent, manageable pieces that can be completed and checked independently.
- Keep tightly coupled reasoning and changes together.
- Identify prerequisites and complete them before dependent work. Independent pieces may proceed concurrently when useful.
- Resolve decisions that affect multiple pieces deliberately, then integrate and verify the complete result.
- Coordinate work that touches shared state and preserve concurrent changes.

## Models and thinking

- Use Luna for clear, bounded, independently verifiable leaf work.
- Use Sol for synthesis, architecture, difficult debugging, integration, ambiguity, and high-consequence review.
- Use low thinking for retrieval and mechanical work, medium for ordinary multi-step execution, and high for judgment-heavy or consequential work.
- Raise thinking as ambiguity, risk, or weak validation increases.
