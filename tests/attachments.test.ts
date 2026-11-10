/**
 * Session files (teaching-source spec rev 2) — the server path end to end
 * with zero tokens: files go through the real upload route while the
 * session is starting, the learner's message goes through
 * handleChatRequest, and a scripted pi engine plays the model — recording
 * the system prompt, tool registry and messages it was given, and calling
 * the attachment readers like a real model would.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep, type SystemMessage } from "@earendil-works/pi-ai";
import type { AttachmentRecord } from "../src/core/contracts.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { makeEpub } from "./fixtures/make-epub.ts";

// Hermetic: LH_DATA_DIR → a temp dir, set BEFORE the first app-module import
// (the seam is env-at-module-load), so every app-module import is dynamic.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-attachments-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { deleteChatSession } = await import("../src/server/chats.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { attachmentDirOf } = await import("../src/store/attachments.ts");
const { newCompactionMarker } = await import("../src/core/compaction.ts");
const attachmentsRoute = await import("../app/api/chats/[id]/attachments/route.ts");

process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const PDF = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "sample-3page.pdf"));

interface Seen {
	systemPrompt: string;
	tools: string[];
	messages: Array<{ role: string; content: unknown }>;
}

/** Scripted model: each step sees the request context and returns a reply. */
function scripted(steps: ((seen: Seen) => ReturnType<typeof fauxAssistantMessage>)[]) {
	const seen: Seen[] = [];
	const faux = createFauxCore({});
	faux.setResponses(
		steps.map((step): FauxResponseStep => (context) => {
			// The agent declares its prompt and loadout in leading system messages.
			const system = context.messages.filter((m): m is SystemMessage => m.role === "system");
			const s: Seen = {
				systemPrompt: system
					.flatMap((m) => [typeof m.content === "string" ? m.content : m.content.map((c) => c.text).join(""), ...Object.values(m.sections ?? {})])
					.join("\n"),
				tools: system.flatMap((m) => (m.toolsAdded ?? []).map((t) => t.name)),
				messages: context.messages.filter((m) => m.role !== "system") as Seen["messages"],
			};
			seen.push(s);
			return step(s);
		}),
	);
	const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
	return { engine, seen };
}

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

/** What's stored in one session's folder. */
function stored(chatId: string): string[] {
	try {
		return fs.readdirSync(attachmentDirOf(chatId)).sort();
	} catch {
		return [];
	}
}

function newChat(): string {
	const chat = chatStore.createChat("Test: attachments");
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	return chat.id;
}

function postForm(chatId: string, form: FormData, headers?: HeadersInit): Promise<Response> {
	return attachmentsRoute.POST(new Request(`http://local/api/chats/${chatId}/attachments`, { method: "POST", body: form, headers }), {
		params: Promise.resolve({ id: chatId }),
	});
}

async function upload(chatId: string, name: string, bytes: Uint8Array) {
	const form = new FormData();
	form.append("file", new File([Buffer.from(bytes)], name));
	const res = await postForm(chatId, form);
	assert.ok(res.status === 200 || res.status === 422, `unexpected HTTP ${res.status}`);
	return { ok: res.status === 200, ...(await res.json()) } as { ok: boolean; attachment?: AttachmentRecord; error?: string };
}

async function attach(chatId: string, name: string, bytes: Uint8Array): Promise<{ record: AttachmentRecord; path: string }> {
	const result = await upload(chatId, name, bytes);
	assert.ok(result.ok, result.error);
	return { record: result.attachment!, path: path.join(attachmentDirOf(chatId), result.attachment!.file) };
}

/** Send one learner message and run the turn to completion. */
async function send(chatId: string, engine: PiEngine, text: string): Promise<void> {
	const req = new Request("http://local/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input: { type: "text", text } }),
	});
	const ack = await handleChatRequest(req, (opts) => createTeacherAgent(undefined, { ...opts, engine }));
	assert.equal(ack.status, 200, await ack.clone().text());
	const handle = runningTurn(chatId);
	if (handle) await new Response(handle.subscribe()).text();
}

/** The text of the most recent tool result the model was handed. */
function lastToolResult(s: Seen): string {
	const result = [...s.messages].reverse().find((m) => m.role === "toolResult");
	return ((result?.content ?? []) as Array<{ type: string; text?: string }>).map((p) => p.text ?? "").join("");
}

