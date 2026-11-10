# Teaching source on start-time attachments

**Branch:** `feat/teaching-source-v2`, branched from `main` at `a917e2e` (v0.6.0). It doesn't depend on any unmerged PR. `feat/teaching-source` (head `b609dc0`, stacked on PR #435) stays untouched as the reference implementation, and every "port" below means "port from that branch".
**Status:** DRAFT, revision 2 (2026-11-10). Waiting for owner approval. Implementation starts once the owner approves this document.
**Goal:** when the learner starts a teach session, they can upload files and tick one as the **teaching source**. The digest job reads that file into an outline, and the outline drives the probe and the plan. The other files are **context** that the agent can read. Files can only be added when the session starts.

Revision 1 (2026-11-03) layered this on top of PR #435 (attach images, PDFs and EPUBs as session context, from MarcusXavierr's fork). By 2026-11-10, #435 was 225 commits behind `main`. `main` had rewritten `components/chat.tsx` sending around a submission runner (`runSubmission`/`prepareText`, with images built in), and rebasing the stack hit conflicts in 14 files on its first commit. The owner decided to drop #435 as a base and port only what the teaching source needs (§0, S1–S7).

Implementation should follow this document mechanically. It was checked against `main` at `a917e2e` (§8). If `main` moves and contradicts anything below, stop and ask the owner. Don't guess (AGENTS.md).

---

## 0. Owner decisions

### Scope (2026-11-10)

| # | Question | Decision |
|---|---|---|
| S1 | Keep building on PR #435? | **No.** Port only what the teaching source needs onto a fresh branch from `main`, as our own commits. Nothing from #435 is maintained beyond that. |
| S2 | When can files be added? | **Only when the session starts** (Home and `/chat/new`). There are no mid-session attachments: no composer attach control in `chat.tsx`, and no Add in the Files panel. |
| S3 | How many files at start? | **Several, with at most one ticked** as the teaching source. The rest are context. |
| S4 | Files panel | **A read-only list** with the "Teaching source" badge. There's no Add, Remove or Restore, so nothing can leave the session. |
| S5 | Accepted types | **PDF, EPUB, `.txt`, `.md`.** No images: `main`'s own image handling covers pictures in messages. Only PDF/`.txt`/`.md` can be the source (T4). |
| S6 | How start-time files reach the session | **Always attached to the chat record**, whether or not a box is ticked. They're listed in the system prompt and the Files panel. The opening message is `main`'s plain text send. It carries no `attachmentIds` and the learner's bubble shows no chips. |
| S7 | Storage | **A per-session folder**, `data/attachments/<chatId>/`, deleted with the session. There's no content addressing, cross-session sharing, pinning or reference-counted sweep. |
| S8 | Branch | `feat/teaching-source-v2` from `main`. `feat/teaching-source` stays as the reference. |

### Carried over from revision 1 (2026-11-03)

| # | Question | Decision |
|---|---|---|
| T1 | When can a file be marked as the teaching source? | **Only when the session starts.** S2 now applies this rule to every file. |
| T2 | How many teaching sources? | **Exactly one at most.** Ticking a second file unticks the first. |
| T3 | Checkbox default | **Unticked.** |
| T4 | Which types can be the teaching source? | **PDF, `.txt`, `.md`.** EPUB can be context only. |
| T5 | `.txt`/`.md` as context? | **Yes**, read with the `text_*` tools (§4). Revision 1 allowed this "everywhere, including mid-session". Under S2 it means at start only. |
| T6 | Removing the teaching source | **Not possible.** S4 makes this true for every file. |
| T7 | Should the agent be limited to the source? | **Not in this spec.** The source drives the probe and the plan, the prompts ask the agent to ground in it and cite it, and `research` stays available. |
| T8 | Git base | **Replaced by S1/S8.** |
| T9 | Staged WIP on `feat/learn-from-source-file` | **Leave it untouched** (stash "feat/learn-from-source-file staged WIP (left untouched, T9)"). |
| T10 | Practice mode | **Teach mode only** for the checkbox. Switching teach → practice unticks it, and the file stays in the draft as context. Practice sessions can still start with context files. |
| T11 | Graph picks and a teaching source together | **Not allowed together.** While picks exist, the checkbox is disabled with the hint "Clear your picks to use a file as the teaching source". While it's ticked, the picks chip is disabled. Context files can coexist with picks. |
| T12 | Read tools for the probe and teach agents | **The attachment readers**: `pdf_*`, `epub_*`, and the new `text_*`. There are no `source_*` agent tools. The digest sub-agent keeps its own internal `source_*` tools (D11–D14). |
| T13 | How a session with a teaching source starts | **The server starts it.** With the box ticked, the composer text becomes the digest's goal (optional) and no opening message is sent. The digest steer starts the probe. With no box ticked, the session starts with `main`'s opening message, unchanged (S6). |

