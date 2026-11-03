# Teaching source on top of session attachments (#435)

**Branch:** `feat/teaching-source`, based on PR #435's head (`50ba4e5`, itself up to date with `upstream/main` at `e69e852`). This branch is stacked on an unmerged PR. `feat/learn-from-source-file` stays as the reference implementation.
**Status:** DRAFT. Waiting for owner approval. Implementation starts once the owner approves this document.
**Goal:** combine #435 (attach images, PDFs and EPUBs to a session as context) with learn-from-a-file. When the learner starts a session, they can tick one uploaded file as the **teaching source**. The digest job reads that file into an outline, and the outline drives the probe and the plan. Every other upload, at any time, is **context**, as in #435. `.txt` and `.md` become attachable everywhere.

Implementation should follow this document mechanically. It was checked against #435 at `50ba4e5`. If #435 changes (new pushes, review changes) and contradicts anything below, stop and ask the owner. Don't guess (AGENTS.md).

---

## 0. Owner decisions (2026-11-03)

| # | Question | Decision |
|---|---|---|
| T1 | When can a file be marked as the teaching source? | **Only when the session starts** (Home and `/chat/new`). Any upload inside a running session is context, even during the probe. |
| T2 | How many teaching sources? | **Exactly one at most.** Ticking a second file unticks the first. |
| T3 | Checkbox default | **Unticked.** Uploads are context unless the learner opts in. |
| T4 | Which types can be the teaching source? | **PDF, `.txt`, `.md`.** EPUBs and images can be context only. |
| T5 | `.txt`/`.md` as context? | **Yes, everywhere**, including mid-session. The agent reads them with text reader tools (§4). |
| T6 | Removing the teaching source | **Not possible.** The Files panel shows it with a "Teaching source" badge and no Remove button. Deleting the session is the only way out. |
| T7 | Should the agent be limited to the source? | **Not in this spec.** As on our branch: the source drives the probe and the plan, the prompts ask the agent to ground in it and cite it, and `research` stays available. Restrictions can come in a follow-up spec. |
| T8 | Git base | **Build on #435 now** (owner changed this on 2026-11-03; it was "wait for #435 to merge"). New branch `feat/teaching-source` from #435's head, in the same checkout. |
| T9 | Staged WIP on `feat/learn-from-source-file` | **Leave it untouched.** It is in the named stash "feat/learn-from-source-file staged WIP (left untouched, T9)", to be popped with `--index` when switching back. This design supersedes it (`components/source-attach.tsx`, the composer and new-session paperclip, `tests/isolate-data.ts`). |
| T10 | Practice mode | **Teach mode only.** In practice mode the checkbox is hidden. Switching teach → practice unticks it, and the file stays attached as context. |
| T11 | Graph picks and a teaching source together | **Not allowed together** (D8 carries over). While picks exist, the checkbox is disabled with the hint "Clear your picks to use a file as the teaching source". While it's ticked, the picks chip is disabled. Context files can coexist with picks. |
| T12 | Read tools for the probe and teach agents | **#435's tools, plus text equivalents.** Our `source_*` agent tools go. A source PDF is read with `pdf_*` like any attachment. `.txt`/`.md` files (source or context) get new `text_*` tools. The digest sub-agent keeps its own internal `source_*` tools (it records what it consulted, D11–D14). |
| T13 | How a session with a teaching source starts | **The server starts it, as on our branch.** With the box ticked, the composer text becomes the digest's goal (optional) and no opening message is sent. The digest steer starts the probe. Other files uploaded at the start are attached as context (listed in the system prompt) but aren't tied to a message. Unticked = #435's flow, unchanged. |

Decisions D1–D7 and D11–D14 from `learn-from-source-file-hardening.md` (abort, sniffing, UI-only marker, Retry, permanent failures, `consulted`) **carry over unchanged**, except where §3 changes where the file lives. D8 becomes T11. D9 becomes T10. D15 (no drag-and-drop) stands.

### Names this spec introduces

The owner may veto any of these before implementation starts.

