import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    error?: "RefreshTokenError";
    /** True when the person granted Gmail modify (needed for Delete and Reorganize). */
    canModify?: boolean;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    access_token?: string;
    expires_at?: number;
    refresh_token?: string;
    can_modify?: boolean;
    error?: "RefreshTokenError";
  }
}
