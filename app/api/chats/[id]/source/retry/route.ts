/**
 * POST /api/chats/:id/source/retry — re-run a failed or aborted source
 * digest on the session's stored file (learn-from-a-file, owner
 * 2026-10-28). No body. 404 unknown chat; 409 while a turn or the digest
 * runs, or once it is done; 400 for a permanent (unreadable-file) failure;
 * 410 when the stored file is gone. See src/server/sources.ts retryDigest.
 */
import { retryDigest } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	try {
		const result = retryDigest(id);
		if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
		return Response.json({ ok: true });
	} catch {
		return Response.json({ error: "The retry failed — please try again." }, { status: 500 });
	}
}