Decisions D1–D7 and D11–D14 from `learn-from-source-file-hardening.md` (abort, sniffing, UI-only marker, Retry, permanent failures, `consulted`) **carry over unchanged**, except where §3 changes where the file lives. D8 becomes T11, D9 becomes T10, and D15 (no drag-and-drop) stands.

### Names this spec introduces

The owner may veto any of these before implementation starts. Names marked *(new in rev 2)* weren't in revision 1 or the reference branch.

**Data**
- `AttachmentKind = "pdf" | "epub" | "text"` and `AttachmentRecord` in `src/core/contracts/chat.ts`. These are the reference's types minus `"image"` and `detachedAt`.
- `AttachmentRecord.file` is the stored file's name inside the session folder: `<id><ext>` *(new in rev 2; it was a sha256 blob name)*.
- `ChatRecord.attachments?: AttachmentRecord[]` and `ChatRecord.teachingSourceId?: string`. Revision 1 kept the source id on the chat record partly so #435's `AttachmentRecord` type stayed untouched. That reason is gone now that the type is ours, but the other reason holds: one slot makes "at most one" true by construction (see `docs/notes/teaching-source-id.md`). An alternative is `AttachmentRecord.teachingSource?: true`.
- `ATTACHMENT_TYPES`: `.pdf`, `.epub`, `.txt` (`text/plain`), `.md` (`text/markdown`). `ATTACHMENT_MAX_BYTES = 50 MB`. `TEACHING_SOURCE_KINDS = ["pdf", "text"] as const`.

**Server**
- Store: `attachmentDirOf(chatId)` and `removeChatAttachments(chatId)` in `src/store/attachments.ts` *(new in rev 2)*.
- Store port: `ChatStore.addAttachments(id, records)` and `ChatStore.setTeachingSourceId(id, attachmentId | undefined)`, as in the reference.
- `addChatAttachment(chatId, upload)`, `sessionAttachments(record)` and `sniffSource` in `src/server/attachments.ts`. `setTeachingSource(chatId, attachmentId, goal)` and `retryDigest` in `src/server/sources.ts`. `sourceDirOf`/`removeSourceDir` in `src/server/source-dir.ts`. `startJob` and `sessionSource` in `src/server/chat-handler.ts`.
- Routes: `POST /api/chats/[id]/attachments` (multipart field `"file"`, one file per request), `POST /api/chats/[id]/source` (`{ attachmentId, goal? }`), `POST /api/chats/[id]/source/retry`.
- `"digest"` joins `main`'s `BuiltinJobKind`. `DigestToolInput`, `DigestResult` and `DIGEST_ABORTED_ERROR` live in `src/core/contracts/jobs.ts`.

**Agent**
- Tools `pdf_*`, `epub_*`, and `text_info`/`text_search`/`text_extract` in `src/agent/tools/attachments.ts`. `attachmentsPromptSection` adds a ` — TEACHING SOURCE` suffix to the source's line.

**Client**
- In `components/attachments.tsx`: `ATTACHMENT_ACCEPT`, `uploadAttachment`, `setTeachingSourceRequest`, `canBeTeachingSource`, `precheck`, `formatFileSize`, `attachmentFacts`, `AttachmentDraft`/`useAttachmentDraft` (with `sourceKey`, `setSource`, `sourceId`), `ContextAttachControl` (with `teachingSource?: { disabled: boolean }`), `SessionFilesControl` and `TEACHING_SOURCE_PICKS_HINT`.
- `Chat` gains `initialAttachments?: AttachmentRecord[]` and `initialTeachingSourceId?: string`.

