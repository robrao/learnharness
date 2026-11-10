import { addChatAttachment, attachmentsClosed, ATTACHMENTS_CLOSED_ERROR, getChat } from "@/src/server";
import { ATTACHMENT_MAX_BYTES } from "@/src/core";
import { FormBodyLimitError, readBoundedFormData } from "@/lib/bounded-form-data.ts";

export const dynamic = "force-dynamic";

/** Multipart slack above the one file's allowance. */
const FORM_SLACK_BYTES = 1024 * 1024;

/**
 * POST /api/chats/[id]/attachments — one file uploaded while a session
 * starts (teaching-source spec rev 2). Multipart field "file": exactly one
 * file per request, because proxy.ts buffers bodies up to next.config's
 * proxyClientMaxBodySize, sized for one ATTACHMENT_MAX_BYTES file. The file
 * is validated, stored in the session's folder, inspected, and recorded on
 * the chat: 200 {attachment}, or {error} with 400/404/409/413/422.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
	if (attachmentsClosed(chat)) return Response.json({ error: ATTACHMENTS_CLOSED_ERROR }, { status: 409 });
	let form: FormData;
	try {
		form = await readBoundedFormData(req, ATTACHMENT_MAX_BYTES + FORM_SLACK_BYTES);
	} catch (err) {
		if (err instanceof FormBodyLimitError) {
			return Response.json({ error: "Upload is too large — attach one file of at most 50 MB per request." }, { status: 413 });
		}
		return Response.json({ error: "Invalid upload body" }, { status: 400 });
	}
	const upload = form.get("file");
	if (!(upload instanceof File)) return Response.json({ error: 'Attach one file in the "file" field.' }, { status: 400 });
	const bytes = new Uint8Array(await upload.arrayBuffer());
	// The proxy buffer truncates past its limit instead of failing — never
	// trust a body whose bytes disagree with the declared size.
	if (bytes.byteLength !== upload.size) return Response.json({ error: "The upload was cut off — please retry." }, { status: 400 });
	const result = await addChatAttachment(id, { name: upload.name, bytes });
	return result.ok ? Response.json({ attachment: result.attachment }) : Response.json({ error: result.error }, { status: result.status });
}
