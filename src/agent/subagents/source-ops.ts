import * as fs from "node:fs/promises";
import type { SourceKind } from "../../core/contracts.ts";
import { parsePageSpec, pdfPageTexts } from "./pdf-ops.ts";

/**
 * Source reading plumbing (learn-from-a-file, 2026-10-28): one info /
 * extract / search surface over the learner's stored upload, PDF (pages)
 * or text/markdown (lines). Shared by the digest loop and the prober's /
 * teacher's source_* tools, so both read the source the same way. Pure
 * functions — every failure is a returned string or a thrown Error the
 * caller turns into one (the web.ts law at the tool layer).
 *
 * PDF page texts and text-file lines are cached by path + mtime (the
 * live-turn tools would otherwise re-parse the whole file per call).
 */

/** Extract output ceiling — narrow the spec instead of dumping a book. */
export const SOURCE_EXTRACT_CAP = 24_000;
const SEARCH_HIT_CAP = 40;
/** A PDF whose mean text per page falls below this has no usable text layer. */
const MIN_MEAN_TEXT_PER_PAGE = 20;

const LINE_CACHE_MAX = 4;
const lineCache = new Map<string, { mtimeMs: number; lines: string[] }>();

async function readLines(filePath: string): Promise<string[]> {
	const { mtimeMs } = await fs.stat(filePath);
	const hit = lineCache.get(filePath);
	if (hit && hit.mtimeMs === mtimeMs) {
		lineCache.delete(filePath);
		lineCache.set(filePath, hit);
		return hit.lines;
	}
	const lines = (await fs.readFile(filePath, "utf8")).split(/\r?\n/);
	lineCache.delete(filePath);
	lineCache.set(filePath, { mtimeMs, lines });
	while (lineCache.size > LINE_CACHE_MAX) lineCache.delete(lineCache.keys().next().value!);
	return lines;
}

/** Drop a path's cached text lines (or all of them). */
export function evictLineCache(filePath?: string): void {
	if (filePath === undefined) lineCache.clear();
	else lineCache.delete(filePath);
}

/** Validate a range spec before parsePageSpec (which silently selects
 *  nothing on garbage): reversed ranges are swapped, anything that does
 *  not parse is an error string the agent can adapt to. */
export function normalizeRangeSpec(spec: string): { spec: string } | { error: string } {
	if (spec.trim().toLowerCase() === "all") return { spec: "all" };
	const parts: string[] = [];
	for (const raw of spec.split(",")) {
		const p = raw.trim();
		if (!p) continue;
		const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(p);
		if (!m) return { error: `ERROR: bad range "${p}" — use 'all', '1-5', '1,3,7' or '3'.` };
		if (m[2] === undefined) {
			parts.push(m[1]!);
			continue;
		}
		const a = parseInt(m[1]!, 10);
		const b = parseInt(m[2], 10);
		parts.push(`${Math.min(a, b)}-${Math.max(a, b)}`);
	}
	if (parts.length === 0) return { error: `ERROR: bad range "${spec}" — use 'all', '1-5', '1,3,7' or '3'.` };
	return { spec: parts.join(",") };
}

