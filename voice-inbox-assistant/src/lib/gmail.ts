import "server-only";
import { google, type gmail_v1 } from "googleapis";
import { convert } from "html-to-text";
import { ApiError } from "@/lib/errors";
import { sessionExpired } from "@/lib/server-auth";
import { scanWithoutSensitive, type SensitiveKind } from "@/lib/sensitive";
import { gmailQuery, type TimeWindow } from "@/lib/time-window";

export interface ParsedEmail {
  id: string;
  from: string;
  subject: string;
  /** The Date header as sent, e.g. "Sat, 14 Nov 2026 10:15:00 -0800". */
  sentDate: string;
  body: string;
  /** Gmail's own labels (e.g. CATEGORY_PROMOTIONS, IMPORTANT). Read only; the scan never changes them. */
  labels: string[];
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
    labels: msg.labelIds ?? [],
  };
}

function mapGmailError(err: unknown): ApiError {
  const status = (err as { code?: number; status?: number }).code ?? (err as { status?: number }).status;
  const message = String((err as { message?: unknown }).message ?? "");
  if (status === 401) return sessionExpired();
  if (status === 403 && /insufficient|scope|permission/i.test(message)) {
    return new ApiError(403, "GMAIL_NEEDS_PERMISSION", "To use Delete and Reorganize, sign out and sign back in, and allow Voice Inbox Assistant to manage your email.");
  }
  if (status === 403) {
    return new ApiError(403, "GMAIL_FORBIDDEN", "Google didn't allow reading Gmail. Sign out and reconnect, and keep the Gmail permission box checked.");
  }
  if (status === 404) return new ApiError(404, "GMAIL_NOT_FOUND", "That email or label no longer exists in Gmail.");
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
function gmailClient(accessToken: string) {
  const oauth = new google.auth.OAuth2();
  oauth.setCredentials({ access_token: accessToken });
  // GMAIL_API_ROOT is for automated tests only (a fake Gmail on this computer); never set it on the server.
  return google.gmail({ version: "v1", auth: oauth, ...(process.env.GMAIL_API_ROOT ? { rootUrl: process.env.GMAIL_API_ROOT } : {}) });
}

/** Gmail message and label ids are short URL-safe strings. */
export function validGmailId(id: unknown, what = "email"): string {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new ApiError(400, "BAD_ID", `That ${what} id isn't valid.`);
  return id;
}

/** Moves one email to Trash (recoverable in Gmail for 30 days). Only called when the person clicks Delete. */
export async function trashMessage(accessToken: string, id: string): Promise<void> {
  try {
    await gmailClient(accessToken).users.messages.trash({ userId: "me", id });
  } catch (err) {
    throw mapGmailError(err);
  }
}

export interface GmailLabel {
  id: string;
  name: string;
}

/** The person's own labels (Gmail's "folders"), sorted by name. */
export async function listLabels(accessToken: string): Promise<GmailLabel[]> {
  try {
    const res = await gmailClient(accessToken).users.labels.list({ userId: "me" });
    return (res.data.labels ?? [])
      .filter((l) => l.type === "user" && l.id && l.name)
      .map((l) => ({ id: l.id!, name: l.name! }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    throw mapGmailError(err);
  }
}

/**
 * "Reorganize": files the email under one of the person's labels and takes it out of the Inbox
 * (like Gmail's "Move to"). Every other label it already has is kept.
 */
export async function moveMessage(accessToken: string, id: string, labelId: string): Promise<void> {
  try {
    await gmailClient(accessToken).users.messages.modify({ userId: "me", id, requestBody: { addLabelIds: [labelId], removeLabelIds: ["INBOX"] } });
  } catch (err) {
    throw mapGmailError(err);
  }
}

export async function fetchRecentEmails(accessToken: string, count: number, hours: TimeWindow | null = null): Promise<InboxScan> {
  // "Last 8/16/48 hours": only emails after that exact moment (still at most `count`).
  const q = gmailQuery(hours);
  const gmail = gmailClient(accessToken);
  try {
    return await scanWithoutSensitive<ParsedEmail>(
      {
        listIds: async (n) => {
          const list = await gmail.users.messages.list({ userId: "me", maxResults: n, labelIds: ["INBOX"], ...(q ? { q } : {}) });
          return (list.data.messages ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
        },
        // Step 1: sender and subject only, no body.
        headers: async (id) => {
          const m = await gmail.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: ["From", "Subject"] });
          const headers = m.data.payload?.headers ?? undefined;
          return { id: m.data.id ?? id, from: header(headers, "From"), subject: header(headers, "Subject") };
        },
        // Step 2: full content, only ever called for emails that aren't sensitive.
        fullEmail: async (id) => parseMessage((await gmail.users.messages.get({ userId: "me", id, format: "full" })).data),
      },
      count,
    );
  } catch (err) {
    throw mapGmailError(err);
  }
}
