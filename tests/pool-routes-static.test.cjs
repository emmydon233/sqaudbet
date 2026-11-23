// Source-level guards (no DB available in CI sandbox): every pool route that exposes or mutates a
// match must authenticate and call checkPoolAccess BEFORE touching match data or the commit RPC.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

for (const file of ["app/api/pool/[matchId]/shot/route.ts", "app/api/pool/[matchId]/session/route.ts"]) {
  test(`${file}: authenticates and gates access first`, () => {
    const s = read(file);
    const auth = s.indexOf("auth.getUser");
    const gate = s.indexOf("checkPoolAccess(");
    assert.ok(auth > 0 && gate > auth, "getUser then checkPoolAccess");
    assert.match(s, /Bearer/);
    const firstData = Math.min(...["rpc(", '.from("matches")', '.from("pool_game_sessions")'].map((k) => { const i = s.indexOf(k); return i < 0 ? Infinity : i; }));
    assert.ok(gate < firstData, "access gate precedes data access");
  });
}

test("shot route keeps version check, turn enforcement and the idempotent commit RPC", () => {
  const s = read("app/api/pool/[matchId]/shot/route.ts");
  assert.match(s, /expectedVersion !== currentVersion/);
  assert.match(s, /pool_commit_authoritative_shot/);
  assert.match(s, /parseShotInput/);
});

test("session route returns no wallet fields", () => {
  const s = read("app/api/pool/[matchId]/session/route.ts");
  assert.doesNotMatch(s, /balance|wallet_/i);
});
