import * as fs from "node:fs";
import * as path from "node:path";
import { TEACHING_SOURCE_KINDS, type DigestResult, type DigestToolInput, type SourceKind } from "../core/contracts.ts";
import { newSourceAttachedMessage, type LhMarkerMessage, type SourceAttachedDetails } from "../core/native-messages.ts";
import { sessionAttachments } from "./attachments.ts";
import { startJob } from "./chat-handler.ts";
import { removeSourceDir, sourceDirOf } from "./source-dir.ts";
import { stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";

/**
 * The teaching source (learn-from-a-file on attachments, owner
 * 2026-11-03): at session start the learner may tick ONE uploaded PDF /
 * text attachment as the file the session is taught from. setTeachingSource
 * records it on the chat, writes the source-attached marker as message[0],
 * and starts the DIGEST job server-side — no dispatching tool call. The
 * first prober turn is NOT sent by the client: the digest's finished steer
 * fires it through the wake pipeline, so the prober starts already holding
 * the outline (a failed or aborted digest fires nothing; retryDigest
 * re-runs it on the stored file). Every other attachment stays context.
 */

export type SetTeachingSourceResult = { ok: true } | { ok: false; status: number; error: string };

export function setTeachingSource(chatId: string, attachmentId: string, goalRaw: string | undefined): SetTeachingSourceResult {
	const chat = stores.chatStore.getChat(chatId);
	if (!chat) return { ok: false, status: 404, error: "No such session" };
	if (chat.messages.length > 0 || chat.teachingSourceId)
		return { ok: false, status: 409, error: "The teaching source can only be set when the session starts." };
	if (chat.kind === "practice") return { ok: false, status: 400, error: "A teaching source needs a teach session." };
	const attachment = sessionAttachments(chat).find((a) => a.record.id === attachmentId);
	if (!attachment || !TEACHING_SOURCE_KINDS.includes(attachment.record.kind))
		return { ok: false, status: 400, error: "Only a PDF, .txt or .md file can be the teaching source." };

	const goal = goalRaw?.trim() || undefined;
	const { name } = attachment.record;
	const sourceKind = attachment.record.kind as SourceKind;
	try {
		stores.chatStore.setTeachingSourceId(chatId, attachmentId);
		const dir = sourceDirOf(chatId);
		fs.mkdirSync(dir, { recursive: true });
		const input: DigestToolInput = {
			path: attachment.path,
			sourceKind,
			name,
			outlinePath: path.join(dir, "outline.md"),
			...(goal ? { goal } : {}),
		};
		const toolCallId = `digest_${chatId}`;
		const job = stores.jobStore.createJob({ kind: "digest", chatId, toolCallId, activity: "queued", input });
		stores.chatStore.saveMessages(chatId, [
			newSourceAttachedMessage({ name, sourceKind, jobId: job.id, toolCallId, ...(goal ? { goal } : {}) }),
		]);
		startJob(job.id);
		return { ok: true };
	} catch {
		// All or nothing: the chat and its attachments stay for the client's
		// retry; the source, its job and its outline dir go.
		stores.chatStore.setTeachingSourceId(chatId, undefined);
		stores.jobStore.deleteJobsForChat(chatId);
		removeSourceDir(chatId);
		return { ok: false, status: 500, error: "The teaching source couldn't be set — please retry." };
	}
}

export type RetryDigestResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * Re-run a failed or aborted digest on the stored file (owner, 2026-10-28).
 * A fresh job (new toolCallId) replaces the old one as the card's target:
 * the marker's details are rewritten so the card keeps reading its job by
 * toolCallId. Readability failures are permanent — retrying cannot help.
 */
export function retryDigest(chatId: string): RetryDigestResult {
	const chat = stores.chatStore.getChat(chatId);
	if (!chat) return { ok: false, status: 404, error: "No such session" };
	if (isTurnRunning(chatId)) return { ok: false, status: 409, error: "A turn is running in this session." };
	const markerIndex = chat.messages.findIndex(
		(m) => (m as { customType?: string }).customType === "source-attached",
	);
	if (markerIndex < 0) return { ok: false, status: 400, error: "This session has no attached source." };
	const marker = chat.messages[markerIndex] as unknown as LhMarkerMessage;
	const details = marker.details as SourceAttachedDetails;

	const job = stores.jobStore
		.listJobs(chatId)
		.find((j) => j.kind === "digest" && j.toolCallId === details.toolCallId);
	if (!job || job.status === "running") return { ok: false, status: 409, error: "The source is still being read." };
	if (job.status === "done") return { ok: false, status: 409, error: "The source was already read." };
	if ((job.result as DigestResult | undefined)?.permanent)
		return { ok: false, status: 400, error: job.error || "This file can't be read." };
	const input = job.input as DigestToolInput | undefined;
	if (!input?.path || !fs.existsSync(input.path))
		return { ok: false, status: 410, error: "The stored file is gone — delete this session and try another file." };

	const toolCallId = `digest_${chatId}_${Date.now().toString(36)}`;
	const next = stores.jobStore.createJob({ kind: "digest", chatId, toolCallId, activity: "queued", input });
	const messages = chat.messages.map((m, i) =>
		i === markerIndex ? ({ ...marker, details: { ...details, jobId: next.id, toolCallId } } as unknown as typeof m) : m,
	);
	stores.chatStore.saveMessages(chatId, messages);
	startJob(next.id);
	return { ok: true };
}
