import * as crypto from "node:crypto";
import {
	ATTACHMENT_MAX_BYTES,
	ATTACHMENT_TYPES,
	attachmentExtension,
	type AttachmentRecord,
	type ChatRecord,
	type SourceKind,
} from "../core/contracts.ts";
import { epubInfo } from "../agent/subagents/epub-ops.ts";
import { pdfInfo } from "../agent/subagents/pdf-ops.ts";
import type { SessionAttachment } from "../agent/tools/attachments.ts";
import { attachmentPath, removeAttachmentFile, writeAttachmentFile } from "../store/attachments.ts";
import { stores } from "./stores.ts";

/**
 * Session files (teaching-source spec rev 2) — the upload orchestration
 * behind POST /api/chats/[id]/attachments. Files arrive only while the
 * session is starting (R1). Each is validated (type, size, content sniff),
 * stored in the session's folder, and INSPECTED once (PDF page count, EPUB
 * chapters + title, text line count — which also refuses DRM and broken
 * files at the door, never mid-lesson); only then does its record land on
 * the chat. One file per call.
 */

export interface UploadedFile {
	name: string;
	bytes: Uint8Array;
}

/** The outcome of one upload: the stored record, or a learner-readable refusal with its HTTP status. */
export type AttachmentUploadResult =
	| { ok: true; attachment: AttachmentRecord }
	| { ok: false; status: 404 | 409 | 422; error: string };

export const UNSUPPORTED_ATTACHMENT_ERROR = "Attach PDFs, EPUBs, or text files (.txt, .md).";
export const ATTACHMENTS_CLOSED_ERROR = "Files can only be added when the session starts.";

/** R1: files are taken only while the session is starting — before its first message. */
export function attachmentsClosed(chat: Pick<ChatRecord, "messages">): boolean {
	return chat.messages.length > 0;
}

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
	if (buf.length > SNIFF_BYTES && decoded.endsWith("�")) decoded = decoded.slice(0, -1);
	let bad = 0;
	for (const ch of decoded) if (ch === "�") bad++;
	return decoded.length > 0 && bad / decoded.length > MAX_REPLACEMENT_RATIO ? "That file doesn't look like a text file." : null;
}

/** Structure facts for the record; throws the learner-facing refusal. */
async function inspect(filePath: string, kind: AttachmentRecord["kind"], bytes: Uint8Array): Promise<Partial<AttachmentRecord>> {
	if (kind === "pdf" || kind === "text") {
		const refused = sniffSource(kind, bytes);
		if (refused) throw new Error(refused);
	}
	if (kind === "text") return { lines: new TextDecoder("utf-8").decode(bytes).split(/\r?\n/).length };
	if (kind === "pdf") {
		const info = await pdfInfo(filePath).catch(() => {
			throw new Error("This PDF can't be opened (damaged or password-protected).");
		});
		return { pages: info.page_count };
	}
	const info = await epubInfo(filePath);
	return { chapters: info.chapters.length, title: info.title };
}

/** Validate, store, inspect and record one file on the chat. */
export async function addChatAttachment(chatId: string, upload: UploadedFile): Promise<AttachmentUploadResult> {
	const chat = stores.chatStore.getChat(chatId);
	if (!chat) return { ok: false, status: 404, error: "Not found" };
	if (attachmentsClosed(chat)) return { ok: false, status: 409, error: ATTACHMENTS_CLOSED_ERROR };
	const { name, bytes } = upload;
	const ext = attachmentExtension(name);
	const type = ATTACHMENT_TYPES[ext];
	if (!type) return { ok: false, status: 422, error: UNSUPPORTED_ATTACHMENT_ERROR };
	if (bytes.byteLength > ATTACHMENT_MAX_BYTES) return { ok: false, status: 422, error: `File is larger than ${formatMb(ATTACHMENT_MAX_BYTES)}.` };
	const id = `att_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
	const file = writeAttachmentFile(chatId, id, ext, bytes);
	let recorded = false;
	try {
		let facts: Partial<AttachmentRecord>;
		try {
			facts = await inspect(attachmentPath(chatId, file), type.kind, bytes);
		} catch (err) {
			return { ok: false, status: 422, error: err instanceof Error ? err.message : String(err) };
		}
		// Re-read: the session may have started (or gone) while the file was inspected.
		const current = stores.chatStore.getChat(chatId);
		if (!current) return { ok: false, status: 404, error: "Not found" };
		if (attachmentsClosed(current)) return { ok: false, status: 409, error: ATTACHMENTS_CLOSED_ERROR };
		const attachment: AttachmentRecord = {
			id,
			name,
			kind: type.kind,
			mimeType: type.mimeType,
			bytes: bytes.byteLength,
			file,
			addedAt: new Date().toISOString(),
			...facts,
		};
		stores.chatStore.addAttachments(chatId, [attachment]);
		recorded = true;
		return { ok: true, attachment };
	} finally {
		// A refused or unrecorded file doesn't stay in the session's folder.
		if (!recorded) removeAttachmentFile(chatId, file);
	}
}

/** The session's files as the agent layer sees them; the one place stored paths are resolved. */
export function sessionAttachments(record: Pick<ChatRecord, "id" | "attachments">): SessionAttachment[] {
	return (record.attachments ?? []).map((r) => ({ record: r, path: attachmentPath(record.id, r.file) }));
}
