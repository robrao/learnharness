import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Message, ToolResultMessage, Usage, Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { piEngineFor, type PiEngine } from "../models.ts";
import { providerEventObserver } from "../provider-events.ts";
import type { DigestResult, DigestToolInput } from "../../core/contracts.ts";
import { streamOnce } from "./pdf-reader.ts";
import { mergeRanges, sourceExtractText, sourceInfoText, sourceSearchText, sourceUnreadable } from "./source-ops.ts";

/**
 * The source digest sub-agent (learn-from-a-file, 2026-10-28): reads the
 * learner's uploaded PDF / text file once and writes a chapters → core
 * concepts outline the prober and teacher then work from. A hand-rolled
 * loop like the pdf-reader's, TEXT ONLY (v1 has no vision fallback — a
 * scanned PDF fails the upfront text-layer gate). Its final message IS the
 * outline; the runner-side wrapper writes it to outlinePath.
 */

const INSTRUCTIONS = `You are a source digester inside a learning application. A learner uploaded a document to learn from. Read it and produce an OUTLINE that a teacher agent will use to (1) probe what the learner already understands and (2) build the chain of propositions the learner needs in order to fully understand the source.

You operate in an isolated context: the task gives you the file's kind and the learner's goal (if any).

Reading doctrine:
1. TRIAGE FIRST: call source_info (page count + text per page for a PDF; line count + headings for a text file).
2. Find the document's structure. Read the table of contents and chapter openings; for a long document, source_search for "Chapter", "Contents" and section titles. Never read a long document front-to-back — sample each chapter's opening and its summary or key-terms section, and extract the pages of the densest definitions.
3. For each chapter, identify its CORE CONCEPTS: the ideas a reader must hold to understand it. State each as a short declarative proposition (what is true), not a topic label.

Your FINAL assistant message is your entire deliverable — a markdown outline, in this format, nothing before or after it:

# <document title>
<one or two sentences: what the document teaches, and for whom>

## <Chapter or major section title> (<citation>)
- **<concept name>** — <one-line statement of the concept as a proposition> (<citation>)
- ...

Citations: PDF → page numbers, "p. 12" or "pp. 12-18". Text file → the nearest markdown heading ("## Limits"), or a line range ("L120-180") when there are no headings. Cite only what you actually read. If the learner stated a goal, put the chapters relevant to it first and mark the rest "(outside stated goal)". If the document is too thin to yield an outline, say so plainly instead of inventing one.

Tool outputs may be error strings. Adapt: narrow the range, change the query.`;

const MAX_ITERATIONS = 40;

export interface DigestOptions {
	engine?: PiEngine;
	abortSignal?: AbortSignal;
	onUsage?: (usage: Usage) => void;
	onActivity?: (line: string) => void;
	maxIterations?: number;
	/** Debug: raw provider-event recording key (LH_PROVIDER_EVENTS=1). */
	chatId?: string;
}

function declarations(kind: DigestToolInput["sourceKind"]): Tool[] {
	const unit = kind === "pdf" ? "pages" : "lines";
	return [
		{
			name: "source_info",
			description: `Triage the source: ${kind === "pdf" ? "page count and text length per page" : "line count and markdown headings with line numbers"}. ALWAYS call this first.`,
			parameters: Type.Object({}),
		},
		{
			name: "source_extract",
			description: `Extract the source's text for ${unit} (spec: 'all', '1-5', '1,3,7', '3'). Output is capped — narrow the spec.`,
			parameters: Type.Object({ range: Type.String({ description: `${unit} spec, e.g. '1-5' or '1,3,7'` }) }),
		},
		{
			name: "source_search",
			description: "Search the source's text for a literal phrase (case-insensitive); returns hits with context.",
			parameters: Type.Object({ query: Type.String({ description: "Literal text to find" }) }),
		},
	];
}

function toolText(toolCallId: string, toolName: string, value: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: value }],
		isError: value.startsWith("ERROR:"),
		timestamp: Date.now(),
	};
}

const UNREAD_FINISH_MESSAGE =
	"You finished without reading any of the source — an outline from nothing is invention. Extract the relevant parts first, then write the outline from what you actually read.";

/** The digest's failure shape — every failure site (this loop and the
 *  runner) builds it here, from whatever input it has. `permanent` marks
 *  readability-gate failures: retrying cannot help. */
export function digestFailure(
	input: Partial<DigestToolInput> | undefined,
	reason: string,
	opts: { permanent?: boolean } = {},
): DigestResult {
	return {
		path: input?.path ?? "",
		name: input?.name ?? "",
		sourceKind: input?.sourceKind ?? "text",
		outlinePath: input?.outlinePath ?? "",
		outline: `Digest failed: ${reason}`,
		...(input?.goal ? { goal: input.goal } : {}),
		consulted: [],
		...(opts.permanent ? { permanent: true as const } : {}),
	};
}

