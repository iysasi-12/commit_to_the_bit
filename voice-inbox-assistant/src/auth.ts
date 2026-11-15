import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

/**
 * One fixed session cookie name. SameSite=None + Secure lets the app stay signed in when it's
 * shown inside the Chrome extension's side panel (Chrome accepts Secure cookies on localhost).
 */
export const SESSION_COOKIE = "authjs.session-token";

/** Exchanges a Google refresh token for a new access token. Throws on invalid_grant (revoked or expired). */
export async function refreshGoogleToken(refreshToken: string) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const body = (await res.json()) as { access_token?: string; expires_in?: number; refresh_token?: string; error?: string };
  if (!res.ok || !body.access_token) throw new Error(body.error ?? `Token refresh failed (${res.status})`);
  return {
    access_token: body.access_token,
    expires_at: Math.floor(Date.now() / 1000 + (body.expires_in ?? 3600)),
    // Google usually keeps the same refresh token; rotate when it sends a new one.
    refresh_token: body.refresh_token ?? refreshToken,
  };
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  // Works on http://localhost:3000 and behind Nginx/Caddy on a VPS (uses X-Forwarded-* headers).
  trustHost: true,
  secret: process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET,
  session: { strategy: "jwt" },
  cookies: {
    sessionToken: { name: SESSION_COOKIE, options: { httpOnly: true, sameSite: "none", path: "/", secure: true } },
  },
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      authorization: {
        params: {
          scope: `openid email profile ${GMAIL_SCOPE}`,
          access_type: "offline",
          prompt: "consent",
          response_type: "code",
        },
      },
    }),
  ],
  callbacks: {
    async jwt({ token, account }) {
      // First sign-in: keep Google's tokens in the encrypted, HttpOnly session cookie.
      if (account) {
        return {
          ...token,
          access_token: account.access_token ?? "",
          expires_at: account.expires_at ?? Math.floor(Date.now() / 1000 + 3600),
          refresh_token: account.refresh_token,
          error: undefined,
        };
      }
      // Still valid (with a 60-second safety margin).
      if (token.expires_at && Date.now() < (token.expires_at - 60) * 1000) return token;
      if (!token.refresh_token) return { ...token, error: "RefreshTokenError" as const };
      try {
        const fresh = await refreshGoogleToken(token.refresh_token);
        return { ...token, ...fresh, error: undefined };
      } catch (err) {
        // Revoked access or Google's 7-day limit for apps in Testing mode: ask the person to reconnect.
        console.error("[auth] Google token refresh failed:", err instanceof Error ? err.message : err);
        return { ...token, error: "RefreshTokenError" as const };
      }
    },
    async session({ session, token }) {
      // Only the error flag reaches the browser; Google tokens stay server-side.
      session.error = token.error;
      return session;
    },
  },
});
