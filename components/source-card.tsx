"use client";

import { useContext, useState } from "react";
import { CheckIcon, CircleAlertIcon, FileTextIcon } from "lucide-react";
import { DIGEST_ABORTED_ERROR, type DigestResult, type JobRecord, type SourceAttachedDetails } from "@/src/core";
import { JobsContext } from "@/components/jobs-context";
import { BrailleSpinner } from "@/components/braille-spinner";

/**
 * The source card (learn-from-a-file, 2026-10-28): message[0] of a session
 * started from an uploaded file. Scaffolding, not a turn — quiet, muted.
 * Its state is the digest job's, read live from the jobs feed by toolCallId
 * (a retry rewrites the marker's toolCallId to the new job):
 * running → the activity line; done → outline ready; aborted → "reading
 * stopped" + Retry; failed → the reason + Retry, or delete; permanent (the
 * file itself is unreadable) → the reason + delete only. No turn fires
 * without an outline, so a failed session waits on the learner.
 */
export type SourceCardState = "running" | "done" | "aborted" | "permanent" | "failed";

export function sourceCardState(job: JobRecord | null): SourceCardState {
	if (!job || job.status === "running") return "running";
	if (job.status === "done") return "done";
	if (job.error === DIGEST_ABORTED_ERROR) return "aborted";
	if ((job.result as DigestResult | undefined)?.permanent) return "permanent";
	return "failed";
}

export function SourceCard({ chatId, data }: { chatId: string; data: SourceAttachedDetails }) {
	const jobs = useContext(JobsContext);
	const job = jobs.find((j) => j.toolCallId === data.toolCallId) ?? null;
	const state = sourceCardState(job);
	const [retrying, setRetrying] = useState(false);
	const [retryError, setRetryError] = useState<string | null>(null);
	const errored = state === "aborted" || state === "permanent" || state === "failed";
	const reason = job?.error || "The digest failed.";

	const retry = async () => {
		setRetrying(true);
		setRetryError(null);
		try {
			const res = await fetch(`/api/chats/${chatId}/source/retry`, { method: "POST" });
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: unknown };
				setRetryError(typeof body.error === "string" ? body.error : `Retry failed (HTTP ${res.status}).`);
			}
		} catch {
			setRetryError("Couldn’t reach the app. Try again.");
		} finally {
			setRetrying(false);
		}
	};

	const retryButton = (
		<button
			type="button"
			data-testid="source-card-retry"
			disabled={retrying}
			onClick={() => void retry()}
			className="cursor-pointer rounded-sm border border-border bg-card px-2 py-0.5 font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
		>
			Retry
		</button>
	);

	return (
		<div data-testid="source-card" className="my-1 rounded-lg border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground">
			<div className="flex items-center gap-2">
				{errored ? <CircleAlertIcon aria-hidden="true" className="size-3.5 shrink-0 text-red-500" /> : state === "done" ? <CheckIcon aria-hidden="true" className="size-3.5 shrink-0" /> : <FileTextIcon aria-hidden="true" className="size-3.5 shrink-0" />}
				<span className="font-medium text-foreground/80">{data.name}</span>
				<span aria-live="polite" className="min-w-0 flex-1 truncate">
					{state === "aborted" ? "reading stopped" : errored ? "couldn't be read" : state === "done" ? "outline ready" : (
						<span className="inline-flex items-center gap-1.5">
							<BrailleSpinner />
							{job?.activity || "reading source"}
						</span>
					)}
				</span>
			</div>
			{errored && (
				<div data-testid="source-card-error" role="alert" className="mt-1.5 flex flex-wrap items-center gap-1.5 leading-relaxed">
					{state === "aborted" ? (
						<>
							<span>Reading stopped.</span>
							{retryButton}
						</>
					) : state === "permanent" ? (
						<span>{reason} Delete this session and try another file.</span>
					) : (
						<>
							<span>{reason}</span>
							{retryButton}
							<span>or delete this session and try another file.</span>
						</>
					)}
				</div>
			)}
			{retryError && <div data-testid="source-card-retry-error" className="mt-1.5 text-destructive">{retryError}</div>}
			{data.goal && <div className="mt-1.5 leading-relaxed">Goal: {data.goal}</div>}
		</div>
	);
}
