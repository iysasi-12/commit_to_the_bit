import "server-only";
import { google, type gmail_v1 } from "googleapis";
import { convert } from "html-to-text";
import { ApiError } from "@/lib/errors";
import { sessionExpired } from "@/lib/server-auth";
import { sensitiveKind, type SensitiveKind } from "@/lib/sensitive";

export interface ParsedEmail {
  id: string;
  from: string;
  subject: string;
  /** The Date header as sent, e.g. "Sat, 14 Nov 2026 10:15:00 -0800". */
  sentDate: string;
  body: string;
}

const MAX_BODY_CHARS = 8000;

function header(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value?.trim() ?? "";
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

function isAttachment(part: gmail_v1.Schema$MessagePart): boolean {
  return Boolean(part.filename) || header(part.headers ?? undefined, "Content-Disposition").toLowerCase().startsWith("attachment");
}

/** Depth-first search for the first non-attachment part of the given MIME type. */
function findPart(part: gmail_v1.Schema$MessagePart | undefined, mime: string): gmail_v1.Schema$MessagePart | undefined {
  if (!part) return undefined;
  if (part.mimeType?.toLowerCase() === mime && part.body?.data && !isAttachment(part)) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mime);
    if (found) return found;
  }
  return undefined;
}

export function htmlToPlainText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      { selector: "style", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "head", format: "skip" },
    ],
  });
}

export function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[​-‍﻿­͏]/g, "")
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Plain text if the email has it, otherwise its HTML converted to text. */
export function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  const plain = findPart(payload, "text/plain");
  if (plain?.body?.data) return cleanText(decodeBase64Url(plain.body.data));
  const html = findPart(payload, "text/html");
  if (html?.body?.data) return cleanText(htmlToPlainText(decodeBase64Url(html.body.data)));
  return "";
}

export function parseMessage(msg: gmail_v1.Schema$Message): ParsedEmail {
  const headers = msg.payload?.headers ?? undefined;
  const body = extractBody(msg.payload ?? undefined) || (msg.snippet ?? "");
  return {
    id: msg.id ?? "",
    from: header(headers, "From") || "Unknown sender",
    subject: header(headers, "Subject") || "(no subject)",
    sentDate: header(headers, "Date") || new Date(Number(msg.internalDate ?? Date.now())).toUTCString(),
    body: body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}\n[email shortened]` : body,
  };
}

function mapGmailError(err: unknown): ApiError {
  const status = (err as { code?: number; status?: number }).code ?? (err as { status?: number }).status;
  if (status === 401) return sessionExpired();
  if (status === 403) {
    return new ApiError(403, "GMAIL_FORBIDDEN", "Google didn't allow reading Gmail. Sign out and reconnect, and keep the Gmail permission box checked.");
  }
  if (status === 429) return new ApiError(429, "GMAIL_RATE_LIMITED", "Gmail is limiting requests right now. Wait a minute and try again.");
  return new ApiError(502, "GMAIL_ERROR", "Couldn't read your Gmail inbox. Please try again.");
}

export interface InboxScan {
  emails: ParsedEmail[];
  /** How many emails were skipped as sensitive, by kind. Their bodies were never downloaded. */
  sensitive: Partial<Record<SensitiveKind, number>>;
  fetched: number;
}

/**
 * Reads the newest `count` inbox emails (read-only). Sensitive emails (banking, medical,
 * government, security codes) are detected from sender + subject only and never opened.
 */
export async function fetchRecentEmails(accessToken: string, count: number): Promise<InboxScan> {
  const oauth = new google.auth.OAuth2();
  oauth.setCredentials({ access_token: accessToken });
  const gmail = google.gmail({ version: "v1", auth: oauth });
  try {
    const list = await gmail.users.messages.list({ userId: "me", maxResults: count, labelIds: ["INBOX"] });
    const ids = (list.data.messages ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
    // Step 1: headers only (sender and subject), no body.
    const headersOnly = await Promise.all(
      ids.map((id) => gmail.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: ["From", "Subject"] })),
    );
    const sensitive: Partial<Record<SensitiveKind, number>> = {};
    const safeIds: string[] = [];
    for (const m of headersOnly) {
      const headers = m.data.payload?.headers ?? undefined;
      const kind = sensitiveKind(header(headers, "From"), header(headers, "Subject"));
      if (kind) sensitive[kind] = (sensitive[kind] ?? 0) + 1;
      else if (m.data.id) safeIds.push(m.data.id);
    }
    // Step 2: full content only for emails that aren't sensitive.
    const messages = await Promise.all(safeIds.map((id) => gmail.users.messages.get({ userId: "me", id, format: "full" })));
    return { emails: messages.map((m) => parseMessage(m.data)), sensitive, fetched: ids.length };
  } catch (err) {
    throw mapGmailError(err);
  }
}
