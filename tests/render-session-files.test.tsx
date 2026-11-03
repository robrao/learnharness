import React from "react";
(globalThis as Record<string, unknown>).React = React;

import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AttachmentChips, SessionFilesControl } from "../components/attachments.tsx";
import type { AttachmentRecord } from "../src/core/contracts.ts";

/**
 * The session-files panel (2026-10-29): active files removable, removed
 * ones restorable, the opening chip's file highlighted; transcript chips
 * read-only and marked when their file was removed. The live fetches and
 * focus moves are the e2e smoke's beat (scripts/smoke-attachments.mjs).
 */

const book: AttachmentRecord = {
	id: "att_book",
	name: "mechanics.epub",
	kind: "epub",
	mimeType: "application/epub+zip",
	bytes: 200 * 1024,
	file: "a".repeat(64) + ".epub",
	addedAt: "2026-10-29T10:00:00.000Z",
	chapters: 3,
};
const figure: AttachmentRecord = {
	id: "att_figure",
	name: "figure.png",
	kind: "image",
	mimeType: "image/png",
	bytes: 2048,
	file: "b".repeat(64) + ".png",
	addedAt: "2026-10-29T10:01:00.000Z",
	detachedAt: "2026-10-29T10:02:00.000Z",
};

describe("session files panel", () => {
	it("lists active files with Remove, removed files with Undo, and highlights the chip's file", () => {
		const html = renderToStaticMarkup(
			<SessionFilesControl
				chatId="chat_1"
				attachments={[book, figure]}
				setAttachments={() => {}}
				open
				onOpenChange={() => {}}
				highlightId={book.id}
			/>,
		);
		assert.match(html, /Files · 1/);
		assert.match(html, /aria-label="Remove mechanics\.epub"/);
		assert.match(html, /aria-label="Undo removing figure\.png"/);
		assert.match(html, /Removed from context/);
		assert.match(html, /EPUB · 3 chapters/);
		assert.match(html, /data-attachment-id="att_book" data-highlighted="true"/);
		assert.doesNotMatch(html, /data-attachment-id="att_figure" data-highlighted/);
	});

	it("marks a removed file's transcript chip without offering removal", () => {
		const html = renderToStaticMarkup(<AttachmentChips items={[{ id: figure.id, name: figure.name, detached: true }]} onOpen={() => {}} />);
		assert.match(html, />removed</);
		assert.doesNotMatch(html, /aria-label="Remove /);
	});
});

describe("session files panel: the teaching source (owner, 2026-11-03)", () => {
	it("badges the source and gives it no Remove; context files keep theirs", () => {
		const notes: AttachmentRecord = {
			id: "att_notes",
			name: "calculus.md",
			kind: "text",
			mimeType: "text/markdown",
			bytes: 4096,
			file: "c".repeat(64) + ".md",
			addedAt: "2026-11-03T10:00:00.000Z",
			lines: 120,
		};
		const html = renderToStaticMarkup(
			<SessionFilesControl
				chatId="c1"
				attachments={[notes, book]}
				setAttachments={() => {}}
				open
				onOpenChange={() => {}}
				highlightId={null}
				teachingSourceId="att_notes"
			/>,
		);
		assert.equal((html.match(/data-testid="teaching-source-badge"/g) ?? []).length, 1);
		assert.match(html, /calculus\.md[\s\S]*Text · 120 lines · 4 KB[\s\S]*Teaching source/);
		assert.doesNotMatch(html, /aria-label="Remove calculus\.md"/);
		assert.match(html, /aria-label="Remove mechanics\.epub"/);
	});
});
