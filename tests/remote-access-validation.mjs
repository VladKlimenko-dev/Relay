import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
const bundle = path.resolve("node_modules/.relay-unit/remote-access-validation.mjs");
execFileSync(path.resolve("node_modules/.bin/esbuild"), ["shared/remoteAccessValidation.ts", "--bundle", "--platform=node", "--format=esm", `--outfile=${bundle}`, "--log-level=error"]);
const { remoteAccessRequirements: requirements } = await import(bundle);
const valid = { username: "relay-owner", address: "8.8.8.8", port: 5443,
  password: "test-only-password!", confirmation: "test-only-password!", current: "", configured: false, confirmEnable: true };
assert.deepEqual(requirements(valid), []);
for (const [change, message] of [
  [{ confirmEnable: false }, /Tick/],
  [{ password: "short", confirmation: "short" }, /15–256/],
  [{ confirmation: "" }, /Repeat/],
  [{ confirmation: "different-password" }, /match exactly/],
  [{ configured: true }, /current Relay password/],
  [{ username: "a b" }, /username/],
  [{ username: "owner " }, /username/],
  [{ address: " " }, /IPv4/],
  [{ port: 80 }, /HTTPS port/],
  [{ port: 5443.5 }, /HTTPS port/],
]) {
  const result = requirements({ ...valid, ...change });
  assert.ok(result.some(reason => message.test(reason)), JSON.stringify(change));
  assert.ok(result.every(reason => !reason.includes(valid.password)), "password must not be echoed");
}
assert.deepEqual(requirements({ ...valid, configured: true, current: "old-test-password" }), []);
console.log("PASS: visible reasons for checkbox, password length/mismatch, existing-password, username, address and port blockers; valid form enabled; credentials not echoed.");