- `ChatRecord.teachingSourceId?: string`: the id of the teaching-source `AttachmentRecord`
- `AttachmentKind` gains `"text"`. `AttachmentRecord` gains `lines?: number`
- `ATTACHMENT_TYPES` gains `".txt"` → `text/plain` and `".md"` → `text/markdown`
- `TEACHING_SOURCE_KINDS: readonly AttachmentKind[] = ["pdf", "text"]` in `src/core/contracts/chat.ts`
- Route `POST /api/chats/[id]/source` with JSON body `{ attachmentId: string, goal?: string }`, and `setTeachingSource(chatId, attachmentId, goal)` in `src/server/sources.ts`
- Agent tools `text_info`, `text_search`, `text_extract` in `src/agent/tools/attachments.ts`
- `AttachmentDraft` gains `sourceKey: string | null`, `setSource(key: string | null)` and `sourceId(): string | undefined` (§6.1)
- `ContextAttachControl` gains an optional `teachingSource?: { disabled: boolean }` prop. `Chip` gains an optional `extra?: ReactNode` slot (§6.1)
- `SessionFilesControl` gains `teachingSourceId?: string`. `Chat` gains `initialTeachingSourceId?: string` (§6.3)
- `setTeachingSourceRequest(chatId, attachmentId, goal, fetchLike)` in `components/attachments.tsx` (§6.2)
- UI strings: checkbox label **"Teaching source"**, Files-panel badge **"Teaching source"**, the disabled-checkbox hint **"Clear your picks to use a file as the teaching source"**, and the disabled-picker hint **"Untick the teaching source to pick nodes"** (replaces our branch's "Remove the attached file to pick nodes")

---

## 1. What we keep, port and drop from `feat/learn-from-source-file`

| Keep (port as is, apart from the §3–§5 changes) | Drop (#435 replaces it) |
|---|---|
| `src/agent/subagents/digest.ts`, `source-ops.ts`, the digest branch of `runner.ts` | `app/api/chats/source/route.ts` and `createSourceSession` (upload and storage) |
| `DigestToolInput`/`DigestResult`, `DIGEST_ABORTED_ERROR`, `abortJob`'s digest branch | `components/start-source-session.ts` (`startSourceSession`). `sourceComposerState`/`attachmentAfterModeChange` are rewritten for the checkbox (§6) |
| `retryDigest` + `POST /api/chats/[id]/source/retry` | `src/agent/tools/source.ts` and the `source` field on `ProberToolContext`/`TeacherToolContext` (T12) |
| `components/source-card.tsx`, the `source-attached` marker (UI only), `view.ts` projection | The Home paperclip (`fileInputRef`, `PaperclipIcon`) and `SOURCE_UPLOAD_ACCEPT` (#435's "Add context" control replaces it) |
| `sniffSource` (moves into the attachment upload path, §3.2) | `data/sources/<chatId>/source<ext>` (the file now lives in #435's blob store) |
| `prober/20-source-probing.md`, `teacher/15-source-planning.md` (reworded, §5) | `SOURCE_UPLOAD_MAX_BYTES`/`_LABEL` (`ATTACHMENT_MAX_BYTES` replaces them; same 50 MB) |
| Tests in `tests/source-sessions.test.ts` and `tests/render-source-card.test.tsx` (adapted) | |

---

## 2. Data model

1. `src/core/contracts/chat.ts`:
   - `AttachmentKind = "image" | "pdf" | "epub" | "text"`.
   - `AttachmentRecord.lines?: number`: the line count of a text file, captured at upload.
   - `ATTACHMENT_TYPES` adds `".txt": { kind: "text", mimeType: "text/plain" }` and `".md": { kind: "text", mimeType: "text/markdown" }`.
   - `ChatRecord.teachingSourceId?: string`. It's set once by `setTeachingSource` (§3.3) and never cleared (T6).
   - `TEACHING_SOURCE_KINDS = ["pdf", "text"] as const`.
2. `DigestToolInput.path` becomes the attachment's absolute blob path (`sessionAttachments()` resolves it). `outlinePath` stays per session: `path.join(sourceDirOf(chatId), "outline.md")`. The outline depends on the session's goal, while the blob is shared across sessions.
3. `sessionSource(chatId)` (`src/server/chat-handler.ts`) now reads `chat.teachingSourceId`. It returns the matching active attachment, joined with the finished digest job's `outlinePath`. It returns `undefined` when either is missing.

---

## 3. Server

### 3.1 Session deletion

- The `#435` blob sweep deletes the source's blob when no other chat references it. Keep `removeSourceDir(chatId)`, which now only removes `outline.md`, in the chat-delete path, as today.

### 3.2 Upload validation (`addChatAttachment`, #435's `src/server/attachments.ts`)

- In `inspect`:
  - For `kind === "text"`: run `sniffSource("text", bytes)`. A non-null result is a refusal (`{ ok: false, error }`, 422). Otherwise record `lines`.
  - For `kind === "pdf"`: run `sniffSource("pdf", bytes)` **before** `pdfInfo`. A non-null result is a refusal.
- Keep #435's error strings for type and size. Add `.txt`/`.md` to its "Unsupported file type" message: "Attach images (PNG, JPG, GIF, WebP), PDFs, EPUBs, or text files (.txt, .md)."
- Port our truncation guard into #435's route (`app/api/chats/[id]/attachments/route.ts`). The route only checks the `content-length` header today. After reading the bytes, if `bytes.byteLength !== upload.size`, return 400 "The upload was cut off — please retry."

### 3.3 `POST /api/chats/[id]/source` → `setTeachingSource(chatId, attachmentId, goal)`

Validation, in order. Each failure returns `{ ok: false, status, error }`:
1. The chat exists (404 "No such session").
2. `chat.messages.length === 0` and `!chat.teachingSourceId` (409 "The teaching source can only be set when the session starts."). This enforces T1 and T2.
3. The chat is in teach mode: `chat.kind !== "practice"` (absent `kind` = teach). Otherwise 400 "A teaching source needs a teach session."
4. The attachment is on the chat, is active, and `TEACHING_SOURCE_KINDS.includes(kind)` (400 "Only a PDF, .txt or .md file can be the teaching source.").

Then:
1. Set `teachingSourceId`.
2. Build the `DigestToolInput` (blob path, `sourceKind` = `"pdf"` | `"text"`, `name`, `outlinePath`, and `goal` if it isn't blank).
3. Create the digest job (`toolCallId = digest_<chatId>`), save the `source-attached` marker, then `startJob`. This is the same code as `createSourceSession` from the chat-creation step on.
4. Wrap steps 1–3 in try/catch. On a throw, clear `teachingSourceId`, `deleteJobsForChat`, remove the outline directory, and return 500 "The teaching source couldn't be set — please retry." The chat and its attachments stay (#435 keeps the session so the client can retry).

`retryDigest` doesn't change, except that its "file is gone" check now reads the blob path.

### 3.4 The source can't be detached (T6)

`PATCH /api/chats/[id]/attachments/[attachmentId]` (#435): when `body.detached === true` and `attachmentId === chat.teachingSourceId`, return 409 "The teaching source can't be removed." before calling `setAttachmentDetached`. This backs up the UI rule in §6.3.

---

## 4. Agent

1. In `src/agent/tools/attachments.ts`, when any attachment has `kind === "text"`, register `text_info` (line count + markdown headings with line numbers), `text_extract` (`lines`: `'1-120'`, `'1,40,90'`) and `text_search` (case-insensitive substring; line numbers + context). They use `#435`'s `scoped()` path check and wrap `source-ops.ts`'s `sourceInfoText`/`sourceExtractText`/`sourceSearchText` for the text kind, following the same error-string contract.
2. `describe()`: text → `` `text file, ${lines} lines, ${size} → text_info / text_search / text_extract` ``.
3. `attachmentsPromptSection`: the teaching-source line gets a ` — TEACHING SOURCE` suffix. The section text doesn't change otherwise. Whether the source attachment needs extra model-facing wording beyond §5's prompts is for the owner to decide when reviewing the prompt diff.
4. Remove `createSourceTools` from `createProberTools`/`createTeacherTools`, together with the `source` context fields.

## 5. Prompts

`prober/20-source-probing.md` and `teacher/15-source-planning.md`: replace every `source_info` / `source_extract` / `source_search` with "the attachment readers for its kind (`pdf_*` for a PDF, `text_*` for a text file)", and "attached file" with "the teaching source (marked in Session attachments)". The doctrine doesn't change otherwise. The owner reviews the final wording diff before it's committed.

---

## 6. Client

### 6.1 Start composers (Home, `/chat/new`)

Both already render #435's `<ContextAttachControl draft={attachments} disabled={busy} />` in the composer's `picker` slot.

1. **Draft state** (`useAttachmentDraft`, `components/attachments.tsx`):
   - `sourceKey` is the ticked draft file's `key`, or `null`. `setSource(key)` sets it, so ticking a second file replaces the first (T2). `setSource(null)` unticks.
   - `remove(key)` and `clear()` reset `sourceKey` when they drop the ticked file.
   - `sourceId()` returns the ticked file's `id` once `upload()` has set it.
   - `identity()` includes `sourceKey`, so ticking or unticking changes the retry identity.
2. **Checkbox**:
   - `ContextAttachControl` passes an `extra` element to each draft `Chip` only when its `teachingSource` prop is set and the file's extension maps to a kind in `TEACHING_SOURCE_KINDS`.
   - The element is a labelled checkbox, "Teaching source", checked when `f.key === draft.sourceKey`. Toggling it calls `setSource(checked ? f.key : null)`.
   - When `teachingSource.disabled` is true, the checkbox is disabled and shows the picks hint (§0).
   - With no `teachingSource` prop, there are no checkboxes. Mid-session composers in `chat.tsx` never pass it (T1).
3. **Home and `/chat/new` pass** `teachingSource={mode === "teach" ? { disabled: picks.length > 0 } : undefined}`. In Home the picks are `practiceProps`.
4. **Mode switch** (T10): switching to practice calls `attachments.setSource(null)`. The file stays in the draft as context.
5. **Picks** (T11): `NodePickerControl` gets `disabled={mode === "teach" && attachments.sourceKey !== null}`, with the picker hint from §0. This reuses the `disabled` prop added on `feat/learn-from-source-file` (`724ba7b`).
6. **Empty text**: while a file is ticked, the placeholder is "What do you want from this file? (optional)" and the send button is enabled with empty text.

### 6.2 Start flow (`SessionStarter.start`, `components/start-session.ts`)

- `attach` gains `sourceId?: () => string | undefined`. Home and `/chat/new` pass `sourceId: () => attachments.sourceId()` whenever `sourceKey` is set.
- The session title: if the composer text is blank and a file is ticked, the `POST /api/chats` body uses the ticked file's name as `title`.
- After `attach.upload(chatId)`, if `attach.sourceId?.()` returns an id:
  - call `setTeachingSourceRequest(chatId, id, goal, fetchLike)`, which POSTs to `/api/chats/[id]/source`. `goal` is the trimmed composer text, or omitted when blank. A non-OK response throws an `Error` carrying the server's `error` string;
  - **don't** call `stashOpeningPrompt` (T13);
  - return the session path as today.
- A failed source call throws with the session kept, as #435 does for upload failures. Retrying reuses the session, skips files already uploaded, and re-sends the source call.
- When no file is ticked, the flow is #435's, unchanged.

### 6.3 Files panel and transcript

- `app/chat/[id]/page.tsx` passes `initialTeachingSourceId={chat.teachingSourceId}` next to `initialAttachments`. `Chat` passes it to `SessionFilesControl` as `teachingSourceId`.
- `SessionFilesControl` shows the "Teaching source" badge on that record and renders no Remove button for it (T6).
- The source card is unchanged (D1–D7).

## 7. Tests

- Port `tests/source-sessions.test.ts` from `createSourceSession` to `addChatAttachment` + `setTeachingSource`. Cover:
  - every §3.3 refusal (session already started, source already set, practice mode, wrong kind, inactive or unknown attachment);
  - rollback on a throw;
  - `sessionSource` reading `teachingSourceId`;
  - `retryDigest` against a blob path;
  - deleting a session with a teaching source shared with another chat (blob kept, outline removed).
- Upload: `.txt`/`.md` accepted with `lines`; a text file with a NUL byte, a fake PDF without `%PDF-`, and a truncated body are each refused.
- `text_*` tools: scoping (a path that isn't an attachment is refused), the info/extract/search output, and the prompt-section line for text and for the teaching source.
- Agent registries: no `source_*` tools on the prober or teacher; `pdf_*`/`text_*` are present for a session with a source.
- `tests/render-new-session.test.tsx` and Home render tests:
  - the checkbox appears only on eligible chips in teach mode;
  - only one box can be ticked;
  - practice mode hides it and unticks it;
  - picks and the checkbox disable each other;
  - the start flow calls the source route and skips the opening prompt when a box is ticked.
- Files panel: the source has the badge and no Remove button.
- Extend #435's `scripts/smoke-attachments.mjs`: start a session with a ticked `.md`, see the source card, then add a PDF as context mid-session.

---

## 8. Checked against #435 at `50ba4e5`

- **Session mode:** `ChatRecord.kind?: ChatKind` (`"teach" | "practice"`; absent = teach). Used in §3.3.
- **Truncation guard:** #435's upload route checks only `content-length`, so §3.2 ports our guard.
- **Chip slot:** `Chip` is private and `ContextAttachControl` renders draft chips directly. §6.1 adds `extra` and `teachingSource`.
- **Detach route:** `PATCH /api/chats/[id]/attachments/[attachmentId]` exists, and §3.4 adds the source guard.
- **Client attachment data:** `app/chat/[id]/page.tsx` passes `initialAttachments={chat.attachments ?? []}`, and §6.3 passes the source id alongside it.

## 9. Commit plan

Each commit leaves typecheck and tests green and includes its own tests from §7.

1. `docs:` this spec and `learn-from-source-file-hardening.md` (brought over from `feat/learn-from-source-file`).
2. `feat:` `.txt`/`.md` attachments: the `text` kind, `lines`, `sniffSource` and the truncation guard on upload (§2.1, §3.2), the `text_*` tools and the prompt-section line (§4.1–4.2).
3. `feat:` the teaching source on the server: port `digest.ts`, `source-ops.ts`, the digest runner and abort branch, the marker and `source-card.tsx` from `feat/learn-from-source-file`. Add `teachingSourceId`, `setTeachingSource` and its route, `sessionSource` reading the field, `retryDigest` on blob paths, and the detach guard (§2, §3.3–3.4). Also the TEACHING SOURCE tag (§4.3).
4. `feat:` the "Teaching source" checkbox and start flow (§6.1–6.2).
5. `feat:` the Files-panel badge with no Remove (§6.3).
6. `refine:` the prober and teacher source prompts (§5). The owner reviews this wording diff before it's committed.