/** Sorted-unique numbers → merged range strings: [1,2,3,5] → ["1-3","5"]. */
export function mergeRanges(nums: Iterable<number>): string[] {
	const sorted = [...new Set(nums)].sort((a, b) => a - b);
	const out: string[] = [];
	let i = 0;
	while (i < sorted.length) {
		let j = i;
		while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
		out.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`);
		i = j + 1;
	}
	return out;
}

/** Cheap validity gate — the reason string when the source cannot be read
 *  (garbage PDF, empty file, no text layer), else null. */
export async function sourceUnreadable(kind: SourceKind, filePath: string): Promise<string | null> {
	try {
		const stat = await fs.stat(filePath);
		if (!stat.isFile()) return "not a regular file";
		if (stat.size === 0) return "the file is empty";
		if (kind === "pdf") {
			// pdfPageTexts throws pdfjs's precise error for a garbage file.
			const pages = await pdfPageTexts(filePath);
			const total = pages.reduce((a, t) => a + t.length, 0);
			if (pages.length === 0 || total / pages.length < MIN_MEAN_TEXT_PER_PAGE)
				return "the PDF has no readable text layer (scanned or image-only PDFs are not supported yet)";
		} else if (!(await readLines(filePath)).join("\n").trim()) {
			return "the file has no text";
		}
		return null;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

/** source_info: the triage readout (pages + text density, or lines + headings). */
export async function sourceInfoText(kind: SourceKind, filePath: string): Promise<string> {
	if (kind === "pdf") {
		const pages = await pdfPageTexts(filePath);
		return [`Pages: ${pages.length}`, ...pages.map((t, i) => `p${i + 1}: len=${t.length}`)].join("\n");
	}
	const lines = await readLines(filePath);
	const headings = lines
		.map((l, i) => ({ l, n: i + 1 }))
		.filter(({ l }) => /^#{1,6}\s/.test(l))
		.map(({ l, n }) => `L${n}: ${l.trim()}`);
	return [`Lines: ${lines.length}`, headings.length ? "Headings:" : "No markdown headings.", ...headings].join("\n");
}

/** source_extract: capped text of pages (pdf) or lines (text), spec-addressed.
 *  `units` = the pages / lines actually included before the cap cut in. */
export async function sourceExtractText(
	kind: SourceKind,
	filePath: string,
	spec: string,
): Promise<{ text: string; units: number[] }> {
	const normalized = normalizeRangeSpec(spec);
	if ("error" in normalized) return { text: normalized.error, units: [] };
	const all = kind === "pdf" ? await pdfPageTexts(filePath) : await readLines(filePath);
	const wanted = parsePageSpec(normalized.spec, all.length);
	if (wanted.length === 0)
		return { text: kind === "pdf" ? "No pages selected — page spec matched nothing." : "No lines selected — range matched nothing.", units: [] };
	const chunks: string[] = [];
	const units: number[] = [];
	let length = 0;
	for (const n of wanted) {
		const chunk = kind === "pdf" ? `--- Page ${n} ---\n${all[n - 1]}` : `L${n}: ${all[n - 1]}`;
		const added = (chunks.length > 0 ? 1 : 0) + chunk.length;
		units.push(n);
		chunks.push(chunk);
		length += added;
		if (length >= SOURCE_EXTRACT_CAP) break;
	}
	const text = chunks.join("\n");
	return text.length > SOURCE_EXTRACT_CAP || units.length < wanted.length
		? {
				text: `${text.slice(0, SOURCE_EXTRACT_CAP)}\n\n[Output truncated at ${SOURCE_EXTRACT_CAP} chars — narrow the range and extract in smaller batches.]`,
				units,
			}
		: { text, units };
}

/** source_search: literal case-insensitive hits with context. `units` =
 *  the pages (pdf) or lines (text) of the hits SHOWN (after the cap). */
export async function sourceSearchText(
	kind: SourceKind,
	filePath: string,
	query: string,
): Promise<{ body: string; units: number[] }> {
	const needle = query.toLowerCase();
	if (kind === "pdf") {
		const pages = await pdfPageTexts(filePath);
		const hits: string[] = [];
		const units: number[] = [];
		let total = 0;
		for (let p = 0; p < pages.length; p++) {
			const lines = pages[p]!.split("\n");
			for (let ln = 0; ln < lines.length; ln++) {
				if (!lines[ln]!.toLowerCase().includes(needle)) continue;
				total++;
				if (hits.length >= SEARCH_HIT_CAP) continue;
				hits.push(`=== Page ${p + 1}, line ${ln + 1} ===\n${contextOf(lines, ln)}`);
				units.push(p + 1);
			}
		}
		const body =
			hits.length === 0
				? "No hits."
				: hits.join("\n") + (total > hits.length ? `\n\n[${total - hits.length} more hits — narrow the query.]` : "");
		return { body, units: [...new Set(units)] };
	}
	const lines = await readLines(filePath);
	const hits: string[] = [];
	const units: number[] = [];
	for (let i = 0; i < lines.length && hits.length < SEARCH_HIT_CAP; i++) {
		if (!lines[i]!.toLowerCase().includes(needle)) continue;
		hits.push(`=== Line ${i + 1} ===\n${contextOf(lines, i)}`);
		units.push(i + 1);
	}
	return { body: hits.length === 0 ? "No hits." : hits.join("\n"), units };
}

/** Two lines either side, `>>>` marking the hit (pdfSearch's format). */
function contextOf(lines: string[], i: number): string {
	const start = Math.max(0, i - 2);
	const end = Math.min(lines.length, i + 3);
	return lines.slice(start, end).map((l, j) => `${start + j === i ? ">>>" : "   "} ${l}`).join("\n");
}