export async function runDigestAgent(input: DigestToolInput, opts: DigestOptions = {}): Promise<DigestResult> {
	const maxIterations = opts.maxIterations ?? MAX_ITERATIONS;
	// Deterministic upfront gate: unreadable / no text layer — never start
	// a model loop on a source it cannot read.
	opts.onActivity?.("checking source");
	const unreadable = await sourceUnreadable(input.sourceKind, input.path);
	if (unreadable) return digestFailure(input, unreadable, { permanent: true });

	const toolDeclarations = declarations(input.sourceKind);
	const engine = opts.engine ?? piEngineFor("pdfReader");
	const reasoning = engine.level;
	const sessionId = randomUUID();
	const prompt = [
		`Source: "${input.name}" (${input.sourceKind === "pdf" ? "PDF" : "text file"})`,
		`Learner's goal: ${input.goal || "(none stated)"}`,
		"",
		"Read the source per your doctrine, then produce the outline in the required format.",
	].join("\n");

	let messages: Message[] = [{ role: "user", content: prompt, timestamp: Date.now() }];
	// `consulted` = made a read call (the nudge's test — an extract that
	// matched nothing still counts); `units` = what was actually read.
	let consulted = false;
	const units = new Set<number>();
	let nudged = false;
	let finalText = "";

	try {
		for (let iteration = 0; iteration < maxIterations; iteration++) {
			const result = await streamOnce(
				engine,
				INSTRUCTIONS,
				messages,
				toolDeclarations,
				sessionId,
				reasoning,
				opts.abortSignal,
				opts.chatId ? providerEventObserver(opts.chatId, "job:digest") : undefined,
			);
			opts.onUsage?.(result.usage);
			messages = [...messages, result];

			const toolCalls = result.content.filter(
				(c): c is Extract<typeof c, { type: "toolCall" }> => c.type === "toolCall",
			);
			if (toolCalls.length === 0) {
				finalText = result.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("")
					.trim();
				if (!consulted && !nudged) {
					nudged = true;
					messages = [...messages, { role: "user", content: UNREAD_FINISH_MESSAGE, timestamp: Date.now() }];
					continue;
				}
				if (!finalText) return digestFailure(input, "the digest produced no outline");
				return finish(input, finalText, units, opts.abortSignal);
			}

			const toolResults: ToolResultMessage[] = [];
			for (const call of toolCalls) {
				const args = (call.arguments ?? {}) as Record<string, unknown>;
				try {
					if (call.name === "source_info") {
						opts.onActivity?.("source_info: triaging");
						toolResults.push(toolText(call.id, call.name, await sourceInfoText(input.sourceKind, input.path)));
					} else if (call.name === "source_extract") {
						const range = String(args.range ?? "all");
						opts.onActivity?.(`source_extract: ${range}`);
						const extract = await sourceExtractText(input.sourceKind, input.path, range);
						for (const n of extract.units) units.add(n);
						toolResults.push(toolText(call.id, call.name, extract.text));
						consulted = true;
					} else if (call.name === "source_search") {
						const query = String(args.query ?? "");
						opts.onActivity?.(`source_search: "${query}"`);
						const search = await sourceSearchText(input.sourceKind, input.path, query);
						for (const n of search.units) units.add(n);
						toolResults.push(toolText(call.id, call.name, search.body));
						consulted = true;
					} else {
						toolResults.push(toolText(call.id, call.name, `ERROR: unknown tool "${call.name}"`));
					}
				} catch (err) {
					toolResults.push(toolText(call.id, call.name, `ERROR: ${err instanceof Error ? err.message : String(err)}`));
				}
			}
			messages = [...messages, ...toolResults];
		}
	} catch (err) {
		if (opts.abortSignal?.aborted) throw err;
		return digestFailure(input, `the digest crashed — ${err instanceof Error ? err.message : String(err)}`);
	}
	return finalText
		? finish(input, finalText, units, opts.abortSignal)
		: digestFailure(input, `iteration limit (${maxIterations}) reached without an outline`);
}

/** Persist the outline (the durable copy — compaction can't touch it).
 *  Never after an abort: the session may already be deleted, and the
 *  mkdir would resurrect its source dir. */
async function finish(
	input: DigestToolInput,
	outline: string,
	units: Set<number>,
	abortSignal?: AbortSignal,
): Promise<DigestResult> {
	if (abortSignal?.aborted) {
		const err = new Error("aborted");
		err.name = "AbortError";
		throw err;
	}
	await fs.mkdir(path.dirname(input.outlinePath), { recursive: true });
	await fs.writeFile(input.outlinePath, `${outline}\n`, "utf8");
	return {
		path: input.path,
		name: input.name,
		sourceKind: input.sourceKind,
		outlinePath: input.outlinePath,
		outline,
		...(input.goal ? { goal: input.goal } : {}),
		consulted: mergeRanges(units),
	};
}
