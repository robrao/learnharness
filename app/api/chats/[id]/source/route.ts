import { setTeachingSource } from "@/src/server";

/**
 * POST /api/chats/[id]/source — name the session's teaching source
 * (learn-from-a-file on attachments, owner 2026-11-03). Body
 * {attachmentId, goal?}: the attachment is already uploaded through
 * /api/chats/[id]/attachments. Only at session start (no messages yet),
 * teach sessions only, one PDF / text file. Starts the digest server-side;
 * its finished steer starts the first turn. 200 {ok}, or {error} with the
 * refusal's status.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = await req.json().catch(() => null);
	if (typeof body?.attachmentId !== "string") return Response.json({ error: "attachmentId must be a string" }, { status: 400 });
	if (body.goal !== undefined && typeof body.goal !== "string") return Response.json({ error: "goal must be a string" }, { status: 400 });
	try {
		const result = setTeachingSource(id, body.attachmentId, body.goal);
		return result.ok ? Response.json({ ok: true }) : Response.json({ error: result.error }, { status: result.status });
	} catch {
		return Response.json({ error: "The teaching source couldn't be set — please retry." }, { status: 500 });
	}
}
