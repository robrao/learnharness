/**
 * Session files — the fs adapter for files uploaded when a session starts
 * (teaching-source spec rev 2, S7). Each session owns a folder,
 * data/attachments/<chatId>/, holding one `<attachmentId><ext>` per upload;
 * the chat record's AttachmentRecord.file names it. The learner's original
 * name rides the record only, so no learner-chosen string becomes a path.
 * Nothing is shared across sessions: deleting the session removes the folder.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";

const CHAT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const FILE_PATTERN = /^att_[0-9a-f]{12}\.[a-z0-9]+$/;

/** The session's folder (absolute; may not exist yet). */
export function attachmentDirOf(chatId: string): string {
	if (!CHAT_ID_PATTERN.test(chatId)) throw new Error(`Invalid chat id: ${chatId}`);
	return path.join(PATHS.attachments, chatId);
}

/** Absolute path of one stored file, by its stored name. */
export function attachmentPath(chatId: string, file: string): string {
	if (!FILE_PATTERN.test(file)) throw new Error(`Invalid attachment file: ${file}`);
	return path.join(attachmentDirOf(chatId), file);
}

/** Store the bytes as `<id><ext>` in the session's folder; returns the stored
 *  name. Written to a temp name and renamed in, so a reader never sees a
 *  partial file. */
export function writeAttachmentFile(chatId: string, id: string, ext: string, bytes: Uint8Array): string {
	const file = `${id}${ext}`;
	const target = attachmentPath(chatId, file);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const tmp = `${target}.tmp-${crypto.randomUUID()}`;
	try {
		fs.writeFileSync(tmp, bytes);
		fs.renameSync(tmp, target);
	} catch (err) {
		fs.rmSync(tmp, { force: true });
		throw err;
	}
	return file;
}

/** Delete one stored file (a refused or unrecorded upload). */
export function removeAttachmentFile(chatId: string, file: string): void {
	fs.rmSync(attachmentPath(chatId, file), { force: true });
}

/** Delete the session's folder and everything in it. */
export function removeChatAttachments(chatId: string): void {
	fs.rmSync(attachmentDirOf(chatId), { recursive: true, force: true });
}