**UI strings**
- The checkbox label and the Files-panel badge are both **"Teaching source"**.
- The disabled-checkbox hint is **"Clear your picks to use a file as the teaching source"**, and the disabled-picker hint is **"Untick the teaching source to pick nodes"**.
- The unsupported-type error is **"Attach PDFs, EPUBs, or text files (.txt, .md)."** *(new in rev 2; it lost the images clause)*.
- The upload-after-start refusal is **"Files can only be added when the session starts."** *(new in rev 2)*.

### Behaviours new in revision 2, for the owner to confirm

- **R1. Server-side start-only guard.** `POST /api/chats/[id]/attachments` refuses with 409 and the string above when `chat.messages.length > 0` or `chat.teachingSourceId` is set. S2 is otherwise only a UI rule.
- **R2. No server-side de-duplication.** Uploading the same file twice at start makes two records. The client's retry already skips files it uploaded, as in the reference (§6.2).
- **R3. Files panel hidden when empty.** In the reference it always rendered because it held the Add path. Read-only, with no files, it has nothing to show.

---

## 1. What we port, change and drop

The reference stack is `c43fe95..b609dc0` on `feat/teaching-source`. The first six commits are #435 as we carried it; the last seven are ours.

| From | Port (adapted to §2–§6) | Drop |
|---|---|---|
| `c43fe95` attach images, PDFs, EPUBs | `src/server/attachments.ts`, the upload route, `src/agent/tools/attachments.ts` (PDF/EPUB parts), `src/agent/subagents/epub-ops.ts`, the `fflate` dependency, `read.ts`'s exported `readTextSlice`, `components/attachments.tsx` (draft + `ContextAttachControl`), the Home and `/chat/new` wiring, the `next.config.ts` proxy-buffer change, the `shared/30-learner-files.md` paragraph (reworded, §5), `tests/epub-ops.test.ts` and `tests/fixtures/make-epub.ts` | Image kind and image tools. `attachmentIds` on the text input (`src/core/input-events.ts`), the `data-attachments` user-message part (`src/core/native-messages.ts`, `src/core/view.ts`), `AttachmentChips` and the opening prompt's `attachmentIds` (`components/opening-prompt.ts`, `chat.tsx`). The composer `ContextAttachControl` in `chat.tsx` |
| `f1ae5fe` store once by content | Only the `ChatStore.addAttachments` port method and the chat-list summary stripping `attachments` | The blob store, pins, `referencedAttachmentFiles` and `removeBlobsUnreferenced` (S7) |
| `1e4b698` remove/restore/add from the top bar | `SessionFilesControl` as a read-only list (§6.3) | Add, Remove and Undo. `PATCH /api/chats/[id]/attachments/[attachmentId]`, `setAttachmentDetached`, `detachedAt`, `mergeAttachments`, `tests/render-session-files.test.tsx` parts for those |
| `2118ae5` adapt to `main`'s image processing | Nothing: it only concerned images, and `main`'s `pdf-read.ts` already has `scopedPath` | Everything |
| `8391c9d`, `6f33cf5` test isolation, smoke typing | The data-dir isolation in `tests/attachments.test.ts` and `tests/jobs.test.ts`, the path-input typing in the smoke | — |
| `1354a1c` `.txt`/`.md` attachments | All of it: `text` kind, `lines`, `sniffSource`, truncation guard, `source-ops.ts`, the `pdf-ops.ts` page-text cache, the `text_*` tools | — |
| `7fc7ffa` name the teaching source | All of it: `digest.ts`, the runner's digest branch and abort, `sources.ts`, `source-dir.ts`, both source routes, `source-card.tsx`, the `source-attached` marker and its view projection, the steer/dispatch card changes, the source prompts, `tests/source-sessions.test.ts`, `tests/render-source-card.test.tsx` | The source guard on the PATCH detach route (the route is gone) |
| `5334c54` the start-time checkbox | All of it | — |
| `279d3dd` the Files-panel badge | All of it, on the read-only panel | — |
| `d064e9a` prompt wording | All of it | — |
| `b609dc0` smoke | Adapted (§7) | The mid-session step |

