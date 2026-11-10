# Learn-from-a-file: hardening spec

**Branch:** `feat/learn-from-source-file` (follows commit `1eb18a2`)
**Status:** decisions approved by the owner on 2026-10-28; ready to implement
**Goal:** fix the correctness gaps in the learn-from-a-file feature, make the text the model sees accurate, and close the remaining UX and performance gaps.

Each decision below records the owner's answer. Implementation should follow this document mechanically. If something here turns out to be ambiguous or wrong against the code, stop and ask the owner. Don't guess (AGENTS.md).

---

## 0. Owner decisions (summary)

| # | Question | Decision |
|---|---|---|
| D1 | What happens when the learner aborts the digest? | **No turn starts.** The abort is recorded and nothing is delivered. The card shows "aborted". |
| D2 | Check uploaded content, not just the extension? | **Yes.** A PDF must start with `%PDF-`. A text file is rejected if its first 8 KB contain a NUL byte, or if more than 1% of the decoded characters in those 8 KB are `U+FFFD`. |
| D3 | The first turn sees the marker and the steer, which say nearly the same thing | **The `source-attached` marker becomes UI-only** (never sent to the model). The digest steer is the only model context. |
| D4 | Retry after a failed digest? | **Yes.** Add a Retry button backed by a new retry route. |
| D5 | How does the card find the new job after a retry? | **The retry route rewrites the marker's `details.jobId` and `details.toolCallId`.** The card keeps looking up its job by `toolCallId`. |
| D6 | Show Retry for failures a retry can't fix? | **No.** Failures from the readability check (no text layer, empty file, garbage bytes) are marked permanent, and the card shows only the delete guidance for them. |
| D7 | Card text when a digest fails | Error: `<reason>` + **[Retry]** + "or delete this session and try another file." Aborted: "Reading stopped." + **[Retry]**. Permanent failure: `<reason>` + "Delete this session and try another file." (no Retry). |
| D8 | Graph picks and a file attachment together | **They can't coexist.** While a file is attached, the "Pick nodes"/"N nodes selected" chip is disabled. While picks exist, the paperclip is disabled and shows the hint "Clear your picks to attach a file." |
| D9 | Learner switches teach → practice with a file attached | **The attachment is cleared.** |
| D10 | Pronouns in new model-facing text | **"he/his"**, matching `prober/10-probe-doctrine.md`. |
| D11 | The unused `pages` value returned by `sourceSearchText` | **Use it.** The digest records which parts of the source it consulted. |
| D12 | Unit for `consulted` | **Pages for a PDF, lines for a text file.** The unit follows `sourceKind`. |
| D13 | How `consulted` is stored | **`consulted: string[]` of merged range strings**, e.g. `["1-40", "120-180"]`. |
| D14 | What counts as consulted | **Units returned by `source_extract`, plus the pages/lines of the `source_search` hits actually shown** (after the 40-hit cap). `source_info` adds nothing. |
| D15 | Drag-and-drop onto the composer | **Out of scope.** |
| — | Data only, or shown in the UI? | `consulted` is **data only**: no UI. |

### Names this spec introduces

The owner may veto any of these before implementation starts.

- `DigestResult.consulted: string[]`
- `DigestResult.permanent?: true`: set only on failures from the readability check
- `pdfPageTexts(filePath)`: a cached page-text reader in `pdf-ops.ts`
- `digestFailure(input, reason, opts?)`: exported from `digest.ts`
- `mergeRanges(nums: number[]): string[]`: in `source-ops.ts`
- `retryDigest(chatId)` in `src/server/sources.ts`, and the route `POST /api/chats/[id]/source/retry`
- `SOURCE_UPLOAD_MAX_LABEL = "50 MB"` in `src/core/contracts/jobs.ts`
- `DIGEST_ABORTED_ERROR = "Aborted by learner"` (shared constant; see §1.1)

---

## 1. Correctness

### 1.1 Digest abort starts no turn (D1)

**Problem:** `abortJob` (`src/server/jobs.ts:431-449`) always writes `delivery: { kind: "abort", status: "pending" }` and calls `deliverJobResult(buildAbortSteer(job))`. For a digest, that starts a prober turn with no outline, which breaks the rule in `finishJob` that a failed digest is owed no turn.

