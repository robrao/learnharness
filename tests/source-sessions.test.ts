/**
 * LEARN-FROM-A-FILE (2026-10-28): an uploaded PDF / text file becomes the
 * source of a teaching session. Pins, all offline (scripted faux engines):
 *
 *   1. source-ops — page/line addressing, the text-layer gate
 *   2. the digest agent — outline written to outline.md, failure shapes
 *   3. the digest steer + failure semantics (contracts)
 *   4. POST /api/chats/[id]/source — names one uploaded attachment the
 *      teaching source (session start, teach, PDF/text only): the source
 *      marker as message[0], the digest job started; a refused digest
 *      fires NO turn; a finished digest delivers its steer, which wakes the
 *      first turn
 *   5. the marker's projection + session deletion cleanup
 *   6. the source can't be detached; the manifest tags it; no source_*
 *      agent tools (the attachment readers serve it)
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";

// ── the seam, BEFORE any config-loading import ──────────────────────────────
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-source-sessions-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.LH_AUTH_FILE = path.join(TMP_DATA, "auth.json");

const { sourceExtractText, sourceInfoText, sourceSearchText, sourceUnreadable, mergeRanges, normalizeRangeSpec } = await import("../src/agent/subagents/source-ops.ts");
const { parsePageSpec, pdfCacheStats, evictPdfCache } = await import("../src/agent/subagents/pdf-ops.ts");
const { runDigestAgent, digestFailure } = await import("../src/agent/subagents/digest.ts");
const { attachmentsPromptSection, attachmentTools } = await import("../src/agent/tools/attachments.ts");
const { buildSubagentSteer, isSubagentFailure } = await import("../src/core/contracts.ts");
const { toLlmMessages } = await import("../src/core/native-messages.ts");
const { projectView } = await import("../src/core/view.ts");
const { pdfModelOverride } = await import("../src/agent/subagents/runner.ts");
const { setTurnRunner, abortJob } = await import("../src/server/jobs.ts");
const { POST: SOURCE } = await import("../app/api/chats/[id]/source/route.ts");
const { PATCH } = await import("../app/api/chats/[id]/attachments/[attachmentId]/route.ts");
const { POST: RETRY } = await import("../app/api/chats/[id]/source/retry/route.ts");
const { addChatAttachment, sessionAttachments, sniffSource } = await import("../src/server/attachments.ts");
const { sessionSource, startJob } = await import("../src/server/chat-handler.ts");
const { createProberTools, createTeacherTools } = await import("../src/agent/tools.ts");
const { DIGEST_ABORTED_ERROR } = await import("../src/core/contracts.ts");
const { deleteChatSession } = await import("../src/server/chats.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { jobStore } = await import("../src/store/jobs.ts");
import type { PiEngine } from "../src/agent/models.ts";
import type { AttachmentRecord, DigestResult, DigestToolInput } from "../src/core/contracts.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

after(() => {
	setTurnRunner(async () => 200);
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const NOTES = ["# Limits", "A limit is the value a function approaches.", "", "# Derivatives", "A derivative is a limit of difference quotients.", "The power rule: d/dx x^n = n x^(n-1)."].join("\n");
const PDF_FIXTURE = path.join(import.meta.dirname, "fixtures", "sample-3page.pdf");
const NOT_A_PDF = path.join(import.meta.dirname, "fixtures", "not-a-pdf.txt");

function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

function tmpFile(name: string, text: string): string {
	const p = path.join(TMP_DATA, name);
	fs.writeFileSync(p, text);
	return p;
}

/** A fresh teach session holding one uploaded attachment (not yet the source). */
async function sessionWith(name: string, bytes: string | Uint8Array): Promise<{ id: string; attachment: AttachmentRecord }> {
	const chat = chatStore.createChat("Test: teaching source");
	const result = await addChatAttachment(chat.id, { name, bytes: typeof bytes === "string" ? Buffer.from(bytes) : bytes });
	assert.ok(result.ok, result.ok ? "" : result.error);
	return { id: chat.id, attachment: result.attachment };
}

