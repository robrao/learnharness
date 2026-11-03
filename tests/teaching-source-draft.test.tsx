/** The attachment draft's teaching-source state (owner, 2026-11-03): one
 *  ticked file at most; removing or clearing it unticks; the retry identity
 *  follows the tick; sourceId() is the ticked file's id once uploaded. */
import React, { act } from "react";
import assert from "node:assert/strict";
import test from "node:test";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { useAttachmentDraft, type AttachmentDraft } from "../components/attachments.tsx";

(globalThis as Record<string, unknown>).React = React;
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });

function fileList(...names: string[]): FileList {
	return names.map((n) => new File(["x"], n)) as unknown as FileList;
}

test("one ticked source; remove and clear untick it; identity and sourceId follow it", async () => {
	let draft!: AttachmentDraft;
	function Probe() {
		draft = useAttachmentDraft();
		return null;
	}
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	try {
		await act(async () => root.render(<Probe />));
		await act(async () => draft.add(fileList("a.pdf", "b.md")));
		const [a, b] = draft.files.map((f) => f.key);
		assert.equal(draft.sourceKey, null, "unticked by default");
		const untickedIdentity = draft.identity();

		await act(async () => draft.setSource(a!));
		assert.equal(draft.sourceKey, a);
		assert.notEqual(draft.identity(), untickedIdentity, "ticking changes the retry identity");
		await act(async () => draft.setSource(b!));
		assert.equal(draft.sourceKey, b, "ticking another replaces the first");

		const ids = { "a.pdf": "att_a", "b.md": "att_b" } as Record<string, string>;
		const fetchLike = (async (_url: string, init?: RequestInit) => {
			const name = ((init!.body as FormData).get("file") as File).name;
			return Response.json({ attachment: { id: ids[name], name } });
		}) as typeof fetch;
		assert.equal(draft.sourceId(), undefined, "no id before upload");
		await act(async () => void (await draft.upload("c1", fetchLike)));
		assert.equal(draft.sourceId(), "att_b");

		await act(async () => draft.remove(b!));
		assert.equal(draft.sourceKey, null, "removing the ticked file unticks");
		await act(async () => draft.setSource(a!));
		await act(async () => draft.remove(b!));
		assert.equal(draft.sourceKey, a, "removing another file keeps the tick");
		await act(async () => draft.clear());
		assert.equal(draft.sourceKey, null);
	} finally {
		await act(async () => root.unmount());
		host.remove();
	}
});