**Change:**
1. In `abortJob`, after the `job.result` guard, add:
   ```ts
   if (job.kind === "digest") {
     fireJobAbort(jobId);
     stores.jobStore.updateJob(jobId, { status: "error", error: DIGEST_ABORTED_ERROR, activity: "aborted" });
     return { ok: true };
   }
   ```
   Don't set `delivery`, and don't call `deliverJobResult`.
2. Replace the literal `"Aborted by learner"` in `abortJob` with the exported constant `DIGEST_ABORTED_ERROR`. Put it in `src/core/contracts/jobs.ts` so the client can import it.
3. Delete the `kind === "digest"` branch of `abortText` in `src/core/contracts/jobs.ts`. It can no longer be reached. Make sure `abortText`'s fallthrough still type-checks.
4. `SourceCard`: when `job.status === "error" && job.error === DIGEST_ABORTED_ERROR`, render the aborted state (§3.1).

### 1.2 One helper for every digest failure

**Problem:** `runner.ts` builds the digest failure object inline in three places (`refuse`, missing input, the catch in `runDigestJob`). The missing-input one records `name: ""`, `path: ""` and no goal.

**Change:**
- Export `digestFailure(input: Partial<DigestToolInput>, reason: string, opts?: { permanent?: boolean }): DigestResult` from `src/agent/subagents/digest.ts`, replacing the private `failure()`. It always sets `consulted: []`, and sets `permanent: true` only when `opts.permanent` is true.
- Use it in `digest.ts` and at all three sites in `runner.ts`. Pass whatever input is available (`resolveInput(job, input)` / `ctx.job.input`).

### 1.3 Don't write the outline after an abort

**Problem:** an abort can land between `streamOnce` returning and `finish()` writing. Since an aborted job is no longer `running`, the session can be deleted in that gap, and `fs.mkdir(..., { recursive: true })` then recreates `data/sources/<id>/`.

**Change:** pass `opts.abortSignal` into `finish()`. At the top of `finish()`, before `mkdir` and `writeFile`: if the signal is aborted, throw an `Error` with `name = "AbortError"`. `runDigestAgent` already rethrows when `opts.abortSignal?.aborted`.

### 1.4 Check content, not just the extension (D2)

**Where:** `createSourceSession` in `src/server/sources.ts`, after the truncation check (`bytes.length !== file.size`) and before anything else happens.

**Change:** add a pure helper in `sources.ts`:
```ts
/** null when the bytes plausibly match the kind, else the learner-facing reason. */
export function sniffSource(kind: SourceKind, bytes: Buffer): string | null
```
- `pdf`: `bytes.subarray(0, 5).toString("latin1") === "%PDF-"`. Otherwise: `"That file doesn't look like a PDF."`
- `text`: take `head = bytes.subarray(0, 8192)`.
  - If `head.includes(0)`, return `"That file doesn't look like a text file."`
  - Otherwise decode `head` with `new TextDecoder("utf-8")` (not fatal). Drop a trailing `U+FFFD`, because a multibyte character can be split at the 8 KB boundary. If the remaining `U+FFFD` count is more than 1% of the decoded length, return the same message.
- A non-null result → `{ ok: false, status: 400, error }`.

### 1.5 Store the upload atomically

**Problem:** `createSourceSession` creates the chat, then writes the file, then creates the job. If the write throws, the chat is left behind with no marker and no job. The route also has no try/catch, so the throw is unhandled.

**Change (in `createSourceSession`):**
1. Do all validation first (kind, size, truncation, sniff).
2. Write the bytes to a temp file: `path.join(PATHS.sources, ".incoming", `${randomUUID()}${ext}`)` (`mkdirSync` the folder first).
3. Create the chat and stamp its model settings, as today.
4. `mkdirSync(sourceDirOf(chat.id))`, then `renameSync(temp, storedPath)`.
5. Create the job, save the marker, `startJob`.
6. Wrap steps 2–5 in try/catch. On any throw:
   - remove the temp file (`rmSync(..., { force: true })`);
   - if the chat was created, call `stores.chatStore.deleteChat(chat.id)`, `stores.jobStore.deleteJobsForChat(chat.id)` and `removeSourceDir(chat.id)`;
   - return `{ ok: false, status: 500, error: "The file couldn't be saved — please retry." }`.