function sourceRequest(id: string, body: unknown): Promise<Response> {
	return SOURCE(
		new Request(`http://localhost/api/chats/${id}/source`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
		{ params: Promise.resolve({ id }) },
	);
}

/** Upload one file and name it the teaching source — the start flow's two calls. */
async function startSource(name: string, bytes: string | Uint8Array, goal?: string): Promise<{ id: string; attachment: AttachmentRecord }> {
	const session = await sessionWith(name, bytes);
	const res = await sourceRequest(session.id, { attachmentId: session.attachment.id, ...(goal !== undefined ? { goal } : {}) });
	assert.equal(res.status, 200, await res.clone().text());
	return session;
}

function blobOf(attachment: AttachmentRecord): string {
	return path.join(TMP_DATA, "attachments", attachment.file);
}

async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
	const end = Date.now() + ms;
	while (!cond()) {
		if (Date.now() > end) throw new Error("waitFor timed out");
		await new Promise((r) => setTimeout(r, 25));
	}
}

describe("source-ops", () => {
	it("ranges: parsePageSpec lists, ranges, all, clamps; normalizeRangeSpec swaps reversed, rejects garbage", () => {
		assert.deepEqual(parsePageSpec("1-3,5", 10), [1, 2, 3, 5]);
		assert.deepEqual(parsePageSpec("all", 3), [1, 2, 3]);
		assert.deepEqual(parsePageSpec("8-20", 10), [8, 9, 10]);
		assert.deepEqual(normalizeRangeSpec("5-3, 7"), { spec: "3-5,7" });
		for (const bad of ["5-", "-3", "x", "nonsense", ""]) assert.ok("error" in normalizeRangeSpec(bad), bad);
	});

	it("bad ranges come back as ERROR strings; a reversed range reads forwards", async () => {
		const p = tmpFile("ranges.md", NOTES);
		for (const bad of ["5-", "-3", "x"]) assert.match((await sourceExtractText("text", p, bad)).text, /^ERROR: bad range/);
		const rev = await sourceExtractText("text", p, "5-3");
		assert.match(rev.text, /^L3: \nL4: # Derivatives\nL5:/);
		assert.deepEqual(rev.units, [3, 4, 5]);
	});

	it("mergeRanges: sorted-unique runs", () => {
		assert.deepEqual(mergeRanges([5, 1, 2, 3, 3, 9, 10]), ["1-3", "5", "9-10"]);
		assert.deepEqual(mergeRanges([]), []);
	});

	it("text: info lists headings with line numbers; extract addresses lines; search finds context", async () => {
		const p = tmpFile("notes.md", NOTES);
		const info = await sourceInfoText("text", p);
		assert.match(info, /Lines: 6/);
		assert.match(info, /L1: # Limits/);
		assert.match(info, /L4: # Derivatives/);
		const ex = await sourceExtractText("text", p, "4-5");
		assert.match(ex.text, /L4: # Derivatives\nL5: A derivative/);
		assert.deepEqual(ex.units, [4, 5]);
		assert.match((await sourceExtractText("text", p, "99")).text, /No lines selected/);
		const hit = await sourceSearchText("text", p, "power rule");
		assert.match(hit.body, /=== Line 6 ===/);
		assert.deepEqual(hit.units, [6]);
		assert.equal((await sourceSearchText("text", p, "zzz")).body, "No hits.");
	});

	it("text extract is capped", async () => {
		const p = tmpFile("long.txt", "x".repeat(60_000));
		assert.match((await sourceExtractText("text", p, "all")).text, /Output truncated at 24000 chars/);
	});

	it("pdf: info/extract/search read the text layer by page", async () => {
		assert.match(await sourceInfoText("pdf", PDF_FIXTURE), /Pages: 3/);
		const ex = await sourceExtractText("pdf", PDF_FIXTURE, "1");
		assert.match(ex.text, /--- Page 1 ---/);
		assert.deepEqual(ex.units, [1]);
		assert.ok((await sourceSearchText("pdf", PDF_FIXTURE, "integral")).units.length > 0);
	});

	it("pdf page texts are cached by path + mtime", async () => {
		const p = path.join(TMP_DATA, "cached.pdf");
		fs.copyFileSync(PDF_FIXTURE, p);
		evictPdfCache(p);
		const before = pdfCacheStats.opens;
		await sourceInfoText("pdf", p);
		await sourceInfoText("pdf", p);
		await sourceExtractText("pdf", p, "1");
		assert.equal(pdfCacheStats.opens - before, 1, "one parse serves every call");
		const later = new Date(Date.now() + 5000);
		fs.utimesSync(p, later, later);
		await sourceInfoText("pdf", p);
		assert.equal(pdfCacheStats.opens - before, 2, "an mtime change re-parses");
	});

	it("the readability gate: garbage PDF, empty file, blank text all refuse with a reason", async () => {
		assert.equal(await sourceUnreadable("pdf", PDF_FIXTURE), null);
		assert.equal(await sourceUnreadable("text", tmpFile("ok.txt", "hello")), null);
		assert.ok(await sourceUnreadable("pdf", NOT_A_PDF));
		assert.match((await sourceUnreadable("text", tmpFile("empty.txt", "")))!, /empty/);
		assert.match((await sourceUnreadable("text", tmpFile("blank.txt", "  \n ")))!, /no text/);
		assert.match((await sourceUnreadable("text", path.join(TMP_DATA, "missing.txt")))!, /ENOENT|no such file/i);
	});
});

describe("digest agent", () => {
	function input(sourcePath: string, sourceKind: "pdf" | "text", name: string): DigestToolInput {
		return { path: sourcePath, sourceKind, name, outlinePath: path.join(TMP_DATA, `outline-${name}.md`), goal: "understand derivatives" };
	}

	it("reads the source, then writes the outline to outlinePath", async () => {
		const p = tmpFile("calc.md", NOTES);
		const i = input(p, "text", "calc.md");
		const outline = "# Calculus\nLimits then derivatives.\n\n## Derivatives (## Derivatives)\n- **Power rule** — d/dx x^n = n x^(n-1) (L6)";
		const result = await runDigestAgent(i, {
			engine: fauxEngine([
				fauxAssistantMessage([fauxToolCall("source_info", {}, { id: "i1" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxToolCall("source_extract", { range: "1-6" }, { id: "e1" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxText(outline)]),
			]),
		});
		assert.equal(isSubagentFailure("digest", result), false);
		assert.equal(result.outline, outline);
		assert.equal(fs.readFileSync(i.outlinePath, "utf8"), `${outline}\n`);
		assert.equal(result.goal, "understand derivatives");
		assert.deepEqual(result.consulted, ["1-6"], "source_info adds nothing; the extract's lines do");
	});

	it("consulted: extracted units + the search hits shown, merged", async () => {
		const p = tmpFile("calc3.md", NOTES);
		const result = await runDigestAgent(input(p, "text", "calc3.md"), {
			engine: fauxEngine([
				fauxAssistantMessage([fauxToolCall("source_extract", { range: "1-3" }, { id: "e1" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxToolCall("source_search", { query: "power rule" }, { id: "s1" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxText("# Outline")]),
			]),
		});
		assert.deepEqual(result.consulted, ["1-3", "6"]);
	});

	it("an outline claimed without reading gets one nudge, then reads", async () => {
		const p = tmpFile("calc2.md", NOTES);
		const i = input(p, "text", "calc2.md");
		const result = await runDigestAgent(i, {
			engine: fauxEngine([
				fauxAssistantMessage([fauxText("# Made up")]),
				fauxAssistantMessage([fauxToolCall("source_extract", { range: "all" }, { id: "e1" })], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxText("# Real outline")]),
			]),
		});
		assert.equal(result.outline, "# Real outline");
	});

	it("an unreadable source fails upfront — no model call", async () => {
		const result = await runDigestAgent(input(NOT_A_PDF, "pdf", "bad.pdf"), { engine: fauxEngine([]) });
		assert.match(result.outline, /^Digest failed:/);
		assert.equal(isSubagentFailure("digest", result), true);
		assert.equal(result.permanent, true, "a readability failure is permanent");
	});

	it("a model failure is NOT permanent", () => {
		const r = digestFailure(undefined, "the model call failed");
		assert.equal(r.permanent, undefined);
		assert.deepEqual(r.consulted, []);
	});
});

describe("digest steer", () => {
	const result: DigestResult = {
		path: "/data/sources/c1/source.pdf",
		name: "Calc.pdf",
		sourceKind: "pdf",
		outlinePath: "/data/sources/c1/outline.md",
		outline: "# Calc\n- **Limit** — ... (p. 3)",
		goal: "pass the exam",
		consulted: ["1-5"],
	};

	it("success: the steer is the first prober input — goal, paths, tools, outline", () => {
		const steer = buildSubagentSteer({ id: "job_1", kind: "digest", toolCallId: "digest_c1" }, result);
		assert.match(steer.content, /^\[Session source\] — the learner attached "Calc\.pdf"/);
		assert.match(steer.content, /His goal: pass the exam/);
		assert.ok(!steer.content.includes(result.path), "the stored source path never reaches the model");
		assert.match(steer.content, /\/data\/sources\/c1\/outline\.md/);
		assert.match(steer.content, /source_\* tools/);
		assert.ok(steer.content.endsWith(result.outline));
	});

	it("no goal: the prober is told to ask for it", () => {
		const steer = buildSubagentSteer({ id: "job_1", kind: "digest", toolCallId: "t" }, { ...result, goal: undefined });
		assert.match(steer.content, /He gave no goal/);
	});
});

describe("POST /api/chats/[id]/source", () => {
	it("refuses: bad body, unknown chat, a started session, a second source, practice, a non-PDF/text or unknown/removed attachment", async () => {
		const { id, attachment } = await sessionWith("calc.md", NOTES);
		assert.equal((await sourceRequest(id, {})).status, 400);
		assert.equal((await sourceRequest(id, { attachmentId: attachment.id, goal: 7 })).status, 400);
		assert.equal((await sourceRequest("no_such_chat", { attachmentId: attachment.id })).status, 404);
		const image = await addChatAttachment(id, { name: "d.png", bytes: Buffer.from("png-ish") });
		assert.ok(image.ok);
		const wrongKind = await sourceRequest(id, { attachmentId: image.attachment.id });
		assert.equal(wrongKind.status, 400);
		assert.match(((await wrongKind.json()) as { error: string }).error, /Only a PDF, \.txt or \.md file/);
		assert.equal((await sourceRequest(id, { attachmentId: "att_nope" })).status, 400);
		chatStore.setAttachmentDetached(id, attachment.id, true);
		assert.equal((await sourceRequest(id, { attachmentId: attachment.id })).status, 400, "a removed attachment can't be the source");
		chatStore.setAttachmentDetached(id, attachment.id, false);

		const practice = chatStore.createChat("Test: practice", "practice");
		const p = await addChatAttachment(practice.id, { name: "p.md", bytes: Buffer.from(NOTES) });
		assert.ok(p.ok);
		assert.equal((await sourceRequest(practice.id, { attachmentId: p.attachment.id })).status, 400);

		const started = await sessionWith("late.md", NOTES);
		chatStore.saveMessages(started.id, [{ role: "user", content: "hi", timestamp: 0 } as never]);
		assert.equal((await sourceRequest(started.id, { attachmentId: started.attachment.id })).status, 409, "only at session start");

		const twice = await startSource("once.md", NOTES);
		await waitFor(() => jobStore.listJobs(twice.id)[0]?.status !== "running");
		chatStore.saveMessages(twice.id, []);
		assert.equal((await sourceRequest(twice.id, { attachmentId: twice.attachment.id })).status, 409, "one source per session");
		assert.equal(chatStore.getChat(id)!.teachingSourceId, undefined, "a refusal records nothing");
	});

	it("a refused digest (no models configured): the source marker exists, the job errors, NO turn fires", async () => {
		const wakes: string[] = [];
		setTurnRunner(async (chatId) => {
			wakes.push(chatId);
			return 200;
		});
		const { id, attachment } = await startSource("calc.md", NOTES, "learn derivatives");

		const chat = chatStore.getChat(id)!;
		assert.equal(chat.teachingSourceId, attachment.id);
		assert.equal(chat.messages.length, 1);
		const marker = chat.messages[0] as unknown as { customType: string; content: string; details: { name: string; goal?: string; sourceKind: string; toolCallId: string } };
		assert.equal(marker.customType, "source-attached");
		assert.equal(marker.details.name, "calc.md");
		assert.equal(marker.details.goal, "learn derivatives");
		assert.equal(marker.details.sourceKind, "text");
		assert.ok(!marker.content.includes(attachment.file), "no stored path in the marker");

		await waitFor(() => jobStore.listJobs(id)[0]?.status === "error");
		const job = jobStore.listJobs(id)[0]!;
		assert.equal(job.kind, "digest");
		assert.equal(job.toolCallId, marker.details.toolCallId);
		assert.equal((job.input as { path: string }).path, blobOf(attachment), "the digest reads the attachment's blob");
		assert.match(job.error ?? "", /model/i);
		await new Promise((r) => setTimeout(r, 150));
		assert.equal(job.delivery, undefined, "a failed digest owes the session nothing");
		assert.deepEqual(wakes, [], "no prober turn without an outline");
		assert.equal(chatStore.getChat(id)!.messages.length, 1);
	});

	it("a finished digest: outline.md written, the steer persists after the marker and wakes the first turn", async () => {
		const wakes: { chatId: string; steers: LhMessage[] }[] = [];
		setTurnRunner(async (chatId, input) => {
			if (input.type !== "steers") return 200;
			wakes.push({ chatId, steers: input.steers as unknown as LhMessage[] });
			const record = chatStore.getChat(chatId)!;
			chatStore.saveMessages(chatId, [...record.messages, ...(input.steers as unknown as LhMessage[])]);
			return 200;
		});
		pdfModelOverride.current = fauxEngine([
			fauxAssistantMessage([fauxToolCall("source_extract", { range: "all" }, { id: "e1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("# Calc\n## Derivatives\n- **Power rule** — d/dx x^n = n x^(n-1) (L6)")]),
		]);
		try {
			const { id, attachment } = await startSource("calc.md", NOTES, "learn derivatives");
			await waitFor(() => wakes.some((w) => w.chatId === id));
			const job = jobStore.listJobs(id)[0]!;
			assert.equal(job.status, "done");
			assert.match(fs.readFileSync(path.join(TMP_DATA, "sources", id, "outline.md"), "utf8"), /Power rule/);

			const messages = chatStore.getChat(id)!.messages as unknown as { customType?: string; content: string }[];
			assert.deepEqual(messages.map((m) => m.customType), ["source-attached", "subagent-steer"]);
			assert.match(messages[1]!.content, /His goal: learn derivatives/);
			assert.match(messages[1]!.content, /Power rule/);

			// What the first prober turn reads: the steer only — the marker is UI-only.
			const wire = toLlmMessages(chatStore.getChat(id)!.messages as never);
			assert.deepEqual(wire.map((m) => m.role), ["user"]);
			assert.ok(!JSON.stringify(wire).includes(attachment.file), "no stored source path on the wire");
			assert.deepEqual((job.result as DigestResult).consulted, ["1-6"]);

			// And the transcript: a source card, then the outline badge.
			const view = projectView(chatStore.getChat(id)!.messages as never);
			assert.equal((view[0]!.parts[0] as { type: string }).type, "data-source");
			assert.equal((view[1]!.parts.find((p) => p.type === "data-subagent-artifact")?.data as { kind: string }).kind, "digest");

			// sessionSource: the digested source, with its outline.
			const source = sessionSource(id)!;
			assert.equal(source.attachment.record.id, attachment.id);
			assert.equal(source.outlinePath, path.join(TMP_DATA, "sources", id, "outline.md"));
		} finally {
			pdfModelOverride.current = undefined;
		}
	});

	it("session deletion removes the outline dir; a blob another session shares stays", async () => {
		const { id, attachment } = await startSource("gone.txt", "to be deleted");
		const other = await sessionWith("same.txt", "to be deleted");
		assert.equal(other.attachment.file, attachment.file, "same bytes, one blob");
		await waitFor(() => jobStore.listJobs(id)[0]?.status !== "running");
		assert.ok(fs.existsSync(path.join(TMP_DATA, "sources", id)));
		assert.equal((await deleteChatSession(id, "preserve-graph")).ok, true);
		assert.equal(fs.existsSync(path.join(TMP_DATA, "sources", id)), false);
		assert.ok(fs.existsSync(blobOf(attachment)), "the other session still holds the file");
		assert.equal((await deleteChatSession(other.id, "preserve-graph")).ok, true);
		assert.equal(fs.existsSync(blobOf(attachment)), false);
	});
});

describe("the teaching source among the session's attachments", () => {
	it("can't be detached; a context attachment can", async () => {
		const { id, attachment } = await startSource("keep.md", NOTES);
		const context = await addChatAttachment(id, { name: "extra.md", bytes: Buffer.from("# Extra") });
		assert.ok(context.ok);
		const patch = (attachmentId: string, detached: boolean) =>
			PATCH(
				new Request(`http://localhost/api/chats/${id}/attachments/${attachmentId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ detached }) }),
				{ params: Promise.resolve({ id, attachmentId }) },
			);
		const refused = await patch(attachment.id, true);
		assert.equal(refused.status, 409);
		assert.match(((await refused.json()) as { error: string }).error, /can't be removed/);
		assert.equal(chatStore.getChat(id)!.attachments!.find((a) => a.id === attachment.id)!.detachedAt, undefined);
		assert.equal((await patch(context.attachment.id, true)).status, 200);
	});

	it("the manifest tags only the source; its readers are the attachment tools, never source_*", async () => {
		const { id, attachment } = await startSource("tagged.md", NOTES);
		const context = await addChatAttachment(id, { name: "context.md", bytes: Buffer.from("# Context") });
		assert.ok(context.ok);
		const attachments = sessionAttachments(chatStore.getChat(id)!);
		const section = attachmentsPromptSection(attachments);
		assert.match(section, new RegExp(`- tagged\\.md — .* — path: ${blobOf(attachment).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} — TEACHING SOURCE`));
		assert.doesNotMatch(section, /context\.md — .*TEACHING SOURCE/);
		assert.deepEqual(Object.keys(attachmentTools(attachments)).sort(), ["text_extract", "text_info", "text_search"]);

		const jobsCtx = { jobStore, spawn: () => {} };
		const prober = createProberTools({ chatId: id, chatStore, deliver: () => {}, ...jobsCtx } as never);
		const teacher = createTeacherTools({ chatId: id, chatStore, ...jobsCtx } as never);
		for (const tools of [prober, teacher]) assert.deepEqual(Object.keys(tools).filter((n) => n.startsWith("source_")), []);
	});

	it("sessionSource: undefined with no source, or until the digest finishes", async () => {
		const plain = await sessionWith("plain.md", NOTES);
		assert.equal(sessionSource(plain.id), undefined);
		const { id } = await startSource("failing.md", NOTES);
		await waitFor(() => jobStore.listJobs(id)[0]?.status === "error");
		assert.equal(sessionSource(id), undefined, "a failed digest yields no source");
	});
});

// ── hardening (docs/specs/learn-from-source-file-hardening.md) ──────────────

/** An engine whose stream waits for the abort — a digest that never ends on its own. */
function hangingEngine(): PiEngine {
	const faux = createFauxCore({});
	return {
		model: faux.getModel(),
		streamFn: ((_m: unknown, _c: unknown, opts: { signal?: AbortSignal }) => ({
			async *[Symbol.asyncIterator]() {
				await new Promise<void>((resolve) => {
					if (opts.signal?.aborted) return resolve();
					opts.signal?.addEventListener("abort", () => resolve());
				});
				yield { type: "error", reason: "aborted", error: { errorMessage: "aborted" } };
			},
		})) as never,
	};
}

function retryRequest(id: string) {
	return RETRY(new Request(`http://localhost/api/chats/${id}/source/retry`, { method: "POST" }), { params: Promise.resolve({ id }) });
}

describe("upload content sniffing", () => {
	it("sniffSource: PDF header; text NUL bytes and the 1% U+FFFD bound", () => {
		assert.equal(sniffSource("pdf", Buffer.from("%PDF-1.7 ...")), null);
		assert.match(sniffSource("pdf", Buffer.from("hello"))!, /PDF/);
		assert.equal(sniffSource("text", Buffer.from("plain notes")), null);
		assert.match(sniffSource("text", Buffer.from([0x68, 0x00, 0x69]))!, /text file/);
		// A multibyte char split at the 8 KB boundary is not binary evidence.
		const split = Buffer.concat([Buffer.from("a".repeat(8191)), Buffer.from("é")]);
		assert.equal(sniffSource("text", split), null);
		// 2% invalid bytes fail; 0.5% pass.
		const mixed = (badEvery: number) => Buffer.from(Array.from({ length: 4000 }, (_, i) => (i % badEvery === 0 ? 0xff : 0x61)));
		assert.ok(sniffSource("text", mixed(50)));
		assert.equal(sniffSource("text", mixed(200)), null);
	});
});

describe("setting the source is all or nothing", () => {
	it("a failure after the source is named rolls it back and answers a JSON 500; the session and its file stay", async () => {
		const { id, attachment } = await sessionWith("doomed.md", NOTES);
		const original = chatStore.saveMessages.bind(chatStore);
		chatStore.saveMessages = () => {
			throw new Error("disk full");
		};
		try {
			const res = await sourceRequest(id, { attachmentId: attachment.id });
			assert.equal(res.status, 500);
			assert.match(((await res.json()) as { error: string }).error, /couldn't be set/);
		} finally {
			chatStore.saveMessages = original;
		}
		const chat = chatStore.getChat(id)!;
		assert.equal(chat.teachingSourceId, undefined);
		assert.deepEqual(chat.attachments!.map((a) => a.id), [attachment.id], "the upload stays for the retry");
		assert.deepEqual(jobStore.listJobs(id), []);
		assert.equal(fs.existsSync(path.join(TMP_DATA, "sources", id)), false);
		assert.equal((await sourceRequest(id, { attachmentId: attachment.id })).status, 200, "the retry succeeds");
	});
});

describe("digest abort, retry, recovery", () => {
	it("an aborted digest delivers nothing and fires no turn", async () => {
		const wakes: string[] = [];
		setTurnRunner(async (chatId) => {
			wakes.push(chatId);
			return 200;
		});
		pdfModelOverride.current = hangingEngine();
		try {
			const { id } = await startSource("slow.md", NOTES);
			await waitFor(() => (jobStore.listJobs(id)[0]?.activity ?? "queued") !== "queued");
			const jobId = jobStore.listJobs(id)[0]!.id;
			assert.deepEqual(abortJob(jobId), { ok: true });
			await new Promise((r) => setTimeout(r, 200));
			const job = jobStore.getJob(jobId)!;
			assert.equal(job.status, "error");
			assert.equal(job.error, DIGEST_ABORTED_ERROR);
			assert.equal(job.delivery, undefined);
			assert.deepEqual(wakes, []);
			assert.equal(chatStore.getChat(id)!.messages.length, 1);
			assert.equal(fs.existsSync(path.join(TMP_DATA, "sources", id, "outline.md")), false);
		} finally {
			pdfModelOverride.current = undefined;
		}
	});

	it("retry: re-runs a failed digest under a new toolCallId and wakes the first turn", async () => {
		const wakes: string[] = [];
		setTurnRunner(async (chatId) => {
			wakes.push(chatId);
			return 200;
		});
		// No models configured → the first digest is refused (not permanent).
		const { id } = await startSource("again.md", NOTES);
		await waitFor(() => jobStore.listJobs(id)[0]?.status === "error");
		const firstCall = (chatStore.getChat(id)!.messages[0] as unknown as { details: { toolCallId: string } }).details.toolCallId;

		pdfModelOverride.current = fauxEngine([
			fauxAssistantMessage([fauxToolCall("source_extract", { range: "all" }, { id: "e1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("# Retried outline")]),
		]);
		try {
			const res = await retryRequest(id);
			assert.equal(res.status, 200);
			const marker = chatStore.getChat(id)!.messages[0] as unknown as { details: { toolCallId: string; jobId: string } };
			assert.notEqual(marker.details.toolCallId, firstCall);
			await waitFor(() => wakes.includes(id));
			assert.equal(jobStore.getJob(marker.details.jobId)!.status, "done");
			assert.equal((await retryRequest(id)).status, 409, "done: nothing to retry");
		} finally {
			pdfModelOverride.current = undefined;
		}
	});

	it("retry refuses: running (409), permanent (400), file gone (410), unknown chat (404)", async () => {
		assert.equal((await retryRequest("no_such_chat")).status, 404);

		pdfModelOverride.current = hangingEngine();
		try {
			const { id } = await startSource("busy.md", NOTES);
			assert.equal((await retryRequest(id)).status, 409);
			abortJob(jobStore.listJobs(id)[0]!.id);
		} finally {
			pdfModelOverride.current = undefined;
		}

		pdfModelOverride.current = fauxEngine([]);
		try {
			// Upload refuses a PDF that doesn't open, so a blank text file is the
			// readability-gate failure that reaches the digest.
			const { id } = await startSource("blank.md", "   \n  \n");
			await waitFor(() => jobStore.listJobs(id)[0]?.status === "error");
			assert.equal((jobStore.listJobs(id)[0]!.result as DigestResult).permanent, true);
			assert.equal((await retryRequest(id)).status, 400);
		} finally {
			pdfModelOverride.current = undefined;
		}

		const { id, attachment } = await startSource("vanish.md", "only in this session");
		await waitFor(() => jobStore.listJobs(id)[0]?.status === "error");
		fs.rmSync(blobOf(attachment));
		assert.equal((await retryRequest(id)).status, 410);
	});

	it("restart recovery: a digest job runs from its saved input alone", async () => {
		const wakes: string[] = [];
		setTurnRunner(async (chatId) => {
			wakes.push(chatId);
			return 200;
		});
		const chat = chatStore.createChat("recovery");
		const dir = path.join(TMP_DATA, "sources", chat.id);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "source.md"), NOTES);
		const job = jobStore.createJob({
			kind: "digest",
			chatId: chat.id,
			toolCallId: `digest_${chat.id}`,
			activity: "queued",
			input: { path: path.join(dir, "source.md"), sourceKind: "text", name: "n.md", outlinePath: path.join(dir, "outline.md") },
		});
		pdfModelOverride.current = fauxEngine([
			fauxAssistantMessage([fauxToolCall("source_extract", { range: "1-2" }, { id: "e1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("# Recovered")]),
		]);
		try {
			startJob(job.id); // no input passed — the respawn shape
			await waitFor(() => jobStore.getJob(job.id)!.status !== "running");
			assert.equal(jobStore.getJob(job.id)!.status, "done");
			assert.equal(fs.readFileSync(path.join(dir, "outline.md"), "utf8"), "# Recovered\n");
		} finally {
			pdfModelOverride.current = undefined;
		}
	});
});