The `learn-from-source-file` table from revision 1 (what `feat/teaching-source` itself kept from that older branch) is already reflected in the reference and isn't repeated here.

---

## 2. Data model

1. In `src/core/contracts/chat.ts`, add `AttachmentKind`, `AttachmentRecord`, `ATTACHMENT_TYPES`, `ATTACHMENT_MAX_BYTES` and `TEACHING_SOURCE_KINDS` as named in §0. Add `attachments?` and `teachingSourceId?` to `ChatRecord`. Both are optional, so `CURRENT_CHAT_VERSION` stays at 2 and old records read as having no files.
2. `teachingSourceId` is set once by `setTeachingSource` (§3.3), cleared only by that function's rollback, and otherwise never cleared (T6).
3. In `src/store/chats.ts`, the chat-list summary (`listChats`, which already strips `imageSnapshots` and `sideChats`) also strips `attachments`.
4. `DigestToolInput.path` is the attachment's absolute path, which `sessionAttachments()` resolves. `outlinePath` is `path.join(sourceDirOf(chatId), "outline.md")`, unchanged.
5. `sessionSource(chatId)` reads `chat.teachingSourceId`. It returns the matching attachment, joined with the finished digest job's `outlinePath`. It returns `undefined` when either is missing.

---

## 3. Server

### 3.1 Storage and deletion (S7)

- `attachmentDirOf(chatId)` is `path.join(PATHS.attachments, chatId)`. `PATHS.attachments` (`config.ts`) is `data/attachments`, as in the reference.
- `addChatAttachment` writes the bytes to `<dir>/<id><ext>` with `main`'s atomic-write helper and then calls `chatStore.addAttachments`. If recording fails, it deletes the file.
- The chat-delete path calls `removeChatAttachments(chatId)` (recursive remove of the folder) next to the existing `removeSourceDir(chatId)`.

### 3.2 Upload (`POST /api/chats/[id]/attachments`)

- Read the body with `main`'s `readBoundedFormData(req, ATTACHMENT_MAX_BYTES + 1 MiB)` (`lib/bounded-form-data.ts`). `FormBodyLimitError` → 413 "Upload is too large — attach one file of at most 50 MB per request." Any other parse error → 400 "Invalid upload body".
- Keep the reference's truncation guard: if `bytes.byteLength !== upload.size`, return 400 "The upload was cut off — please retry."
- Apply R1 before reading the body.
- In `addChatAttachment`:
  - Look the type up by extension. An unknown type is a 422 with the S5 error string.
  - For `kind === "text"`, run `sniffSource("text", bytes)`. A non-null result is a 422. Otherwise record `lines`.
  - For `kind === "pdf"`, run `sniffSource("pdf", bytes)` before `pdfInfo`. A non-null result is a 422. Otherwise record `pages`.
  - For `kind === "epub"`, do the reference's EPUB inspection (`chapters`, `title`).
- `next.config.ts` raises `proxyClientMaxBodySize` to `Math.max(MAX_IMPORT_BODY_BYTES, ATTACHMENT_MAX_BYTES + 1 MiB)`, as in the reference. New `/api` routes are covered by `main`'s `proxy.ts` request policy as they are.

### 3.3 `POST /api/chats/[id]/source` → `setTeachingSource(chatId, attachmentId, goal)`

This is unchanged from revision 1. Validation runs in order, and each failure returns `{ ok: false, status, error }`:
1. The chat exists (404 "No such session").
2. `chat.messages.length === 0` and `!chat.teachingSourceId` (409 "The teaching source can only be set when the session starts.").
3. `chat.kind !== "practice"` (400 "A teaching source needs a teach session.").
4. The attachment is on the chat and `TEACHING_SOURCE_KINDS.includes(kind)` (400 "Only a PDF, .txt or .md file can be the teaching source.").

Then:
1. Set `teachingSourceId`.
2. Build the `DigestToolInput`.
3. Create the digest job (`toolCallId = digest_<chatId>`), save the `source-attached` marker, and `startJob`.
4. On a throw, clear `teachingSourceId`, `deleteJobsForChat`, remove the outline directory, and return 500 "The teaching source couldn't be set — please retry." The chat and its files stay.

`retryDigest` is unchanged. Its "file is gone" check reads the session-folder path.

