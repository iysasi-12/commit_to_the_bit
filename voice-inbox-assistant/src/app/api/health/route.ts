import { NextResponse } from "next/server";

/**
 * GET → which build is running, so a deploy can be checked against `git rev-parse HEAD`.
 * APP_COMMIT is set by deploy/setup-vultr.sh. Reveals no secrets or user data.
 */
export function GET() {
  return NextResponse.json(
    {
      ok: true,
      // Lets the Chrome extension tell this app apart from anything else on the same domain.
      app: "voice-inbox-assistant",
      commit: process.env.APP_COMMIT || "unknown",
      configured: {
        google: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
        gemini: Boolean(process.env.GEMINI_API_KEY),
        elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY),
        authUrl: process.env.AUTH_URL || process.env.NEXTAUTH_URL || null,
      },
    },
    // Readable from anywhere (the Chrome extension checks it before choosing a server). It holds
    // no secrets or user data.
    { headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } },
  );
}
