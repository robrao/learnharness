import React from "react";
(globalThis as Record<string, unknown>).React = React;

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { DraftShell, startDraftSession } from "../components/new-session.tsx";
import { clearOpeningPrompt, readOpeningPrompt, readOpeningPromptEntry, OPENING_PROMPT_FAILURE } from "../components/opening-prompt.ts";
import { SessionStarter } from "../components/start-session.ts";
import { canBeTeachingSource, type AttachmentDraft } from "../components/attachments.tsx";
import { NodePickerControl } from "../components/composer-actions.tsx";

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
beforeEach(() => {
	const data = new Map<string, string>();
	Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => { data.set(key, value); },
		removeItem: (key: string) => { data.delete(key); },
	} });
});
afterEach(() => {
	if (originalStorage) Object.defineProperty(globalThis, "sessionStorage", originalStorage);
	else Reflect.deleteProperty(globalThis, "sessionStorage");
});

/**
 * The sessionless draft view (/chat/new, owner 2026-09-13): "+ New session"
 * opens the draft — NOTHING is created until the first message is sent, and
 * that message becomes the session's title. These pins hold the two seams:
 * startDraftSession (the create-on-send contract) and DraftShell (the
 * visible surface: composer blob + stats bar + the fresh-chat empty state).
 */

/** A fetch double: records calls, answers /api/chats with a canned id. */
function fakeFetch(id: string) {
	const calls: { url: string; method: string; body: unknown }[] = [];
	const f = (async (url: string, init?: RequestInit) => {
		calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
		return new Response(JSON.stringify({ id }), { status: 200 });
	}) as typeof fetch;
	return { f, calls };
}

describe("startDraftSession — the create-on-send contract", () => {
	it("creates the session titled with the first message and returns a short path", async () => {
		const { f, calls } = fakeFetch("c_new");
		const target = await startDraftSession("teach me orbital mechanics", f);
		assert.equal(target, "/chat/c_new");
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.url, "/api/chats");
		assert.equal(calls[0]!.method, "POST");
		assert.deepEqual(calls[0]!.body, { title: "teach me orbital mechanics" });
	});

	it("no settings PUT on create — the server stamps the newborn (per-session models, owner 2026-09-28)", async () => {
		const { f, calls } = fakeFetch("c_3");
		await startDraftSession("hello", f);
		assert.equal(calls.length, 1, "a single create call — the birth stamp is server-side");
	});

	it("a long opening text stays out of the URL and is stashed for the chat page", async () => {
		const mem = new Map<string, string>();
		const fake = {
			getItem: (k: string) => mem.get(k) ?? null,
			setItem: (k: string, v: string) => {
				mem.set(k, v);
			},
			removeItem: (k: string) => {
				mem.delete(k);
			},
		};
		const holder = globalThis as { sessionStorage?: Storage };
		const prev = holder.sessionStorage;
		Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: fake });
		try {
			const { f } = fakeFetch("c_long");
			const text = `${"B2 First grammar item. ".repeat(1500)}end`;
			const target = await startDraftSession(text, f);
			assert.equal(target, "/chat/c_long");
			assert.equal(target!.includes("?"), false);
			const stashed = readOpeningPrompt("c_long");
			assert.equal(stashed?.length, text.length);
			assert.equal(stashed, text);
			clearOpeningPrompt("c_long");
			assert.equal(readOpeningPrompt("c_long"), undefined);
		} finally {
			if (prev === undefined) delete holder.sessionStorage;
			else Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: prev });
		}
	});

	it("empty or whitespace text never creates anything", async () => {
		const { f, calls } = fakeFetch("never");
		assert.equal(await startDraftSession("", f), null);
		assert.equal(await startDraftSession("   ", f), null);
		assert.equal(calls.length, 0);
	});
});