**Route (`app/api/chats/source/route.ts`):** wrap the `createSourceSession` call in try/catch. Anything that escapes becomes `Response.json({ error: "The upload failed — please retry." }, { status: 500 })`.

---

## 2. Model-facing text

### 2.1 The `source-attached` marker becomes UI-only (D3)

**Change:**
1. `toLlmMessages` (`src/core/native-messages.ts`, at the UI-only skip near line 634): add `"source-attached"` to the skip list next to `"plan-block"` and `"problem-dismissed"`, and update the comment.
2. `newSourceAttachedMessage`: remove the `storedPath` parameter. Set `content` to a short, path-free string for display only: `` `Attached "${details.name}" to learn from.` ``. Update its doc comment: the marker is UI-only, and the steer carries all model context.
3. `createSourceSession`: update the call site.
4. Leave `nativeInputCause`'s handling of `"source-attached"` (`"neutral"`) as it is.

### 2.2 Remove the stored source path from the steer

**Change:** in `digestSteerText` (`src/core/contracts/jobs.ts`), replace the path sentence with:
```
Read raw ${pages|lines} with the source_* tools. The outline below is also saved at ${r.outlinePath} — re-read it there any time.
```
`r.path` must not appear anywhere in model-facing text. Keep `outlinePath`, because `teacher/15-source-planning.md` tells the teacher to `read` it.

### 2.3 Use "he/his" in the new model text (D10)

- In `digestSteerText`:
  - `Their goal: ${r.goal}` → `His goal: ${r.goal}`
  - `They gave no goal — ask what they want from it as part of probing.` → `He gave no goal — ask what he wants from it as part of probing.`
- In `src/agent/prompts/prober/20-source-probing.md`, change the first bullet to: "His goal is in the source context above the outline; if he gave none, make it concrete with `ask_user_question` first (which chapters, what for)." This also fixes a factual error: the goal isn't in the outline.
- `teacher/15-source-planning.md` already uses "he/him". No change.

---

## 3. UX

### 3.1 Source card states (D4, D6, D7)

`components/source-card.tsx`: derive the state from the job found by `data.toolCallId`.

| State | Condition | Icon | Status text | Body |
|---|---|---|---|---|
| running | no job, or `status === "running"` | `FileTextIcon` + spinner | `job.activity` or "reading source" | — |
| done | `status === "done"` | `CheckIcon` | "outline ready" | — |
| aborted | `status === "error"` and `error === DIGEST_ABORTED_ERROR` | `CircleAlertIcon` | "reading stopped" | "Reading stopped." **[Retry]** |
| permanent | `status === "error"` and `(job.result as DigestResult)?.permanent` | `CircleAlertIcon` | "couldn't be read" | `<reason>` "Delete this session and try another file." |
| failed | any other `status === "error"` | `CircleAlertIcon` | "couldn't be read" | `<reason>` **[Retry]** "or delete this session and try another file." |

- `<reason>` is `job.error || "The digest failed."`
- **Retry button:** `type="button"`, `data-testid="source-card-retry"`. It calls `POST /api/chats/${chatId}/source/retry`, so `SourceCard` needs the chat id as a new prop `chatId` passed from `components/chat.tsx`, unless one is already available in context there; check first. While the request is in flight, disable the button. On a non-OK response, show the server's `error` inline under the button. On success, do nothing more: the jobs feed and the rewritten marker re-render the card as running.
- **Accessibility:** the status `<span>` gets `aria-live="polite"`. The error/aborted body `<div>` gets `role="alert"`.
- Keep the `Goal: …` line as it is.

### 3.2 Retry route (D4, D5, D6)

**Server function, `retryDigest(chatId: string)` in `src/server/sources.ts`.** It returns `{ ok: true } | { ok: false; status: number; error: string }`.
1. 404 if the chat doesn't exist.
2. 409 if `isTurnRunning(chatId)`.
3. Find the marker: the first message with `customType === "source-attached"`. 400 if missing.
4. Find the current digest job: `jobStore.listJobs(chatId)` filtered to `kind === "digest"` with `toolCallId === marker.details.toolCallId`. Then:
   - 409 if missing or `status === "running"`;
   - 409 if `status === "done"`;
   - 400 with the job's error if `(job.result as DigestResult)?.permanent`.
