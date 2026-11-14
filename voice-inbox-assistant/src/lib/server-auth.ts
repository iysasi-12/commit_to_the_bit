import "server-only";
import { getToken } from "next-auth/jwt";
import { refreshGoogleToken } from "@/auth";
import { ApiError } from "@/lib/errors";

/** True when the request reached us over HTTPS (directly or through Nginx/Caddy). */
function isHttps(req: Request): boolean {
  const forwarded = req.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0]!.trim() === "https";
  return new URL(req.url).protocol === "https:";
}

/**
 * Returns a valid Google access token for the signed-in person, refreshing it if needed.
 * Throws SESSION_EXPIRED when there's no session or Google refused the refresh.
 */
export async function requireGoogleAccessToken(req: Request): Promise<string> {
  const token = await getToken({
    req,
    secret: process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? "",
    secureCookie: isHttps(req),
  });
  if (!token) throw new ApiError(401, "NOT_SIGNED_IN", "Please sign in with Google first.");
  if (token.error === "RefreshTokenError") throw sessionExpired();
  if (token.access_token && token.expires_at && Date.now() < (token.expires_at - 60) * 1000) return token.access_token;
  if (!token.refresh_token) throw sessionExpired();
  try {
    return (await refreshGoogleToken(token.refresh_token)).access_token;
  } catch {
    throw sessionExpired();
  }
}

/** Requires a signed-in session (used to keep ElevenLabs routes from being used anonymously). */
export async function requireSignedIn(req: Request): Promise<void> {
  const token = await getToken({
    req,
    secret: process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? "",
    secureCookie: isHttps(req),
  });
  if (!token) throw new ApiError(401, "NOT_SIGNED_IN", "Please sign in with Google first.");
}

export function sessionExpired(): ApiError {
  return new ApiError(401, "SESSION_EXPIRED", "Your Google session expired or access was removed. Sign out and reconnect Google.");
}
