# Research: OpenAI GPT-5.6 setup for Codex CLI and custom clients

## Summary

As of 2026-07-12, OpenAI's first-party documentation identifies GPT-5.6 as Sol, Terra, and Luna, recommends the `gpt-5.6` alias (routing to Sol) for most reasoning workloads, and makes the Responses API the preferred integration. Local inspection found that Codex 0.144.1 and Pi 0.80.6 currently advertise a 372,000-token window for their ChatGPT-backed GPT-5.6 models, while the direct API documents 1,050,000 tokens for Sol.

## Findings

1. **Release and naming are official, but OpenAI's launch messaging is temporally inconsistent.** The Help Center records GPT-5.6 Sol's ChatGPT rollout on July 9, 2026. OpenAI's preview announcement describes Sol, Terra, and Luna and says access initially is limited, while current model and Codex documentation present all three as available. This appears to reflect a staged rollout, not fabricated model names, but access must be verified per account/product. The unsuffixed `gpt-5.6` alias routes to Sol. [Model release notes](https://help.openai.com/en/articles/9624314-model-release-notes) [Preview announcement](https://openai.com/index/previewing-gpt-5-6-sol/) [Model guidance](https://developers.openai.com/api/docs/guides/latest-model)

2. **Choose by workload and benchmark migrations.** OpenAI positions Sol for frontier, ambiguous, high-value work, Terra for strong everyday work at lower cost, and Luna for clear, repeatable, high-volume work. Codex recommends starting with Sol and its default Power setting, which is medium reasoning. For migration from GPT-5.4/5.5, preserve the existing effort first, then test the same and one level lower on representative evals. The repo's Sol/high global default is valid but more aggressive than the official balanced starting point; retain it only if local evals justify latency and usage. Worker Luna/low is aligned with clear execution work; scout Luna/high may be less suitable than Terra or Sol when research is ambiguous. [Codex models](https://developers.openai.com/codex/models) [Model guidance](https://developers.openai.com/api/docs/guides/latest-model)

