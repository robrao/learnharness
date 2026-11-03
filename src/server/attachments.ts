import * as crypto from "node:crypto";
import * as path from "node:path";
import {
	ATTACHMENT_MAX_BYTES,
	ATTACHMENT_TYPES,
	attachmentExtension,
	type AttachmentRecord,
	type ChatRecord,
} from "../core/contracts.ts";
import { epubInfo } from "../agent/subagents/epub-ops.ts";
import { pdfInfo } from "../agent/subagents/pdf-ops.ts";
import type { SessionAttachment } from "../agent/tools/attachments.ts";
import type { SourceKind } from "../core/contracts.ts";
import { attachmentsRoot, blobPath, pinBlob, removeBlobsUnreferenced, unpinBlob, writeBlob } from "../store/attachments.ts";
import { stores } from "./stores.ts";

/**
 * Session context attachments (2026-10-29) — the upload orchestration
 * behind POST /api/chats/[id]/attachments. The file is validated (type,
 * size), stored as a content-addressed blob (the same bytes attached
 * twice — any sessions — are kept once), and INSPECTED once (PDF
 * page count, EPUB chapters + title — which also refuses DRM and broken
 * files at the door, never mid-lesson); only then does its record land on
 * the chat. One file per call.
 */

export interface UploadedFile {
	name: string;
	bytes: Uint8Array;
}

/** The outcome of one upload: the stored (or reactivated) record, or a learner-readable refusal. */
export type AttachmentUploadResult = { ok: true; attachment: AttachmentRecord } | { ok: false; error: string };

function formatMb(bytes: number): string {
	return `${Math.round(bytes / (1024 * 1024))} MB`;
}

const SNIFF_BYTES = 8192;
const MAX_REPLACEMENT_RATIO = 0.01;

/** null when the bytes plausibly match the kind, else the learner-facing
 *  reason (learn-from-a-file, owner 2026-10-28): a PDF must carry the %PDF-
 *  header; text must have no NUL in its first 8 KB and ≤1% undecodable
 *  characters there. */
export function sniffSource(kind: SourceKind, bytes: Uint8Array): string | null {
	const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (kind === "pdf") {
		return buf.subarray(0, 5).toString("latin1") === "%PDF-" ? null : "That file doesn't look like a PDF.";
	}
	const head = buf.subarray(0, SNIFF_BYTES);
	if (head.includes(0)) return "That file doesn't look like a text file.";
	// A multibyte character split at the 8 KB boundary decodes to one
	// trailing U+FFFD — not evidence of binary content.
	let decoded = new TextDecoder("utf-8").decode(head);
	if (buf.length > SNIFF_BYTES && decoded.endsWith("\uFFFD")) decoded = decoded.slice(0, -1);
	let bad = 0;
	for (const ch of decoded) if (ch === "\uFFFD") bad++;
	return decoded.length > 0 && bad / decoded.length > MAX_REPLACEMENT_RATIO ? "That file doesn't look like a text file." : null;
}

async function inspect(path: string, kind: AttachmentRecord["kind"], bytes: Uint8Array): Promise<Partial<AttachmentRecord>> {
	if (kind === "pdf" || kind === "text") {
		const refused = sniffSource(kind, bytes);
		if (refused) throw new Error(refused);
	}
	if (kind === "text") return { lines: new TextDecoder("utf-8").decode(bytes).split(/\r?\n/).length };
	if (kind === "pdf") {
		const info = await pdfInfo(path).catch(() => {
			throw new Error("This PDF can't be opened (damaged or password-protected).");
		});
		return { pages: info.page_count };
	}
	if (kind === "epub") {
		const info = await epubInfo(path);
		return { chapters: info.chapters.length, title: info.title };
	}
	return {};
}

/** Validate, store, inspect and record one file on the chat. The same bytes already on the chat
 *  return that record (restored if it was removed) instead of a duplicate. */
export async function addChatAttachment(chatId: string, upload: UploadedFile): Promise<AttachmentUploadResult> {
	const { name, bytes } = upload;
	const ext = attachmentExtension(name);
	const type = ATTACHMENT_TYPES[ext];
	if (!type) return { ok: false, error: "Unsupported file type. Attach images (PNG, JPG, GIF, WebP), PDFs, EPUBs, or text files (.txt, .md)." };
	if (bytes.byteLength > ATTACHMENT_MAX_BYTES) return { ok: false, error: `File is larger than ${formatMb(ATTACHMENT_MAX_BYTES)}.` };
	const file = writeBlob(bytes, ext);
	// Already on this chat (same bytes, same type): hand back that record
	// instead of a second manifest line — restored if it was removed, so the
	// composer never sends an id the agent ignores.
	const existing = stores.chatStore.getChat(chatId)?.attachments?.find((a) => a.file === file);
	if (existing) {
		if (existing.detachedAt) return { ok: true, attachment: stores.chatStore.setAttachmentDetached(chatId, existing.id, false) ?? existing };
		return { ok: true, attachment: existing };
	}
	pinBlob(file);
	try {
		let facts: Partial<AttachmentRecord>;
		try {
			facts = await inspect(blobPath(file), type.kind, bytes);
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
		const attachment: AttachmentRecord = {
			id: `att_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
			name,
			kind: type.kind,
			mimeType: type.mimeType,
			bytes: bytes.byteLength,
			file,
			addedAt: new Date().toISOString(),
			...facts,
		};
		stores.chatStore.addAttachments(chatId, [attachment]);
		return { ok: true, attachment };
	} finally {
		unpinBlob(file);
		// A refused file's blob goes (or the new one, if the chat vanished
		// mid-upload) — unless some chat already holds the same bytes.
		removeBlobsUnreferenced([file], stores.chatStore.referencedAttachmentFiles());
	}
}

/** The session's ACTIVE attachments as the agent layer sees them; the one place blob paths are resolved. */
export function sessionAttachments(record: Pick<ChatRecord, "attachments" | "teachingSourceId">): SessionAttachment[] {
	return (record.attachments ?? [])
		.filter((r) => !r.detachedAt)
		.map((r) => ({
			record: r,
			path: path.join(attachmentsRoot(), r.file),
			...(r.id === record.teachingSourceId ? { teachingSource: true as const } : {}),
		}));
}