### 3.4 Digest job on `main`'s job system

- Add `"digest"` to `BuiltinJobKind` and to the runner's `KIND_ROLE` (the role the reference used).
- `DigestResult` joins `main`'s `JobResult` union.
- The digest's steer, abort and recovery follow `main`'s delivery contract, including the new `"failure"` delivery (`buildJobFailureSteer`). They don't keep the reference's two-way result/abort split.
- Port the `pdf-ops.ts` page-text cache onto `main`'s reworked `openDocument`/`task.destroy()`.

---

## 4. Agent

1. `src/agent/tools/attachments.ts` registers tools by the kinds present: `pdf_*` for PDFs, `epub_*` for EPUBs, `text_*` for text files. Every path goes through the scoped check, so a path that isn't one of the session's attachments is refused.
2. `describe()` gives one line per kind, as in the reference (text: `` `text file, ${lines} lines, ${size} → text_info / text_search / text_extract` ``).
3. `attachmentsPromptSection` lists the session's files under "Session attachments", with ` — TEACHING SOURCE` on the source's line. It's fed through `main`'s `composeInstructions`/`promptSwitches` path and counted in `systemPromptTokens` at both call sites in `chat-handler.ts`, as in the reference.
4. The prober and teacher get no `source_*` tools (T12).

## 5. Prompts

- `prober/20-source-probing.md` and `teacher/15-source-planning.md` are ported as they stand at `d064e9a`.
- In `shared/30-learner-files.md`, the reference's paragraph changes "(images, PDFs, EPUBs)" to "(PDFs, EPUBs, text files) when the session starts". Proposed wording: "He can also attach files when he starts a session (PDFs, EPUBs, text files). When he has, they're listed under "Session attachments" at the end of these instructions with the tools that read them. They are context he chose for this session: use them when the lesson touches their content, reading the structure first and then only the pages or chapter you need. Never read a whole book or document at once."
- The owner reviews every prompt diff before it's committed.

---

## 6. Client

### 6.1 Start composers (Home, `/chat/new`)

Port `5334c54` as it is:
- `ContextAttachControl` goes in `ComposerActions`' `picker` slot, next to `NodePickerControl`. `main`'s paperclip (`AttachFilesButton`, which inserts file paths into the text) stays where it is. It has nothing to do with these uploads.
- The draft state holds `sourceKey`, `setSource` and `sourceId`, and `identity()` includes `sourceKey`.
- A "Teaching source" checkbox appears on eligible chips only, in teach mode only.
- Picks and the checkbox disable each other (T11).
- Switching to practice unticks the box (T10).
- With a file ticked, the placeholder is "What do you want from this file? (optional)" and empty text can be sent.
- `ATTACHMENT_ACCEPT` and `precheck` follow S5.

### 6.2 Start flow (`SessionStarter.start`, `components/start-session.ts`)

1. Create the chat, as on `main`.
2. Run `attach.upload(chatId)`. A failure throws with the session kept. A retry reuses the session and uploads only the files that haven't gone up yet.
3. If `attach.sourceId?.()` returns an id, call `setTeachingSourceRequest(chatId, id, goal)` and return the session path without stashing an opening prompt (T13). When the text is blank, the title is the ticked file's name.
4. Otherwise, stash the opening prompt exactly as `main` does (`stashOpeningPrompt(id, title)`, no `attachmentIds`), and the chat view sends it through `main`'s `prepareText` path, unchanged (S6).

### 6.3 Files panel and session view

- `app/chat/[id]/page.tsx` passes `initialAttachments={chat.attachments ?? []}` and `initialTeachingSourceId={chat.teachingSourceId}`.
- `Chat` renders `SessionFilesControl` in the top bar, where the reference put it: before the plan chip. It renders only when the session has files (R3).
- `SessionFilesControl` is read-only:
  - a trigger with the file count, opening a panel;
  - one row per file, with name and `attachmentFacts`;
  - the "Teaching source" badge on the source's row;
  - no Add, Remove, Undo, upload state or `setAttachments`.
