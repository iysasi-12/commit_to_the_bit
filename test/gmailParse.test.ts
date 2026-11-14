import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeEntities,
  extractBodyText,
  htmlToText,
  parseAddress,
  stripQuotedReplies,
  toInboxFields,
  truncateText,
  type GmailPart,
} from "../server/providers/gmailParse.ts";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

describe("Gmail message parsing", () => {
  it("parses sender names and addresses", () => {
    assert.deepEqual(parseAddress('"Doe, Jane" <jane@example.com>'), { name: "Doe, Jane", email: "jane@example.com" });
    assert.deepEqual(parseAddress("Bob <bob@x.org>"), { name: "Bob", email: "bob@x.org" });
    assert.deepEqual(parseAddress("solo@x.org"), { name: "solo@x.org", email: "solo@x.org" });
    assert.deepEqual(parseAddress(""), { name: "Unknown sender", email: "" });
  });

  it("decodes HTML entities in snippets", () => {
    assert.equal(decodeEntities("Tom &amp; Jerry&#39;s &quot;show&quot; &#x1F600; &nbsp;ok"), "Tom & Jerry's \"show\" 😀  ok");
    assert.equal(decodeEntities("&bogus; stays"), "&bogus; stays");
  });

  it("prefers text/plain inside multipart/alternative and decodes base64url (including - and _)", () => {
    const text = "Hello ünïcode?>>?";
    const payload: GmailPart = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", headers: [{ name: "Content-Type", value: "text/plain; charset=UTF-8" }], body: { data: b64(text) } },
        { mimeType: "text/html", body: { data: b64("<p>HTML version</p>") } },
      ],
    };
    assert.equal(extractBodyText(payload), text);
  });

  it("falls back to HTML, dropping style/script and keeping line breaks", () => {
    const html = `<html><head><style>p{color:red}</style><title>x</title></head><body><script>alert(1)</script><p>Hi&nbsp;there</p><div>Line two<br>Line three</div><ul><li>One</li><li>Two</li></ul></body></html>`;
    const payload: GmailPart = { mimeType: "multipart/mixed", parts: [{ mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", body: { data: b64(html) } }] }] };
    const out = extractBodyText(payload);
    assert.ok(!out.includes("alert"));
    assert.ok(!out.includes("color:red"));
    assert.match(out, /Hi there/);
    assert.match(out, /Line two\nLine three/);
    assert.match(out, /- One/);
  });

  it("ignores attachments that happen to be text", () => {
    const payload: GmailPart = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", filename: "notes.txt", body: { data: b64("ATTACHMENT") } },
        { mimeType: "text/plain", filename: "", body: { data: b64("Real body") } },
      ],
    };
    assert.equal(extractBodyText(payload), "Real body");
  });

  it("decodes latin1 charset parts", () => {
    const latin = Buffer.from("Café", "latin1").toString("base64url");
    const payload: GmailPart = { mimeType: "text/plain", headers: [{ name: "Content-Type", value: 'text/plain; charset="iso-8859-1"' }], body: { data: latin } };
    assert.equal(extractBodyText(payload), "Café");
  });

  it("strips quoted replies", () => {
    const text = "New reply here.\n\nOn Mon, Nov 10, 2026 at 9:00 AM Jane <jane@x.com> wrote:\n> old stuff\n> more old";
    assert.equal(stripQuotedReplies(text), "New reply here.");
    assert.equal(stripQuotedReplies("Keep\n> quoted line\nAlso keep"), "Keep\nAlso keep");
  });

  it("truncates long bodies at a sentence boundary and flags it", () => {
    const long = "Sentence one is here. ".repeat(50);
    const r = truncateText(long, 100);
    assert.equal(r.truncated, true);
    assert.ok(r.text.length <= 100);
    assert.ok(r.text.endsWith("."));
    assert.deepEqual(truncateText("short", 100), { text: "short", truncated: false });
  });

  it("maps a metadata message into inbox fields", () => {
    const fields = toInboxFields({
      id: "abc",
      threadId: "t1",
      labelIds: ["INBOX", "UNREAD"],
      snippet: "Don&#39;t forget",
      internalDate: "1763121600000",
      payload: { headers: [{ name: "From", value: "Coach <coach@school.edu>" }, { name: "Subject", value: "  Practice  " }] },
    });
    assert.equal(fields.fromName, "Coach");
    assert.equal(fields.subject, "Practice");
    assert.equal(fields.snippet, "Don't forget");
    assert.equal(fields.unread, true);
    assert.equal(fields.internalDate, 1763121600000);
  });

  it("uses a placeholder subject when missing", () => {
    assert.equal(toInboxFields({ id: "x", threadId: "x", payload: { headers: [] } }).subject, "(no subject)");
  });

  it("converts entity-heavy HTML", () => {
    assert.equal(htmlToText("<p>A &lt;tag&gt; &amp; more</p>"), "A <tag> & more");
  });
});
