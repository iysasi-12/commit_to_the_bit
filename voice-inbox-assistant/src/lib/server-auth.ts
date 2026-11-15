import "server-only";
import { getToken } from "next-auth/jwt";
import { refreshGoogleToken, SESSION_COOKIE } from "@/auth";
import { ApiError } from "@/lib/errors";

/** Decodes the Auth.js session cookie (fixed name, see auth.ts). */
function readToken(req: Request) {
  return getToken({
    req,
    secret: process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? "",
    cookieName: SESSION_COOKIE,
    salt: SESSION_COOKIE,
  });
}

/**
 * Returns a valid Google access token for the signed-in person, refreshing it if needed.
 * Throws SESSION_EXPIRED when there's no session or Google refused the refresh.
 */
export async function requireGoogleAccessToken(req: Request): Promise<string> {
  const token = await readToken(req);
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
  const token = await readToken(req);
  if (!token) throw new ApiError(401, "NOT_SIGNED_IN", "Please sign in with Google first.");
}

export function sessionExpired(): ApiError {
  return new ApiError(401, "SESSION_EXPIRED", "Your Google session expired or access was removed. Sign out and reconnect Google.");
}