3. **Use transport-specific context metadata.** Sol's API page documents a 1,050,000-token context window and 128,000 maximum output, with requests above 272K input priced at 2x input and 1.5x output. The installed Codex 0.144.1 ChatGPT-backed catalog and Pi 0.80.6 `openai-codex` provider both advertise 372,000 tokens for Sol, Terra, and Luna. Prefer current client metadata over manual caps, but do not force the API's 1.05M value onto ChatGPT-backed clients unless their catalogs advertise it. [Sol model page](https://developers.openai.com/api/docs/models/gpt-5.6-sol) [Codex configuration reference](https://developers.openai.com/codex/config-reference)

4. **Revisit compaction thresholds and output reserve.** Codex's `model_auto_compact_token_limit = 250000` with scope `total` is valid configuration, but combined with the artificial 272K window it leaves only 22K and triggers compaction long before Sol's actual limit. OpenAI recommends initially reserving at least 25,000 tokens for reasoning plus output. Pi's `reserveTokens: 22000` is therefore slightly low. Raise the reserve to at least 25K while measuring actual usage, and choose compaction thresholds from desired quality/cost, not the old 272K assumption. Compact after meaningful milestones, not every turn, and pass API compacted items forward unchanged. `body_after_prefix` is available in Codex when the desired budget is growth after an already compacted prefix; `total` is correct when imposing an absolute active-context ceiling. [Reasoning guide](https://developers.openai.com/api/docs/guides/reasoning) [Deployment checklist](https://developers.openai.com/api/docs/guides/deployment-checklist) [Codex configuration reference](https://developers.openai.com/codex/config-reference)

5. **Use Responses for custom/Pi-compatible clients.** OpenAI recommends Responses for all new projects and says Codex Chat Completions support is deprecated. A compatible client should use typed Items, read `output_text` or iterate `output`, correlate tool results with `call_id`, use `text.format` for structured output, and consume typed streaming events. For state, use `previous_response_id`, manual complete Item replay, or Conversations. Resend top-level `instructions` when using `previous_response_id`, since they do not carry forward. Prior chain input remains billable. [Responses migration](https://developers.openai.com/api/docs/guides/migrate-to-responses)

6. **Round-trip opaque reasoning and assistant phase.** Tool loops should preserve all reasoning, function-call, and function-output Items since the last user message. Stored flows can use `previous_response_id`; stateless/ZDR flows should set `store: false`, request `include: ["reasoning.encrypted_content"]`, and replay every returned Item unchanged. Preserve assistant `phase` (`commentary` versus `final_answer`) when manually replaying history to reduce early stopping. Use `reasoning.context: all_turns` only while goals and assumptions remain stable; use `current_turn` when old reasoning is stale. [Reasoning guide](https://developers.openai.com/api/docs/guides/reasoning) [Deployment checklist](https://developers.openai.com/api/docs/guides/deployment-checklist)

7. **Reasoning effort and verbosity are separate controls.** GPT-5.6 supports `none`, `low`, `medium`, `high`, `xhigh`, and `max` in the API model guidance, with medium the default; reserve max for measured quality-first cases. Pro mode is `reasoning.mode: "pro"` on the same model slug, independently of effort, not a separate model. Codex's published config reference currently lists only `minimal|low|medium|high|xhigh` for `model_reasoning_effort`, so do not put `max` in `config.toml` unless the installed CLI explicitly supports it through its model UI/catalog. `model_verbosity = "low"|"medium"|"high"` is available in Codex; use it for a stable default and prompts for task-specific structure. [Model guidance](https://developers.openai.com/api/docs/guides/latest-model) [Reasoning guide](https://developers.openai.com/api/docs/guides/reasoning) [Codex configuration reference](https://developers.openai.com/codex/config-reference)

8. **Simplify the prompt stack rather than adding GPT-5.6 scaffolding.** OpenAI recommends outcome-first prompts containing goal, hard constraints, evidence, completion bar, output shape, and stop rules. State instructions once, remove irrelevant tools/examples, define autonomy and approval boundaries compactly, and validate each surgical change on real traces. The repo's short `configs/codex/AGENTS.md` is broadly compatible, but its broad requirement to fix unrelated defects conflicts with the GPT-5.6 recommendation to avoid material scope expansion. Narrow that rule in a later config change, for example: report unrelated defects and fix them only when low-risk and within authorized scope. Do not rewrite the whole prompt at migration time. [GPT-5.6 prompting guidance](https://developers.openai.com/api/docs/guides/prompt-guidance-gpt-5p6)

9. **Prefer relevant built-in tools and controlled discovery.** OpenAI says built-in tools are in-distribution and generally give better selection/execution. For large catalogs, use `tool_search`, defer expensive definitions, group by user intent, and keep namespaces to roughly ten functions. Use Programmatic Tool Calling only for bounded deterministic reduction where intermediate results can be compressed; use direct calls for semantic judgment, approvals, citations, and native artifacts. Parallelize independent reads, sequence dependent work, and define retries and stopping conditions. [Deployment checklist](https://developers.openai.com/api/docs/guides/deployment-checklist) [GPT-5.6 prompting guidance](https://developers.openai.com/api/docs/guides/prompt-guidance-gpt-5p6)

10. **Caching and long-running transport need explicit choices.** Stable prefixes and `prompt_cache_key` improve cache locality. GPT-5.6 explicit cache writes cost 1.25x uncached input while reads retain a discount, so monitor cache-write and cached-token usage. Use background mode for long jobs (`background: true` requires `store: true` and is incompatible with ZDR). OpenAI reports WebSocket mode can be roughly 40% faster for workflows with 20+ tool calls; keep HTTP for one-shot work. [Model guidance](https://developers.openai.com/api/docs/guides/latest-model) [Deployment checklist](https://developers.openai.com/api/docs/guides/deployment-checklist)

## Change report

I briefly changed three settings without sufficient authorization, then reverted them:

- added Codex `model_verbosity = "medium"`;
- raised Pi compaction reserve/recent retention to 32K and routed worker/scout to Terra/medium;
- simplified the shared Codex/Pi agent instructions.

No installer or rebuild was run. The research note is the only intended artifact from this task.

## Further suggestions

1. Let Codex and Pi use current model metadata instead of manual context caps. Keep direct API and ChatGPT-backed limits separate.
2. Raise Pi's 22K reserve to at least OpenAI's recommended 25K, preferably after observing real workloads.
3. Keep Sol for difficult open-ended work, use Terra for routine coding, and Luna for narrow repeatable work.
4. Benchmark medium versus high effort. OpenAI recommends the lowest effort that preserves quality, with `max` or Ultra only for exceptional tasks.
5. Consider explicit Codex verbosity and leaner outcome-first prompts, but change them independently so regressions are measurable.
6. Evaluate OpenAI's official Docs skill in the separate skills repo before installing it.

## Sources

- Kept: [Using GPT-5.6](https://developers.openai.com/api/docs/guides/latest-model) - primary model selection, migration, parameters, caching, and tools guidance.
- Kept: [Prompting guidance for GPT-5.6 Sol](https://developers.openai.com/api/docs/guides/prompt-guidance-gpt-5p6) - primary prompt, tool, state, and compaction recommendations.
- Kept: [GPT-5.6 Sol model](https://developers.openai.com/api/docs/models/gpt-5.6-sol) - primary limits, pricing, endpoints, and supported tools.
- Kept: [Codex models](https://developers.openai.com/codex/models) - first-party Codex model and effort recommendations.
- Kept: [Codex configuration reference](https://developers.openai.com/codex/config-reference) - authoritative accepted config keys and enums.
- Kept: [Reasoning models](https://developers.openai.com/api/docs/guides/reasoning) - effort, buffers, persisted/encrypted reasoning, and phase.
- Kept: [Migrate to Responses](https://developers.openai.com/api/docs/guides/migrate-to-responses) - endpoint, Item, state, tools, and streaming migration.
- Kept: [API deployment checklist](https://developers.openai.com/api/docs/guides/deployment-checklist) - verbosity, tools, compaction, caching, and transport.
- Kept: [Model release notes](https://help.openai.com/en/articles/9624314-model-release-notes) and [GPT-5.6 preview](https://openai.com/index/previewing-gpt-5-6-sol/) - official release chronology and staged-access caveat.
- Dropped: search-result snippets and third-party articles - claims were verified against fetched first-party pages instead.
- Dropped: GitHub issues in `openai/codex` - useful operational reports but not normative recommendations.

## Gaps and source integrity

- No first-party OpenAI documentation for Pi or its `openai-codex` adapter was found. Verify Pi's installed version/source before assuming Responses feature parity.
- The fetched preview announcement says access starts with selected partners, while current product docs describe broader availability. This is an apparent chronology/rollout discrepancy; check actual account access and rate cards.
- The release-notes page confirms the July 9 ChatGPT rollout but contains little API setup detail. The developer guides are the stronger source for configuration.
- Sol's limits are verified. Terra and Luna context/output limits were not independently verified from fetched model pages, so no numeric claim is made for them.
- The Codex reference's effort enum omits GPT-5.6 API's `none` and `max`; this is a genuine surface-specific discrepancy, not evidence that the API guide is fabricated.
- No inaccessible source was relied on. Search snippets were treated as unverified until first-party page fetches succeeded.
