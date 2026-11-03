import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { evictPdfCache } from "../agent/subagents/pdf-ops.ts";
import { evictLineCache } from "../agent/subagents/source-ops.ts";

/** Where a session with a teaching source keeps its digest outline (the
 *  file itself is a shared attachment blob). Its own tiny module: session
 *  deletion (chats.ts) needs it without pulling in the job-starting flow
 *  (sources.ts → chat-handler). */
export function sourceDirOf(chatId: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(chatId)) throw new Error(`Invalid chat id: ${chatId}`);
	return path.join(PATHS.sources, chatId);
}

/** Remove a session's outline dir (session deletion), and drop the reader
 *  caches keyed on its paths. */
export function removeSourceDir(chatId: string): void {
	const dir = sourceDirOf(chatId);
	if (fs.existsSync(dir)) {
		for (const entry of fs.readdirSync(dir)) {
			const p = path.join(dir, entry);
			evictPdfCache(p);
			evictLineCache(p);
		}
	}
	fs.rmSync(dir, { recursive: true, force: true });
}
