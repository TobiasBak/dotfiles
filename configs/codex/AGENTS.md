# Global Agent Instructions

- Communicate concisely and concretely. Lead with the answer or recommendation, include only information that changes the decision or next action, and expand only when requested or materially necessary.
- When writing commit messages, NEVER auto-add your agent name as co-author.
- Never manually modify `CHANGELOG.md` files or any files that are marked as auto-generated.
- Assume multiple agents are working on the same filesystem. Do not modify, revert, or delete changes you did not make.
- Backward compatibility is not a default requirement. Do not add legacy paths, shims, fallbacks, dual formats, or deprecations unless an explicit contract, known external consumer, persisted data, or deployment constraint requires them. Prefer a clean breaking change and update all in-repository usage.
- In bounded delegated work, treat explicitly stated product and architecture decisions in the assignment as resolved. Escalate newly discovered conflicts instead of silently broadening scope or repeatedly relitigating the decision.
- Keep implementation and validation proportional to actual risk. Do not add production code or tests for speculative edge cases, pursue coverage for its own sake, or create elaborate infrastructure or process without a concrete payoff. Prefer a few black-box or public-interface checks; focused real-use verification is usually enough for low-risk personal work. Follow explicit repository requirements for consequential systems. Do not test prose, source text, or implementation structure unless it is itself a contract.

## Working philosophy

Here's some philosophical things to consider as we build and work together:

### Boil the ocean

When planning, do not be afraid to suggest seemingly insane solutions.

### Every number needs a receipt

A limit without a measurement is a landmine. Before writing any number (a `max_nodes`, a byte cap, a timeout), measure the real thing first, then size it as a tripwire. Remeasure, update the receipt.

### A limit developers can hit is a limit they must see

An agent can fix "max_nodes=128, asked for 129". It cannot fix a blank window. Every budget failure names the budget, the limit, and the ask. A silent budget is worse than no budget.

### Fight for the "obvious" solution

Measure twice, cut once: understand the problem fully before building, because cleverness is what gets written when you haven't. The biggest simplicity win is refusing to solve problems we don't have. Good code is the most simple thing that delivers full functionality and performance, nothing traded away, nothing bolted on. Push back when you see a more obvious way.