describe("DraftShell — the sessionless surface", () => {
	it("storage failure leaves the full draft editable beside the approved error", () => {
		const html = renderToStaticMarkup(<DraftShell busy={false} text="keep all my text" onChange={() => {}} onSend={() => {}} startError />);
		assert.ok(html.includes('role="alert"'));
		assert.ok(html.includes(OPENING_PROMPT_FAILURE));
		assert.match(html, /<div[^>]*role="textbox"[^>]*contentEditable="true"[^>]*>keep all my text<\/div>/);
	});
	it("renders the composer blob, the stats bar, and the fresh-chat empty state", () => {
		const html = renderToStaticMarkup(
			<DraftShell
				busy={false}
				text=""
				onChange={() => {}}
				onSend={() => {}}
			/>,
		);
		// The chat composer, ready for the first message.
		assert.ok(html.includes('data-testid="composer"'));
		// The draft's model control binds the strong slot — the
		// new-session default (per-session models, owner 2026-09-28).
		assert.ok(html.includes('data-testid="stats-model"'));
		// No CTA by default: a configured surface stays quiet.
		assert.ok(!html.includes('data-testid="setup-cta"'));
		// The same empty state a fresh chat shows.
		assert.ok(html.includes("The teacher will open by probing what you already know."));
		// The pointer-events pattern (953b22b): the wrapper stays inert…
		assert.ok(html.includes("pointer-events-none"));
		// …and the blob re-enables it.
		assert.ok(/rounded-2xl[^>]*pointer-events-auto|pointer-events-auto[^>]*rounded-2xl/.test(html));
	});

	it("renders the setup CTA above the composer blob when passed (fix wave chunk B: /chat/new mirrors home)", () => {
		const html = renderToStaticMarkup(
			<DraftShell
				busy={false}
				text=""
				onChange={() => {}}
				onSend={() => {}}
				setupCta={
					<button type="button" data-testid="setup-cta">
						Set up your models
					</button>
				}
			/>,
		);
		// The same affordance home carries, above the draft shell's blob.
		assert.ok(html.includes('data-testid="setup-cta"'));
		assert.match(html, />Set up your models<\/button>/);
		assert.doesNotMatch(html, /chats start after/);
		// Above the composer: the CTA's markup precedes the blob's.
		const cta = html.indexOf('data-testid="setup-cta"');
		const blob = html.search(/rounded-2xl[^>]*pointer-events-auto|pointer-events-auto[^>]*rounded-2xl/);
		assert.ok(cta !== -1 && blob !== -1 && cta < blob, "CTA above the blob");
	});

	it("no chat id anywhere — nothing in the markup references a session", () => {
		const html = renderToStaticMarkup(
			<DraftShell
				busy={false}
				text=""
				onChange={() => {}}
				onSend={() => {}}
			/>,
		);
		assert.ok(!/\/chat\/c[a-z0-9_]+/.test(html));
	});
});
describe("the practice draft (?mode=practice, 2026-10-04)", () => {
	it("the shell swaps copy: practice title, empty state, placeholder", () => {
		const html = renderToStaticMarkup(
			<DraftShell
				busy={false}
				text=""
				onChange={() => {}}
				onSend={() => {}}
				mode="practice"
			/>,
		);
		assert.match(html, /New practice session/);
		assert.ok(html.includes("Pick nodes from your knowledge graph, describe what you want to practice, or bring your own problem."));
		assert.match(html, /What do you want to practice\?/);
	});

	it("THE PICK BAR (owner round 10): the practice draft carries the same pill above its composer", () => {
		const html = renderToStaticMarkup(
			<DraftShell
				busy={false}
				text=""
				onChange={() => {}}
				onSend={() => {}}
				mode="practice"
			/>,
		);
		assert.match(html, />Pick nodes<\/button>/);
		// picked: count + Clear, the home register verbatim
		const picked = renderToStaticMarkup(
			<DraftShell
				busy={false}
				text=""
				onChange={() => {}}
				onSend={() => {}}
				mode="practice"
				picks={[{ id: "n_1", name: "Parity", statement: "Odd + odd = even." }]}
			/>,
		);
		assert.match(picked, /1 node selected/);
		assert.match(picked, /Clear/);
		// teach mode with nothing picked renders nothing (home's law)
		const teach = renderToStaticMarkup(
			<DraftShell busy={false} text="" onChange={() => {}} onSend={() => {}} mode="teach" />,
		);
		assert.ok(!teach.includes('data-testid="practice-props-chip"'));
	});

	it("startDraftSession carries the picks as graphContext (the home practice contract)", async () => {
		let body: Record<string, unknown> | null = null;
		const f = (async (_url: string, init?: RequestInit) => {
			body = JSON.parse(String(init?.body));
			return new Response(JSON.stringify({ id: "c10" }), { status: 201 });
		}) as unknown as typeof fetch;
		await startDraftSession("drill me", f, "practice", [{ id: "n_1", name: "Parity", statement: "Odd + odd = even." }]);
		assert.deepEqual(body, {
			title: "drill me",
			kind: "practice",
			graphContext: { propositions: [{ id: "n_1", name: "Parity", statement: "Odd + odd = even." }] },
		});
	});

	it("practice with NO picks stays lean — no graphContext key on the wire", async () => {
		let body: Record<string, unknown> | null = null;
		const f = (async (_url: string, init?: RequestInit) => {
			body = JSON.parse(String(init?.body));
			return new Response(JSON.stringify({ id: "c11" }), { status: 201 });
		}) as unknown as typeof fetch;
		await startDraftSession("free practice", f, "practice", []);
		assert.deepEqual(body, { title: "free practice", kind: "practice" });
	});

	it("startDraftSession carries kind:\"practice\" to the create route", async () => {
		let body: Record<string, unknown> | null = null;
		const f = (async (_url: string, init?: RequestInit) => {
			body = JSON.parse(String(init?.body));
			return new Response(JSON.stringify({ id: "c9" }), { status: 201 });
		}) as unknown as typeof fetch;
		const target = await startDraftSession("the parity chain", f, "practice");
		assert.equal(target, "/chat/c9");
		assert.deepEqual(body, { title: "the parity chain", kind: "practice" });
	});

	it("the teaching default is unchanged — no kind key on the wire", async () => {
		let body: Record<string, unknown> | null = null;
		const f = (async (_url: string, init?: RequestInit) => {
			body = JSON.parse(String(init?.body));
			return new Response(JSON.stringify({ id: "c8" }), { status: 201 });
		}) as unknown as typeof fetch;
		await startDraftSession("orbital mechanics", f);
		assert.deepEqual(body, { title: "orbital mechanics" });
	});
});

