/**
 * Helpers that turn Gmail API message resources into plain text the AI can read.
 * Gmail encodes part bodies as base64url; HTML-only emails are converted to text.
 */

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

export interface GmailMessageResource {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  bull: "•",
  middot: "·",
  zwnj: "",
  zwj: "",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const n = code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return match;
      try {
        return String.fromCodePoint(n);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[code.toLowerCase()];
    return named ?? match;
  });
}

export function headerValue(headers: GmailHeader[] | undefined, name: string): string {
  const lower = name.toLowerCase();
  return headers?.find((h) => h.name.toLowerCase() === lower)?.value ?? "";
}

/** Parses `"Jane Doe" <jane@example.com>` into its parts. */
export function parseAddress(raw: string): { name: string; email: string } {
  const trimmed = raw.trim();
  const angle = trimmed.match(/^(.*?)<([^>]+)>\s*$/);
  if (angle) {
    const name = angle[1]!.trim().replace(/^"(.*)"$/, "$1").replace(/\\"/g, '"').trim();
    const email = angle[2]!.trim();
    return { name: name || email, email };
  }
  if (trimmed.includes("@")) return { name: trimmed, email: trimmed };
  return { name: trimmed || "Unknown sender", email: "" };
}

function charsetOf(part: GmailPart): string {
  const ct = headerValue(part.headers, "Content-Type");
  const m = ct.match(/charset="?([^";\s]+)"?/i);
  return (m?.[1] ?? "utf-8").toLowerCase();
}

export function decodeBase64Url(data: string, charset = "utf-8"): string {
  const buf = Buffer.from(data, "base64url");
  if (charset === "iso-8859-1" || charset === "latin1" || charset === "windows-1252" || charset === "us-ascii") {
    return buf.toString("latin1");
  }
  return buf.toString("utf8");
}

export function htmlToText(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(head|style|script|title|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|table|section|article|blockquote)\s*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<td\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  text = decodeEntities(text);
  return normalizeWhitespace(text);
}

export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[​‌‍﻿­]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Removes quoted replies so the AI reads the new part of a thread, not the whole history. */
export function stripQuotedReplies(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^On .{4,200}wrote:\s*$/.test(line)) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    if (line.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

function isAttachment(part: GmailPart): boolean {
  if (part.filename) return true;
  const disposition = headerValue(part.headers, "Content-Disposition").toLowerCase();
  return disposition.startsWith("attachment");
}

function findPart(part: GmailPart | undefined, mime: string): GmailPart | undefined {
  if (!part) return undefined;
  if (part.mimeType?.toLowerCase() === mime && part.body?.data && !isAttachment(part)) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mime);
    if (found) return found;
  }
  return undefined;
}

/** Picks text/plain when present, else converts text/html. Attachments are ignored. */
export function extractBodyText(payload: GmailPart | undefined): string {
  const plain = findPart(payload, "text/plain");
  if (plain?.body?.data) {
    return normalizeWhitespace(decodeBase64Url(plain.body.data, charsetOf(plain)));
  }
  const html = findPart(payload, "text/html");
  if (html?.body?.data) {
    return htmlToText(decodeBase64Url(html.body.data, charsetOf(html)));
  }
  return "";
}

export function truncateText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const cut = text.slice(0, max);
  const lastBreak = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "));
  return { text: (lastBreak > max * 0.6 ? cut.slice(0, lastBreak + 1) : cut).trim(), truncated: true };
}

export function toInboxFields(msg: GmailMessageResource) {
  const headers = msg.payload?.headers;
  const from = parseAddress(headerValue(headers, "From"));
  const internalDate = Number(msg.internalDate ?? 0) || Date.parse(headerValue(headers, "Date")) || 0;
  return {
    id: msg.id,
    threadId: msg.threadId,
    fromName: from.name,
    fromEmail: from.email,
    subject: headerValue(headers, "Subject").trim() || "(no subject)",
    date: new Date(internalDate || Date.now()).toISOString(),
    internalDate,
    snippet: decodeEntities(msg.snippet ?? "").trim(),
    unread: (msg.labelIds ?? []).includes("UNREAD"),
  };
}