5. 410 `"The stored file is gone — delete this session and try another file."` if the input's `path` isn't on disk.
6. Create a new job with the same `input`, `toolCallId: `digest_${chatId}_${Date.now().toString(36)}``, and `activity: "queued"`.
7. Rewrite the marker: build a new messages array in which that one marker's `details` gets `jobId` and `toolCallId` replaced, and save it with `stores.chatStore.saveMessages(chatId, messages)`.
8. `startJob(newJob.id)`, then return `{ ok: true }`.

**Route:** `app/api/chats/[id]/source/retry/route.ts`. Follow the signature in `app/api/chats/[id]/dismiss/route.ts`: `POST(req, ctx: { params: Promise<{ id: string }> })` and `await ctx.params`. Read the relevant guide in `node_modules/next/dist/docs/` before writing the handler (AGENTS.md). Response: `Response.json(result.ok ? { ok: true } : { error }, { status })`.

Leave the old failed job in the store; the activity dock may show it. That's intended.

### 3.3 Marking permanent failures (D6)

In `runDigestAgent`, when `sourceUnreadable` returns a reason: `return digestFailure(input, unreadable, { permanent: true })`. No other failure path sets `permanent`.

### 3.4 Graph picks and file attachment can't coexist (D8)

In `components/home.tsx`:
- The **paperclip button** gets `disabled={practiceProps.length > 0}`. When disabled:
  - `title` and `aria-label` are "Clear your picks to attach a file";
  - add `disabled:cursor-not-allowed disabled:opacity-40`.
- The **picker chip**: `NodePickerControl` (`components/composer-actions.tsx:23`) gets a new optional `disabled?: boolean` prop. It goes on both the chip button and the Clear button, with the same disabled styling and the `title` "Remove the attached file to pick nodes". Home passes `disabled={mode === "teach" && attached !== null}`.
- Add a guard in `begin()`: if `file && practiceProps.length > 0`, return without doing anything. The UI should make this unreachable; the guard is a backstop.

### 3.5 Clear the attachment on switch to practice (D9)

Wherever Home changes `mode` (find each `setMode` call): when the new mode is `"practice"`, also `setAttached(null)` and `setUploadError(null)`. A small `changeMode(next)` wrapper is fine if there's more than one call site.

### 3.6 Drag-and-drop: out of scope (D15)

---

## 4. Consulted tracking (D11–D14)

### 4.1 Contract

`DigestResult` (`src/core/contracts/jobs.ts`) gains:
```ts
/** What the digest actually read — merged ranges in the source's unit
 *  (pages for pdf, lines for text), e.g. ["1-40", "120-180"]. */
consulted: string[];
/** Set only on readability-gate failures: retrying cannot help. */
permanent?: true;
```
Every place that builds a `DigestResult` (`finish`, `digestFailure`, the steer test fixtures) must set `consulted`.

### 4.2 Range helper

In `source-ops.ts`:
```ts
/** Sorted-unique numbers → merged range strings: [1,2,3,5] → ["1-3","5"]. */
export function mergeRanges(nums: Iterable<number>): string[]
```

### 4.3 Collecting the numbers

- `sourceExtractText` returns `{ text: string; units: number[] }`. `units` is the pages or lines actually included before the 24,000-character cap cut the text off. For a PDF, base this on the page texts from §5.1, so `pdfExtract` doesn't need changing. Update the source tools (`src/agent/tools/source.ts`) to use `.text`.
- `sourceSearchText` keeps returning `{ body, pages }` but renames the field to `units`. For a PDF it holds the pages of the hits shown (after `SEARCH_HIT_CAP`). It currently counts *all* hits, which is wrong per D14. For text, it holds the hit line numbers shown (not the ±2 context lines).
- In `runDigestAgent`, keep a `Set<number>`. Add `units` from every extract and search call; `source_info` adds nothing. `finish()` sets `consulted: mergeRanges(set)`.
- The existing `consulted` boolean (used by the read-before-outline nudge) can become `set.size > 0`, but keep today's behavior: an extract counts as reading even if it returned zero units. So keep the boolean, or track "made a read call" separately.