- The props drop to `chatId`, `attachments`, `open`, `onOpenChange` and `teachingSourceId`. `highlightId` goes too, since there are no transcript chips to open it from.
- The source card, digest steer card and Retry are ported unchanged (D1–D7).
- Nothing else in `chat.tsx` changes. In particular, `main`'s submission runner and opening-prompt delivery are untouched.

## 7. Tests

- `tests/attachments.test.ts` (ported, then trimmed):
  - PDF/EPUB/`.txt`/`.md` uploads, with `pages`/`chapters`/`lines`;
  - refusals: unsupported type, NUL in a text file, fake PDF, truncated body, over-size body, upload after start (R1, both cases);
  - storage in the session folder, and removal when the chat is deleted;
  - tool scoping, and `describe()` and prompt-section lines, including the TEACHING SOURCE suffix;
  - registry: no `source_*` on the prober or teacher.
- `tests/source-sessions.test.ts`, ported:
  - every §3.3 refusal and the rollback;
  - `sessionSource`;
  - `retryDigest`;
  - deleting a session with a source (files and outline gone).
- `tests/jobs.test.ts`: the digest kind through `main`'s runner, including the `"failure"` delivery.
- Ported as they are: `tests/epub-ops.test.ts`, `tests/render-source-card.test.tsx`, `tests/teaching-source-draft.test.tsx`, the start-flow cases in `tests/render-new-session.test.tsx`.
- `tests/render-new-session.test.tsx` also checks that a start with context files and no source stashes a plain opening prompt.
- `tests/render-session-files.test.tsx`: the list, the badge, no Add/Remove controls, and hidden when empty.
- `scripts/smoke-attachments.mjs`, adapted:
  - start a teach session with a ticked `.md` and a context PDF, then see the source card and both files in the panel;
  - start another session with one unticked file, then see the opening message sent with no chips.

---

## 8. Checked against `main` at `a917e2e`

- None of the attachment, source or digest files exist on `main`. Graph "sources" (`src/core/source-*.ts`, `src/server/source-*.ts`) and extraction's "digest" were already on `main` when the reference branched, so no names collide.
- `ChatRecord` now has `version`, with writes stamped at `CURRENT_CHAT_VERSION = 2`. The new optional fields don't need a bump (§2.1).
- `JobKind = BuiltinJobKind | "plugin"`. The runner skips non-builtin kinds, delivery gained `"failure"`, and `JobResult` is a union (§3.4).
- `pdf-ops.ts` reworked `openBytes` with abort support, and our cache sits beside it (§3.4).
- `lib/bounded-form-data.ts` exists and the import route uses it (§3.2). `next.config.ts` still sizes the proxy buffer from `MAX_IMPORT_BODY_BYTES`.
- `chat-handler.ts` still computes `systemPromptTokens` from `composeInstructions` (two sites) and passes `promptSwitches` (§4.3).
- Home and `/chat/new` still use `ComposerActions` with a `picker` slot, and `AttachFilesButton` sits in Home's form (§6.1). `components/start-session.ts` and `opening-prompt.ts` are as the reference branched from them.
- Plugins can't host this feature. There's no plugin slot on the start composers and no upload hook. Plugin prompt contributions exist, but the source flow needs core routes and records anyway.

## 9. Commit plan

Each commit leaves typecheck and tests green and includes its own tests from §7.

1. `docs:` this spec and `learn-from-source-file-hardening.md`.
2. `feat:` start-time session files on the server: contracts, per-session storage, the upload route with R1, `sniffSource`, the readers and `text_*` tools, the prompt section, `epub-ops.ts`, and the `next.config.ts` buffer (§2, §3.1–3.2, §4).
3. `feat:` attach files when a session starts: `components/attachments.tsx` (draft, control, upload), Home and `/chat/new` wiring, the start flow without a source (§6.1–6.2 minus the checkbox).
4. `feat:` the read-only Files panel (§6.3 minus the badge).
5. `feat:` the teaching source on the server: digest, runner, routes, marker, source card, `sessionSource`, the TEACHING SOURCE tag (§3.3–3.4, §4.3).
6. `feat:` the "Teaching source" checkbox, the start flow with a source, and the Files-panel badge (§6.1–6.3).
7. `refine:` the prober, teacher and learner-files prompts (§5). The owner reviews this wording diff before it's committed.
8. `test:` the adapted smoke (§7).