describe("context attachments on a new session (2026-10-29)", () => {
	it("uploads the picked files once the session exists, and hands their ids to the chat page with the text", async () => {
		const { f, calls } = fakeFetch("c_att");
		const uploads: string[] = [];
		const target = await startDraftSession("teach me from my book", f, undefined, undefined, new SessionStarter(), undefined, {
			identity: "book.epub",
			upload: async (chatId) => {
				uploads.push(chatId);
				return ["att_1"];
			},
		});
		assert.equal(target, "/chat/c_att");
		assert.equal(calls.length, 1, "one create");
		assert.deepEqual(uploads, ["c_att"], "uploads target the new session, before navigation");
		assert.deepEqual(readOpeningPromptEntry("c_att"), { text: "teach me from my book", attempted: false, attachmentIds: ["att_1"] });
	});

	it("a failed upload keeps the created session; the retry reuses it instead of creating another", async () => {
		const { f, calls } = fakeFetch("c_retry");
		const starter = new SessionStarter();
		let attempt = 0;
		const attach = {
			identity: "notes.pdf",
			upload: async () => {
				if (attempt++ === 0) throw new Error("notes.pdf: upload failed");
				return ["att_9"];
			},
		};
		await assert.rejects(startDraftSession("hello", f, undefined, undefined, starter, undefined, attach), /upload failed/);
		assert.equal(await startDraftSession("hello", f, undefined, undefined, starter, undefined, attach), "/chat/c_retry");
		assert.equal(calls.length, 1, "no second session");
		assert.deepEqual(readOpeningPromptEntry("c_retry")?.attachmentIds, ["att_9"]);
	});

	it("shows the Add context control and the picked files as removable chips", () => {
		const file = new File(["x"], "mechanics.epub");
		const draft: AttachmentDraft = {
			files: [{ key: "k1", file }],
			error: null,
			add() {},
			remove() {},
			clear() {},
			upload: async () => [],
			identity: () => "k1",
			sourceKey: null,
			setSource() {},
			sourceId: () => undefined,
		};
		const html = renderToStaticMarkup(<DraftShell busy={false} text="" onChange={() => {}} onSend={() => {}} attachments={draft} />);
		assert.match(html, /data-testid="attach-context"/);
		assert.match(html, /Add context/);
		assert.match(html, /accept="[^"]*\.epub[^"]*"/);
		assert.match(html, /mechanics\.epub/);
		assert.match(html, /aria-label="Remove mechanics\.epub"/);
	});
});

