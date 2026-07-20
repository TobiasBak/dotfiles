import { isDeepStrictEqual } from "node:util";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import {
	buildSessionContext,
	type CompactionEntry,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";

import {
	loadInternalCompactionModule,
	PI_COMPACTION_COMPATIBILITY,
	type CompactionResult,
} from "./compact-tool-loop/compat.ts";

const MARKER_TYPE = "compact-tool-loop.shadow-compaction";
const MARKER_VERSION = 1;
const SETTINGS = {
	enabled: true,
	reserveTokens: 32_000,
	keepRecentTokens: 20_000,
} as const;

interface ShadowMarkerData {
	version: typeof MARKER_VERSION;
	piVersion: typeof PI_COMPACTION_COMPATIBILITY.piVersion;
	compaction: CompactionResult;
}

interface ActiveMarker {
	entry: Extract<SessionEntry, { type: "custom" }>;
	data: ShadowMarkerData;
	index: number;
}

function isCompactionResult(value: unknown, precedingIds: Set<string>): value is CompactionResult {
	if (!value || typeof value !== "object") return false;
	const result = value as Partial<CompactionResult>;
	return (
		typeof result.summary === "string" &&
		result.summary.trim().length > 0 &&
		typeof result.firstKeptEntryId === "string" &&
		precedingIds.has(result.firstKeptEntryId) &&
		typeof result.tokensBefore === "number" &&
		Number.isFinite(result.tokensBefore) &&
		result.tokensBefore >= 0
	);
}

function getActiveMarker(branch: SessionEntry[]): ActiveMarker | undefined {
	const precedingIds = new Set<string>();
	let active: ActiveMarker | undefined;

	for (let index = 0; index < branch.length; index++) {
		const entry = branch[index];
		if (!entry) continue;

		if (entry.type === "compaction") {
			active = undefined;
		} else if (entry.type === "custom" && entry.customType === MARKER_TYPE) {
			const data = entry.data as Partial<ShadowMarkerData> | undefined;
			if (
				data?.version === MARKER_VERSION &&
				data.piVersion === PI_COMPACTION_COMPATIBILITY.piVersion &&
				isCompactionResult(data.compaction, precedingIds)
			) {
				active = { entry, data: data as ShadowMarkerData, index };
			}
		}
		precedingIds.add(entry.id);
	}

	return active;
}

function branchWithShadowCompaction(branch: SessionEntry[], marker: ActiveMarker): SessionEntry[] {
	return branch.map((entry, index) => {
		if (index !== marker.index) return structuredClone(entry);
		const result = structuredClone(marker.data.compaction);
		const synthetic: CompactionEntry = {
			type: "compaction",
			id: marker.entry.id,
			parentId: marker.entry.parentId,
			timestamp: marker.entry.timestamp,
			summary: result.summary,
			firstKeptEntryId: result.firstKeptEntryId,
			tokensBefore: result.tokensBefore,
			...(result.details !== undefined ? { details: result.details } : {}),
			fromHook: true,
		};
		return synthetic;
	});
}

function compactedMessages(branch: SessionEntry[], marker: ActiveMarker): AgentMessage[] {
	return buildSessionContext(branchWithShadowCompaction(branch, marker)).messages;
}

function hasProviderResponseAfter(branch: SessionEntry[], marker: ActiveMarker): boolean {
	return branch.slice(marker.index + 1).some((entry) => {
		if (entry.type !== "message" || entry.message.role !== "assistant") return false;
		return entry.message.stopReason !== "error" && entry.message.stopReason !== "aborted";
	});
}

function messagesWithoutRuntimeTimestamps(messages: AgentMessage[]): AgentMessage[] {
	return messages.map((message) => ({ ...message, timestamp: 0 })) as AgentMessage[];
}

function rawContextMatchesEvent(branch: SessionEntry[], eventMessages: AgentMessage[]): boolean {
	return isDeepStrictEqual(
		messagesWithoutRuntimeTimestamps(buildSessionContext(branch).messages),
		messagesWithoutRuntimeTimestamps(eventMessages),
	);
}

async function generateShadowCompaction(
	ctx: ExtensionContext,
	branch: SessionEntry[],
	marker: ActiveMarker | undefined,
	warnCompatibilityFailure: (reason: string) => void,
): Promise<CompactionResult | undefined> {
	const model = ctx.model;
	if (!model) return undefined;

	const compatibility = await loadInternalCompactionModule();
	if (!compatibility.ok) {
		warnCompatibilityFailure(compatibility.reason);
		return undefined;
	}
	const internal = compatibility.module;

	const preparationBranch = marker ? branchWithShadowCompaction(branch, marker) : branch.map((entry) => structuredClone(entry));
	const preparation = internal.prepareCompaction(preparationBranch, SETTINGS);
	if (!preparation) return undefined;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || ctx.signal?.aborted) return undefined;

	try {
		const result = await internal.compact(
			preparation,
			model,
			auth.apiKey,
			auth.headers,
			undefined,
			ctx.signal,
			undefined,
			streamSimple,
			auth.env,
		);
		if (ctx.signal?.aborted || !isCompactionResult(result, new Set(branch.map((entry) => entry.id)))) {
			return undefined;
		}
		return result;
	} catch (error) {
		if (!ctx.signal?.aborted && ctx.hasUI) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Shadow compaction failed: ${message}`, "warning");
		}
		return undefined;
	}
}

export default function compactToolLoop(pi: ExtensionAPI): void {
	let compatibilityWarningShown = false;
	const warnCompatibilityFailure = (ctx: ExtensionContext, reason: string): void => {
		if (compatibilityWarningShown || !ctx.hasUI) return;
		compatibilityWarningShown = true;
		ctx.ui.notify(
			`Shadow compaction is disabled: ${reason}. Update compact-tool-loop/compat.ts after verifying Pi's compaction internals.`,
			"warning",
		);
	};

	pi.on("context", async (event, ctx) => {
		const initialBranch = ctx.sessionManager.getBranch();
		if (!rawContextMatchesEvent(initialBranch, event.messages)) return;

		let marker = getActiveMarker(initialBranch);
		if (marker && !hasProviderResponseAfter(initialBranch, marker)) {
			return { messages: compactedMessages(initialBranch, marker) };
		}

		const usage = ctx.getContextUsage();
		if (
			usage?.tokens !== null &&
			usage?.tokens !== undefined &&
			usage.tokens > usage.contextWindow - SETTINGS.reserveTokens
		) {
			const leafId = ctx.sessionManager.getLeafId();
			const result = await generateShadowCompaction(
				ctx,
				initialBranch,
				marker,
				(reason) => warnCompatibilityFailure(ctx, reason),
			);
			if (result && ctx.sessionManager.getLeafId() === leafId) {
				const currentBranch = ctx.sessionManager.getBranch();
				if (rawContextMatchesEvent(currentBranch, event.messages)) {
					pi.appendEntry<ShadowMarkerData>(MARKER_TYPE, {
						version: MARKER_VERSION,
						piVersion: PI_COMPACTION_COMPATIBILITY.piVersion,
						compaction: result,
					});
					const markedBranch = ctx.sessionManager.getBranch();
					marker = getActiveMarker(markedBranch);
					if (marker) return { messages: compactedMessages(markedBranch, marker) };
				}
			}
		}

		if (marker) return { messages: compactedMessages(initialBranch, marker) };
	});

	pi.on("session_before_compact", (event) => {
		// A cached shadow summary did not use caller-supplied instructions.
		// Let Pi regenerate rather than silently ignoring an explicit request.
		if (event.customInstructions !== undefined) return;
		const marker = getActiveMarker(event.branchEntries);
		if (marker) return { compaction: structuredClone(marker.data.compaction) };
	});
}