No UI change.

---

## 5. Performance

### 5.1 Cache page texts

**Problem:** every `source_info`, `source_extract` and `source_search` call during a live prober or teacher turn re-opens and re-parses the PDF.

**Change (in `src/agent/subagents/pdf-ops.ts`):**
```ts
/** Per-page text, cached by path + mtime (small LRU, 4 entries). */
export async function pdfPageTexts(filePath: string): Promise<string[]>
export function evictPdfCache(filePath?: string): void
```
- Cache key: `filePath`. Each entry stores `mtimeMs` and is invalidated when `fs.statSync(filePath).mtimeMs` changes.
- `pdfTextProfile` becomes `{ page_count: texts.length, text_lengths: texts.map(t => t.length) }` built on `pdfPageTexts`.
- In `source-ops.ts`, PDF `info`, `extract` and `search` read from `pdfPageTexts`:
  - **extract:** format with the same `--- Page N ---` header `pdfExtract` uses (check its exact output and match it).
  - **search:** a case-insensitive literal substring match per line within each page. Output must stay `=== Page P, line L ===\n<context>` with 2 lines of context, matching today's `pdfSearch` output. Verify against the existing PDF fixture test.
- Don't change `pdfExtract` or `pdfSearch` themselves; the pdf-reader still uses them.
- `removeSourceDir` calls `evictPdfCache(path.join(dir, "source.pdf"))`.

### 5.2 Open the PDF once in the readability check

In `sourceUnreadable`, remove the `pdfProbe` call and keep only the profile. `pdfPageTexts` throws on a bad PDF, which the existing catch turns into the reason. Then confirm that the existing test "the readability gate: garbage PDF…" still passes.

### 5.3 Cache text-file lines

`readLines` gets the same treatment: a cache keyed on path + mtime, with 4 entries.

---

## 6. Code quality

1. **Shared `streamOnce`:** export `streamOnce` from `src/agent/subagents/pdf-reader.ts:397`. Import it in `digest.ts`, then delete the copy and its "duplicated because…" comment. If the two signatures differ, stop and ask.
2. **One range parser:** compare `parseRangeSpec` (`source-ops.ts`) with `parsePageSpec` (`pdf-ops.ts:141`). If their behavior is identical for every input in §6.3, delete `parseRangeSpec` and use `parsePageSpec`, with a re-export if the name helps. If not, keep both and add a one-line comment explaining the difference.
3. **Range errors:** the chosen parser returns an error for bad specs instead of selecting nothing silently.
   - `"5-3"` → treat as `3-5`.
   - `"5-"`, `"-3"` and any part that parses to `NaN` → `sourceExtractText` returns `ERROR: bad range "<part>" — use 'all', '1-5', '1,3,7' or '3'.` (the `ERROR:` prefix marks `isError` in `digest.ts`).
   - If changing `parsePageSpec` would alter pdf-reader behavior, add the validation in `source-ops.ts` before the call.
4. **Shared type:** `SourceAttachedDetails.sourceKind` uses the `SourceKind` type.
5. **Missing blank line:** add one before the `pdfTextProfile` doc comment in `pdf-ops.ts` (if the function survives §5.1).
6. **Shared size label:** export `SOURCE_UPLOAD_MAX_LABEL = "50 MB"` next to `SOURCE_UPLOAD_MAX_BYTES`. Use it in both the client (`components/start-source-session.ts`) and the server (`sources.ts`) for "The file is over the … limit."

---

## 7. Tests

The existing tests that must change are listed first; new tests follow.

### Existing tests to update (`tests/source-sessions.test.ts`)
- **Digest steer test:** `/Their goal: pass the exam/` → `/His goal: pass the exam/`; `/no goal/` still matches. The `result` fixture gains `consulted: []`.
- **"a finished digest…" test:**
  - `/Their goal: learn derivatives/` → `/His goal/`.
  - The wire assertion `["user","user"]` → `["user"]` (the marker is UI-only now).
  - Add: `result.consulted` deep-equals `["1-6"]`.