/** A draft holding these files, the one keyed `ticked` checked as the source. */
function draftOf(names: string[], ticked: string | null = null): AttachmentDraft {
	return {
		files: names.map((name) => ({ key: name, file: new File(["x"], name) })),
		error: null,
		add() {},
		remove() {},
		clear() {},
		upload: async () => [],
		identity: () => names.join("|"),
		sourceKey: ticked,
		setSource() {},
		sourceId: () => undefined,
	};
}

const checkboxes = (html: string) => html.match(/<input[^>]*data-testid="teaching-source-checkbox"[^>]*>/g) ?? [];

describe("the teaching source checkbox (owner, 2026-11-03)", () => {
	it("offered only on PDF / .txt / .md chips, unticked by default, in teach mode", () => {
		const html = renderToStaticMarkup(
			<DraftShell busy={false} text="" onChange={() => {}} onSend={() => {}} attachments={draftOf(["calc.pdf", "notes.md", "plain.txt", "book.epub", "fig.png"])} />,
		);
		assert.equal(checkboxes(html).length, 3);
		assert.ok(checkboxes(html).every((c) => !c.includes("checked")), "unticked by default");
		assert.match(html, /Teaching source/);
		assert.deepEqual(["a.pdf", "a.md", "a.txt", "a.epub", "a.png", "a.docx"].map(canBeTeachingSource), [true, true, true, false, false, false]);
	});

	it("practice mode hides it", () => {
		const html = renderToStaticMarkup(<DraftShell busy={false} text="" onChange={() => {}} onSend={() => {}} mode="practice" attachments={draftOf(["calc.pdf"])} />);
		assert.equal(checkboxes(html).length, 0);
	});

	it("the ticked file is checked; the send works with empty text and the placeholder says the goal is optional", () => {
		const html = renderToStaticMarkup(
			<DraftShell busy={false} text="" onChange={() => {}} onSend={() => {}} attachments={draftOf(["calc.pdf", "notes.md"], "notes.md")} />,
		);
		const [pdf, md] = checkboxes(html);
		assert.ok(!pdf!.includes("checked") && md!.includes("checked"), "exactly the ticked file");
		assert.match(html, /What do you want from this file\? \(optional\)/);
		assert.doesNotMatch(html, /aria-label="Send"[^>]*disabled=""/);
		const empty = renderToStaticMarkup(<DraftShell busy={false} text="" onChange={() => {}} onSend={() => {}} attachments={draftOf(["calc.pdf"])} />);
		assert.match(empty, /aria-label="Send"[^>]*disabled=""/, "without a ticked source, empty text cannot send");
	});

	it("picks disable the checkbox; a ticked source disables the picker", () => {
		const picks = [{ id: "p1", name: "Limit", statement: "x" }];
		const withPicks = renderToStaticMarkup(
			<DraftShell busy={false} text="" onChange={() => {}} onSend={() => {}} picks={picks} attachments={draftOf(["calc.pdf"])} />,
		);
		assert.ok(checkboxes(withPicks)[0]!.includes("disabled"));
		assert.match(withPicks, /Clear your picks to use a file as the teaching source/);

		const ticked = renderToStaticMarkup(
			<DraftShell busy={false} text="" onChange={() => {}} onSend={() => {}} picks={picks} attachments={draftOf(["calc.pdf"], "calc.pdf")} />,
		);
		assert.match(ticked, /data-testid="practice-props-chip"[^>]*disabled=""/);

		const html = renderToStaticMarkup(<NodePickerControl count={2} disabled />);
		assert.equal((html.match(/disabled=""/g) ?? []).length, 2);
		assert.match(html, /Untick the teaching source to pick nodes/);
		assert.ok(!renderToStaticMarkup(<NodePickerControl count={2} />).includes(`disabled=""`));
	});
});

