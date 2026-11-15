/**
 * Who may see, use, or remove a voice in the one shared ElevenLabs account (pure, no network).
 *
 * Every voice a person makes in the app gets a private owner tag at the end of its ElevenLabs
 * description ("[via-owner:3f9a…]", an HMAC of their email, never the email itself). The tag is
 * removed before anything reaches the browser. Rules:
 *   - ElevenLabs presets: everyone can use them.
 *   - Tagged voices: only their owner sees, uses, or removes them.
 *   - Untagged cloned voices (made before tags, or in the ElevenLabs website): admins only,
 *     because a clone is a real person's voice.
 *   - Untagged designed voices (the built-in characters such as The Butler): shared with
 *     everyone; only admins can remove them.
 */
import { createHmac } from "node:crypto";

export interface Viewer {
  owner: string;
  admin: boolean;
}

export type Access = { visible: boolean; usable: boolean; removable: boolean; mine: boolean };

const TAG = /\s*\[via-owner:([a-f0-9]{16})\]\s*$/;
const PERSONAL = new Set(["cloned", "professional", "famous"]);
const DESCRIPTION_MAX = 1000;

/**
 * Stable, non-reversible owner id for a signed-in person. VOICE_OWNER_SECRET must be the same
 * everywhere that shares the ElevenLabs account (your computer and the server), or voices made in
 * one place can't be found by their owner in the other. Falls back to AUTH_SECRET.
 */
export function ownerKey(identity: string, secret = process.env.VOICE_OWNER_SECRET || process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || ""): string {
  return createHmac("sha256", secret).update(`voice-owner:${identity.trim().toLowerCase()}`).digest("hex").slice(0, 16);
}

export function isAdminEmail(email: string, list = process.env.ADMIN_EMAILS ?? ""): boolean {
  const admins = list
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return Boolean(email) && admins.includes(email.trim().toLowerCase());
}

/** Adds the owner tag to a description, keeping it within ElevenLabs' 1000-character limit. */
export function tagDescription(description: string, owner: string): string {
  const tag = ` [via-owner:${owner}]`;
  const clean = description.replace(TAG, "").trim().slice(0, DESCRIPTION_MAX - tag.length);
  return `${clean}${tag}`;
}

export function ownerOf(description: string | null | undefined): string | null {
  return description?.match(TAG)?.[1] ?? null;
}

export function cleanDescription(description: string | null | undefined): string {
  return (description ?? "").replace(TAG, "").trim();
}

export function accessFor(v: { category: string; description: string | null | undefined }, me: Viewer): Access {
  if (v.category === "premade") return { visible: true, usable: true, removable: false, mine: false };
  const owner = ownerOf(v.description);
  if (owner) {
    const mine = owner === me.owner;
    return { visible: mine, usable: mine, removable: mine, mine };
  }
  if (PERSONAL.has(v.category)) return { visible: me.admin, usable: me.admin, removable: me.admin, mine: false };
  return { visible: true, usable: true, removable: me.admin, mine: false };
}