- **Source-ops tests:** update them for the `{ text, units }` and `units` return shapes.

### New tests in `tests/source-sessions.test.ts`
1. **Digest abort (D1):** start a digest on a faux engine that never resolves (or a slow script), then call `abortJob`. Assert:
   - the job is `status: "error"`, `error === DIGEST_ABORTED_ERROR`, with no `delivery`;
   - the turn runner is never called;
   - the record still has 1 message.
2. **Content sniffing (D2):**
   - a `.pdf` without `%PDF-` → 400;
   - a `.txt` with a NUL byte → 400;
   - a `.txt` of valid UTF-8 → 200;
   - unit-test `sniffSource` at the boundary: a split multibyte character at 8192 bytes passes, and 2% `U+FFFD` fails.
3. **Atomic store:** force `renameSync` to fail (point `PATHS.sources` at a read-only folder, or stub through a test seam if one exists; if no seam exists, ask before adding one). Assert that no chat, no job and no source folder remain, and the route returns a JSON 500.
4. **Range errors:** `"5-"`, `"-3"` and `"x"` return `ERROR: bad range`; `"5-3"` returns lines 3–5.
5. **Source tools reach the agents:**
   - a chat whose digest is `done` → the tool set built by `handleChatInput` for the prober and teacher contains `source_info`, `source_extract` and `source_search`;
   - a chat whose digest is `error` → it contains none of them.
   - Use whatever seam the existing chat-handler tests use to inspect the tool registry. If none exists, ask.
6. **No path leak:** neither `toLlmMessages(record)` nor the steer `content` contains `/sources/<id>/source.`
7. **Restart recovery:** create a digest job with `input`, then call `jobRunner.runJob(jobId)` with no input, the way `setJobRespawn` does. Assert it completes and writes `outline.md`.
8. **Retry route:**
   - after a model-refusal failure, the retry returns 200, the marker's `details.toolCallId` changes, and a new job runs to `done` and starts the first turn;
   - refused with 409 while a digest is running and with 409 when it's done;
   - refused with 400 for a `permanent` failure;
   - refused with 410 when the stored file is deleted.
9. **Consulted (D12–D14):**
   - a text extract of `"1-3"` plus a search hitting line 6 → `["1-3", "6"]`;
   - `source_info` alone adds nothing;
   - PDF search counts only the hits shown;
   - unit-test `mergeRanges`.
10. **Cache:**
    - a second `source_info` on the same PDF doesn't re-open the document (count opens through a test hook or a spy);
    - touching the file (changing its mtime) invalidates the entry.
11. **Permanent flag:** a digest of `not-a-pdf.txt` stored as `.pdf` gives `result.permanent === true`. A model failure leaves `permanent` unset.

### New tests in `tests/render-source-card.test.tsx`
12. The aborted state renders "Reading stopped." and `source-card-retry`.
13. The failed state renders the reason, `source-card-retry`, and "or delete this session and try another file."
14. The permanent state renders the reason and the delete guidance, and **no** `source-card-retry`.
15. The status span has `aria-live="polite"`, and the error body has `role="alert"`.

### Home (where existing Home render tests live; add a file if there are none)
16. With picks present, the paperclip is disabled and has the hint text.
17. With a file attached in teach mode, `practice-props-chip` is disabled.
18. Switching to practice clears the attachment, so `attached-file` is gone after switching back.

### Final check
Run `npm test`, `npm run lint` and `npm run typecheck`. The full suite must pass, not just the touched files.

---

## 8. Implementation order

1. §1.2 (`digestFailure`), §4.1 (contract fields). Other sections depend on these.
2. §1.1, §1.3, §3.3. Abort and permanent semantics.
3. §2.1–§2.3. Model text.
4. §1.4, §1.5. Upload hardening.
5. §5.1–§5.3, §4.2–§4.3. Caching and consulted tracking. These touch the same functions, so do them together.
6. §3.2 then §3.1. Retry route, then the card.
7. §3.4, §3.5. Home.
8. §6. Cleanup.
9. §7. Tests: update the existing ones alongside each step, and add the new ones as each step lands.

Commit after each numbered step, with conventional-commit messages matching the repo (`fix:`, `feat:`, `refactor:`, `test:`).