describe("the start flow with a teaching source", () => {
	function sourceFetch(id: string, sourceStatus: () => number) {
		const calls: { url: string; body: unknown }[] = [];
		const f = (async (url: string, init?: RequestInit) => {
			calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
			if (String(url).endsWith("/source")) {
				const status = sourceStatus();
				return new Response(JSON.stringify(status === 200 ? { ok: true } : { error: "Only a PDF, .txt or .md file can be the teaching source." }), { status });
			}
			return new Response(JSON.stringify({ id }), { status: 200 });
		}) as typeof fetch;
		return { f, calls };
	}

	it("uploads, names the source with the goal, and stashes NO opening prompt", async () => {
		const { f, calls } = sourceFetch("c_src", () => 200);
		const target = await startDraftSession("pass the exam", f, undefined, undefined, new SessionStarter(), undefined, {
			identity: "calc.pdf#calc.pdf",
			upload: async () => ["att_1", "att_2"],
			sourceId: () => "att_1",
			goal: "pass the exam",
		});
		assert.equal(target, "/chat/c_src");
		assert.deepEqual(calls.map((c) => c.url), ["/api/chats", "/api/chats/c_src/source"]);
		assert.deepEqual(calls[1]!.body, { attachmentId: "att_1", goal: "pass the exam" });
		assert.equal(readOpeningPromptEntry("c_src"), undefined, "the server starts the session");
	});

	it("no goal: the field is omitted", async () => {
		const { f, calls } = sourceFetch("c_nogoal", () => 200);
		await startDraftSession("calc.pdf", f, undefined, undefined, new SessionStarter(), undefined, {
			identity: "calc.pdf#calc.pdf",
			upload: async () => ["att_1"],
			sourceId: () => "att_1",
		});
		assert.deepEqual(calls[0]!.body, { title: "calc.pdf" });
		assert.deepEqual(calls[1]!.body, { attachmentId: "att_1" });
	});

	it("a refused source call surfaces the server's reason; the retry reuses the session and re-sends only that call", async () => {
		let attempt = 0;
		const { f, calls } = sourceFetch("c_srcretry", () => (attempt++ === 0 ? 400 : 200));
		const starter = new SessionStarter();
		const uploads: string[] = [];
		const attach = {
			identity: "calc.pdf#calc.pdf",
			upload: async (chatId: string) => {
				uploads.push(chatId);
				return ["att_1"];
			},
			sourceId: () => "att_1",
		};
		await assert.rejects(startDraftSession("calc.pdf", f, undefined, undefined, starter, undefined, attach), /Only a PDF/);
		assert.equal(await startDraftSession("calc.pdf", f, undefined, undefined, starter, undefined, attach), "/chat/c_srcretry");
		assert.deepEqual(calls.map((c) => c.url), ["/api/chats", "/api/chats/c_srcretry/source", "/api/chats/c_srcretry/source"]);
		assert.equal(readOpeningPromptEntry("c_srcretry"), undefined);
	});
});
