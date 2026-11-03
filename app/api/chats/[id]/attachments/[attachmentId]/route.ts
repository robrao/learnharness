import { getChat, stores } from "@/src/server";

/**
 * PATCH /api/chats/[id]/attachments/[attachmentId] — soft detach / restore
 * one session attachment (2026-10-29). Body {detached: boolean}. Detach
 * sets the record's `detachedAt` (the record and its blob stay, so Undo
 * needs no re-upload); restore clears it. Takes effect on the next turn:
 * agents are built per turn from the record. The teaching source refuses
 * detach (409).
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; attachmentId: string }> }) {
	const { id, attachmentId } = await params;
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Not found" }, { status: 404 });

	const body = await req.json().catch(() => null);
	if (typeof body?.detached !== "boolean") return Response.json({ error: "detached must be true or false" }, { status: 400 });

	// The teaching source can't leave the session (owner, 2026-11-03).
	if (body.detached && attachmentId === chat.teachingSourceId) {
		return Response.json({ error: "The teaching source can't be removed." }, { status: 409 });
	}
	const attachment = stores.chatStore.setAttachmentDetached(id, attachmentId, body.detached);
	if (!attachment) return Response.json({ error: "Attachment not found" }, { status: 404 });
	return Response.json({ attachment });
}
