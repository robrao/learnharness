/** The source card (learn-from-a-file, 2026-10-28).
 *  The card's state is the digest job's, read from JobsContext by toolCallId. */
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { describe, it } from "node:test";
import { SourceCard, sourceCardState } from "../components/source-card.tsx";
import { JobsContext } from "../components/jobs-context.ts";
import { DIGEST_ABORTED_ERROR, type DigestResult, type JobRecord } from "../src/core/index.ts";

const DATA = { name: "Calc.pdf", sourceKind: "pdf" as const, jobId: "job_1", toolCallId: "digest_c1", goal: "pass the exam" };

function job(patch: Partial<JobRecord>): JobRecord {
	return { id: "job_1", kind: "digest", chatId: "c1", toolCallId: "digest_c1", status: "running", activity: "starting", createdAt: "", updatedAt: "", ...patch };
}

function render(jobs: JobRecord[]) {
	return renderToStaticMarkup(React.createElement(JobsContext.Provider, { value: jobs }, React.createElement(SourceCard, { chatId: "c1", data: DATA })));
}

describe("SourceCard", () => {
	it("running: shows the file, the live activity line and the goal", () => {
		const html = render([job({ activity: "source_extract: 1-5" })]);
		assert.match(html, /Calc\.pdf/);
		assert.match(html, /source_extract: 1-5/);
		assert.match(html, /Goal: pass the exam/);
		assert.ok(!html.includes("source-card-error"));
	});

	it("no job in the feed yet: still a quiet 'reading source'", () => {
		assert.match(render([]), /reading source/);
	});

	it("done: outline ready", () => {
		assert.match(render([job({ status: "done" })]), /outline ready/);
	});

	it("failed: the reason, Retry, or delete", () => {
		const html = render([job({ status: "error", error: "the model call failed" })]);
		assert.match(html, /source-card-error/);
		assert.match(html, /the model call failed/);
		assert.match(html, /data-testid="source-card-retry"/);
		assert.match(html, /or delete this session and try another file\./);
	});

	it("aborted: reading stopped + Retry", () => {
		const html = render([job({ status: "error", error: DIGEST_ABORTED_ERROR })]);
		assert.match(html, /Reading stopped\./);
		assert.match(html, /data-testid="source-card-retry"/);
		assert.ok(!html.includes("delete this session"));
	});

	it("permanent: the reason and delete guidance — no Retry", () => {
		const result = { outline: "Digest failed: x", consulted: [], permanent: true } as unknown as DigestResult;
		const html = render([job({ status: "error", error: "the PDF has no readable text layer", result })]);
		assert.match(html, /no readable text layer/);
		assert.match(html, /Delete this session and try another file\./);
		assert.ok(!html.includes("source-card-retry"));
	});

	it("a11y: the status is a polite live region; the error body is an alert", () => {
		assert.match(render([]), /aria-live="polite"/);
		assert.match(render([job({ status: "error", error: "boom" })]), /data-testid="source-card-error" role="alert"/);
	});

	it("sourceCardState covers every state", () => {
		assert.equal(sourceCardState(null), "running");
		assert.equal(sourceCardState(job({})), "running");
		assert.equal(sourceCardState(job({ status: "done" })), "done");
		assert.equal(sourceCardState(job({ status: "error", error: DIGEST_ABORTED_ERROR })), "aborted");
		assert.equal(sourceCardState(job({ status: "error", result: { permanent: true } })), "permanent");
		assert.equal(sourceCardState(job({ status: "error", error: "x" })), "failed");
	});
});
