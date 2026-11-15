/** Voice ownership rules (no network): run with `npm.cmd test`. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { accessFor, cleanDescription, isAdminEmail, ownerKey, ownerOf, tagDescription } from "./voice-access.ts";

const SECRET = "test-secret";
const A = { owner: ownerKey("alice@gmail.com", SECRET), admin: false };
const B = { owner: ownerKey("bob@gmail.com", SECRET), admin: false };
const ADMIN = { owner: ownerKey("owner@gmail.com", SECRET), admin: true };

test("owner ids are stable, case-insensitive, private, and differ per person", () => {
  assert.equal(ownerKey("Alice@Gmail.com ", SECRET), A.owner);
  assert.notEqual(A.owner, B.owner);
  assert.match(A.owner, /^[a-f0-9]{16}$/);
  assert.ok(!A.owner.includes("alice"));
  assert.notEqual(ownerKey("alice@gmail.com", "another-secret"), A.owner);
});

test("tags round-trip and are hidden from the description shown to people", () => {
  const d = tagDescription("A calm narrator.", A.owner);
  assert.equal(ownerOf(d), A.owner);
  assert.equal(cleanDescription(d), "A calm narrator.");
  assert.equal(ownerOf(tagDescription(d, B.owner)), B.owner, "re-tagging replaces, never stacks");
  assert.ok(tagDescription("x".repeat(2000), A.owner).length <= 1000);
  assert.equal(ownerOf("No tag here."), null);
});

test("someone else's voice is invisible and unusable; your own is fully yours", () => {
  const alices = { category: "cloned", description: tagDescription("Mine", A.owner) };
  assert.deepEqual(accessFor(alices, A), { visible: true, usable: true, removable: true, mine: true });
  assert.deepEqual(accessFor(alices, B), { visible: false, usable: false, removable: false, mine: false });
  assert.deepEqual(accessFor(alices, ADMIN), { visible: false, usable: false, removable: false, mine: false }, "even admins can't use another person's tagged clone");
});

test("presets are for everyone and can't be removed", () => {
  for (const me of [A, B, ADMIN]) assert.deepEqual(accessFor({ category: "premade", description: "" }, me), { visible: true, usable: true, removable: false, mine: false });
});

test("untagged clones (made before tags) are admin-only", () => {
  const legacy = { category: "cloned", description: "Created in Voice Inbox Assistant from the owner's own recording." };
  assert.equal(accessFor(legacy, A).visible, false);
  assert.equal(accessFor(legacy, A).usable, false);
  assert.deepEqual(accessFor(legacy, ADMIN), { visible: true, usable: true, removable: true, mine: false });
});

test("untagged designed voices (shared characters) are usable by all, removable only by admins", () => {
  const coach = { category: "generated", description: "A loud football coach." };
  assert.deepEqual(accessFor(coach, A), { visible: true, usable: true, removable: false, mine: false });
  assert.equal(accessFor(coach, ADMIN).removable, true);
});

test("admin list matching", () => {
  assert.equal(isAdminEmail("Owner@Gmail.com", " owner@gmail.com , x@y.com"), true);
  assert.equal(isAdminEmail("alice@gmail.com", "owner@gmail.com"), false);
  assert.equal(isAdminEmail("", ""), false);
  assert.equal(isAdminEmail("alice@gmail.com", ""), false);
});
