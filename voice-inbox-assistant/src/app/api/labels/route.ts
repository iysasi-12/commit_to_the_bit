import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/errors";
import { listLabels } from "@/lib/gmail";
import { requireGoogleAccessToken } from "@/lib/server-auth";

/** GET → the signed-in person's own Gmail labels, for Reorganize. */
export async function GET(req: Request) {
  try {
    const accessToken = await requireGoogleAccessToken(req);
    return NextResponse.json({ labels: await listLabels(accessToken) });
  } catch (err) {
    return errorResponse(err);
  }
}