describe("session files (upload route → turn)", () => {
	it("lists a PDF uploaded at start in the system prompt and reads it page by page, scoped to the session", async () => {
		const chatId = newChat();
		const pdf = await attach(chatId, "physics notes.pdf", PDF);
		assert.equal(pdf.record.pages, 3);
		assert.equal(path.dirname(pdf.path), attachmentDirOf(chatId), "stored in the session's own folder");
		assert.match(pdf.record.file, /^att_[0-9a-f]{12}\.pdf$/);

		const { engine, seen } = scripted([
			() => fauxAssistantMessage([fauxToolCall("pdf_search", { path: pdf.path, query: "force" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxToolCall("pdf_extract", { path: pdf.path, pages: "2" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxToolCall("pdf_extract", { path: "/etc/passwd", pages: "1" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Page 2 covers force.")]),
		]);
		await send(chatId, engine, "explain the force section of my notes");

		assert.match(seen[0]!.systemPrompt, /## Session attachments/);
		assert.match(seen[0]!.systemPrompt, /physics notes\.pdf — PDF, 3 pages/);
		assert.ok(["pdf_info", "pdf_extract", "pdf_search"].every((t) => seen[0]!.tools.includes(t)));
		assert.ok(!seen[0]!.tools.some((t) => t.startsWith("epub_") || t.startsWith("text_")), "no EPUB or text file, no readers for them");
		assert.match(lastToolResult(seen[1]!), /"page":2/);
		assert.match(lastToolResult(seen[2]!), /--- Page 2 ---/);
		assert.doesNotMatch(lastToolResult(seen[2]!), /--- Page 1 ---/);
		assert.match(lastToolResult(seen[3]!), /must be one of this session's attachments/);
	});

	it("reads an EPUB by structure, chapter slice and search; refuses DRM at upload", async () => {
		const chatId = newChat();
		const book = await attach(
			chatId,
			"mechanics.epub",
			makeEpub({
				title: "Mechanics Primer",
				chapters: [
					{ title: "Cover", body: "<p>Mechanics</p>" },
					{ title: "Kinematics", body: "<h1>Kinematics</h1><p>Velocity is the rate of change of position.</p>" },
					{ title: "Forces", body: "<h1>Forces</h1>" + Array.from({ length: 30 }, (_, i) => `<p>Line ${i + 1} on force.</p>`).join("") },
				],
			}),
		);
		const drm = await upload(chatId, "locked.epub", makeEpub({ encrypted: true, chapters: [{ title: "A", body: "<p>x</p>" }] }));
		assert.equal(drm.ok, false);
		assert.match(drm.error!, /DRM/);

		const { engine, seen } = scripted([
			() => fauxAssistantMessage([fauxToolCall("epub_info", { path: book.path })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxToolCall("epub_read", { path: book.path, chapter: 3, limit: 4 })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxToolCall("epub_search", { path: book.path, query: "velocity" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Done.")]),
		]);
		await send(chatId, engine, "what does my book say about forces?");

		assert.match(seen[0]!.systemPrompt, /mechanics\.epub — EPUB "Mechanics Primer", 3 chapters/);
		assert.doesNotMatch(seen[0]!.systemPrompt, /locked\.epub/, "a refused upload is not an attachment");
		assert.match(lastToolResult(seen[1]!), /Kinematics/);
		const chapter = lastToolResult(seen[2]!);
		assert.match(chapter, /# Forces/);
		assert.doesNotMatch(chapter, /Velocity/);
		assert.match(chapter, /Use offset=5 to continue/);
		assert.match(lastToolResult(seen[3]!), /ch 2 \(Kinematics/);
	});

	it("reads a .md file by headings, line range and search, scoped to the session", async () => {
		const chatId = newChat();
		const notes = await attach(chatId, "limits.md", Buffer.from("# Limits\nintro\n## Epsilon-delta\nfor every epsilon\nthere is a delta\n"));
		assert.equal(notes.record.kind, "text");
		assert.equal(notes.record.lines, 6);
		const plain = await attach(chatId, "plain.txt", Buffer.from("just text"));
		assert.equal(plain.record.kind, "text");

		const { engine, seen } = scripted([
			() => fauxAssistantMessage([fauxToolCall("text_info", { path: notes.path })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxToolCall("text_search", { path: notes.path, query: "DELTA" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxToolCall("text_extract", { path: notes.path, lines: "3-4" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxToolCall("text_extract", { path: "/etc/passwd", lines: "1" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Done.")]),
		]);
		await send(chatId, engine, "walk me through my limits notes");

		assert.match(seen[0]!.systemPrompt, /limits\.md — text file, 6 lines, .* → text_info \/ text_search \/ text_extract/);
		assert.ok(["text_info", "text_extract", "text_search"].every((t) => seen[0]!.tools.includes(t)));
		assert.ok(!seen[0]!.tools.some((t) => t.startsWith("pdf_")), "no PDF attached, no PDF tools");
		assert.match(lastToolResult(seen[1]!), /Lines: 6/);
		assert.match(lastToolResult(seen[1]!), /L3: ## Epsilon-delta/);
		assert.match(lastToolResult(seen[2]!), /=== Line 3 ===/);
		assert.match(lastToolResult(seen[2]!), /=== Line 5 ===/);
		assert.equal(lastToolResult(seen[3]!), "L3: ## Epsilon-delta\nL4: for every epsilon");
		assert.match(lastToolResult(seen[4]!), /must be one of this session's attachments/);
	});

	it("survives compaction and resume; deleting the session removes its folder", async () => {
		const chatId = newChat();
		const book = await attach(chatId, "mechanics.epub", makeEpub({ chapters: [{ title: "Only", body: "<p>x</p>" }] }));
		const first = scripted([() => fauxAssistantMessage([fauxText("Seen.")])]);
		await send(chatId, first.engine, "start");

		const record = chatStore.getChat(chatId)!;
		const reply = record.messages.at(-1)!;
		chatStore.saveMessages(chatId, [
			...record.messages,
			newCompactionMarker("The learner started with a book.", { firstKeptMessageId: reply.id, tokensBefore: 1000, at: new Date().toISOString() }),
		]);

		const second = scripted([() => fauxAssistantMessage([fauxText("Continuing.")])]);
		await send(chatId, second.engine, "continue");
		assert.match(second.seen[0]!.systemPrompt, /mechanics\.epub — EPUB/);
		assert.ok(second.seen[0]!.tools.includes("epub_read"));

		assert.ok(fs.existsSync(book.path));
		const outcome = await deleteChatSession(chatId, "preserve-graph");
		assert.ok(outcome.ok);
		assert.equal(fs.existsSync(attachmentDirOf(chatId)), false);
	});

	it("keeps each session's readers to its own files", async () => {
		const mine = newChat();
		const theirs = newChat();
		const own = await attach(mine, "own.epub", makeEpub({ title: "Own", chapters: [{ title: "A", body: "<p>own</p>" }] }));
		const other = await attach(theirs, "private.epub", makeEpub({ title: "Private", chapters: [{ title: "B", body: "<p>secret</p>" }] }));

		const { engine, seen } = scripted([
			() => fauxAssistantMessage([fauxToolCall("epub_read", { path: other.path, chapter: 1 })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Done.")]),
		]);
		await send(mine, engine, "read");
		assert.match(lastToolResult(seen[1]!), /must be one of this session's attachments/);
		assert.doesNotMatch(lastToolResult(seen[1]!), /secret/);
		assert.ok(seen[0]!.systemPrompt.includes("own.epub — EPUB") && seen[0]!.systemPrompt.includes(`path: ${own.path}`));
		assert.doesNotMatch(seen[0]!.systemPrompt, /private\.epub/);
	});

	it("refuses files whose bytes don't match their type, leaving nothing stored", async () => {
		const chatId = newChat();
		const drm = await upload(chatId, "locked.epub", makeEpub({ encrypted: true, chapters: [{ title: "A", body: "<p>x</p>" }] }));
		assert.equal(drm.ok, false);
		const fakePdf = await upload(chatId, "fake.pdf", Buffer.from("not a pdf at all"));
		assert.equal(fakePdf.ok, false);
		assert.match(fakePdf.error!, /doesn't look like a PDF/);
		const binary = await upload(chatId, "binary.txt", Buffer.from([104, 105, 0, 1, 2]));
		assert.equal(binary.ok, false);
		assert.match(binary.error!, /doesn't look like a text file/);
		const garbled = await upload(chatId, "garbled.md", Buffer.from(Array.from({ length: 200 }, (_, i) => (i % 2 ? 0xff : 0x61))));
		assert.equal(garbled.ok, false);
		assert.match(garbled.error!, /doesn't look like a text file/);
		assert.deepEqual(stored(chatId), [], "nothing stored for a refused file");
		assert.equal(chatStore.getChat(chatId)!.attachments, undefined);
	});

	it("refuses a cut-off body and an over-size body", async () => {
		const chatId = newChat();
		// The proxy truncates past its buffer limit instead of failing: a
		// multipart body that stops short never yields a partial form.
		const form = new FormData();
		form.append("file", new File(["# a whole file\n".repeat(100)], "cut.md"));
		const full = new Request("http://local/", { method: "POST", body: form });
		const bytes = new Uint8Array(await full.arrayBuffer());
		const cut = await attachmentsRoute.POST(
			new Request(`http://local/api/chats/${chatId}/attachments`, {
				method: "POST",
				headers: { "Content-Type": full.headers.get("content-type")! },
				body: bytes.slice(0, bytes.length - 60),
			}),
			{ params: Promise.resolve({ id: chatId }) },
		);
		assert.equal(cut.status, 400);

		const big = await attachmentsRoute.POST(
			new Request(`http://local/api/chats/${chatId}/attachments`, {
				method: "POST",
				headers: { "Content-Type": full.headers.get("content-type")! },
				body: new ReadableStream({
					start(controller) {
						const chunk = new Uint8Array(1024 * 1024);
						for (let i = 0; i < 52; i++) controller.enqueue(chunk);
						controller.close();
					},
				}),
				duplex: "half",
			} as RequestInit),
			{ params: Promise.resolve({ id: chatId }) },
		);
		assert.equal(big.status, 413);
		assert.match(((await big.json()) as { error: string }).error, /at most 50 MB/);
		assert.equal(chatStore.getChat(chatId)!.attachments, undefined);
		assert.deepEqual(stored(chatId), []);
	});

	it("takes files only while the session is starting (R1)", async () => {
		const chatId = newChat();
		await attach(chatId, "before.md", Buffer.from("# Before\n"));
		await send(chatId, scripted([() => fauxAssistantMessage([fauxText("Hi.")])]).engine, "start");

		const form = new FormData();
		form.append("file", new File(["# After\n"], "after.md"));
		const res = await postForm(chatId, form);
		assert.equal(res.status, 409);
		assert.equal(((await res.json()) as { error: string }).error, "Files can only be added when the session starts.");
		assert.deepEqual(chatStore.getChat(chatId)!.attachments!.map((a) => a.name), ["before.md"]);
		assert.equal(stored(chatId).length, 1);
	});

	it("answers bad upload requests with the right status", async () => {
		const chatId = newChat();
		const docFile = new FormData();
		docFile.append("file", new File(["hello"], "notes.docx"));
		const image = new FormData();
		image.append("file", new File(["png"], "diagram.png"));
		const cases: Array<{ name: string; res: () => Promise<Response>; status: number; error?: string }> = [
			{ name: "unknown chat", res: () => postForm("chat_nope", new FormData()), status: 404 },
			{ name: "no file field", res: () => postForm(chatId, new FormData()), status: 400 },
			{ name: "unsupported type", res: () => postForm(chatId, docFile), status: 422, error: "Attach PDFs, EPUBs, or text files (.txt, .md)." },
			{ name: "images are no longer taken", res: () => postForm(chatId, image), status: 422, error: "Attach PDFs, EPUBs, or text files (.txt, .md)." },
		];
		for (const c of cases) {
			const res = await c.res();
			assert.equal(res.status, c.status, c.name);
			if (c.error) assert.equal(((await res.json()) as { error: string }).error, c.error, c.name);
		}
		assert.equal(chatStore.getChat(chatId)!.attachments, undefined);
	});
});
