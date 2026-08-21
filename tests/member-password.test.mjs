import assert from "node:assert/strict";
import test from "node:test";

import {
  CHUNKED_PASSWORD_SALT_PREFIX,
  createMemberPasswordSalt,
  deriveMemberPasswordHash,
  MEMBER_PASSWORD_ITERATIONS,
  PBKDF2_RUNTIME_MAX_ITERATIONS,
} from "../db/member-password.ts";

test("member password hashing stays within the Worker PBKDF2 call limit", async () => {
  assert.equal(MEMBER_PASSWORD_ITERATIONS, 210_000);
  assert.equal(PBKDF2_RUNTIME_MAX_ITERATIONS, 100_000);
  const salt = createMemberPasswordSalt();
  assert.match(salt, /^v2\$[0-9a-f]{32}$/);

  const first = await deriveMemberPasswordHash("test-password", salt);
  const second = await deriveMemberPasswordHash("test-password", salt);
  const different = await deriveMemberPasswordHash("other-password", salt);
  assert.equal(first.length, 64);
  assert.equal(first, second);
  assert.notEqual(first, different);
  assert.ok(salt.startsWith(CHUNKED_PASSWORD_SALT_PREFIX));
});

test("legacy password format remains available for supported iteration counts", async () => {
  const hash = await deriveMemberPasswordHash("legacy-password", "00112233445566778899aabbccddeeff", 1_000);
  assert.equal(hash.length, 64);
});
