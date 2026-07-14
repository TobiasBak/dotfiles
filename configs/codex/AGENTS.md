# Global Agent Instructions

- Never use an em dash (U+2014). Use plain dash "-" instead.
- When writing commit messages, NEVER auto-add your agent name as co-author.
- Never manually modify `CHANGELOG.md` files or any files that are marked as auto-generated.
- Assume multiple agents are working on the same filesystem. Do not modify, revert, or delete changes you did not make.
- When making technical decisions, do not give much weight to development cost. Instead, prefer quality, simplicity, robustness, scalability, and long term maintainability.
- Prefer tests that verify observable behavior through public interfaces. Do not test prose, prompt wording, source text, or implementation structure unless it is itself a compatibility contract; then assert only the smallest stable invariant.
