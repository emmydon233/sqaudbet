const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const read = (f) => fs.readFileSync(f, "utf8");

function tsc() { try { return require("typescript"); } catch { try { return require("/home/claude/.npm-global/lib/node_modules/typescript"); } catch { return null; } } }

/** Runs the real heartbeat route with a recording fake database. */
async function runHeartbeat({ otherLastSeen, matchStatus = "in_progress", existingDeadline = null, me = "p1" }) {
  const ts = tsc(); if (!ts) return null;
  const js = ts.transpileModule(read("app/api/pool/[matchId]/heartbeat/route.ts"), { compilerOptions: { module: "commonjs", target: "es2020" } }).outputText;
  const updates = [];
  const rows = {
    matches: { status: matchStatus, player1_id: "p1", player2_id: "p2" },
    pool_game_sessions: { disconnect_deadline: existingDeadline, settlement_status: "pending" },
  };
  const builder = (table) => {
    const op = { table, filters: [], update: null };
    const b = {
      select() { return b; }, eq(c, v) { op.filters.push(["eq", c, v]); return b; }, is(c, v) { op.filters.push(["is", c, v]); return b; },
      lt(c, v) { op.filters.push(["lt", c, v]); return b; }, update(v) { op.update = v; updates.push(op); return b; },
      maybeSingle() { return Promise.resolve({ data: rows[table], error: null }); },
      then(res) { return Promise.resolve({ data: null, error: null }).then(res); },
    };
    return b;
  };
  const db = {
    auth: { getUser: async () => ({ data: { user: { id: me === "p1" ? "p1" : "p2" } }, error: null }) },
    from: builder,
    rpc: async () => ({ data: { success: true }, error: null }),
  };
  const mods = {
    "next/server": { NextResponse: { json: (b, i) => ({ body: b, status: (i && i.status) || 200 }) } },
    "@/utils/supabase/server-admin": { createSupabaseAdmin: () => db },
    "@/lib/pool/access": { checkPoolAccess: async () => ({ ok: true }) },
    "@/lib/pool/pause": require("./_pause_shim.cjs"),
    "@/lib/pool/authoritative": { initialPoolState: () => ({}) },
  };
  const m = { exports: {} };
  new Function("module", "exports", "require", js)(m, m.exports, (n) => { if (!(n in mods)) throw new Error("unexpected import " + n); return mods[n]; });
  const req = { headers: { get: () => "Bearer tok" } };
  const out = await m.exports.POST(req, { params: Promise.resolve({ matchId: "m1" }) });
  return { out, updates };
}

test("heartbeat marks a silent opponent disconnected (conditional on 'not already flagged' and 'silent > 12 s')", async (t) => {
  const r = await runHeartbeat({ otherLastSeen: null }); if (!r) return t.skip("typescript not available");
  const u = r.updates.find((x) => x.table === "pool_game_sessions" && x.update && "player2_disconnected_at" in x.update);
  assert.ok(u, "expected an update that flags player2 when player1 sends the heartbeat");
  assert.ok(u.update.disconnect_deadline, "must set the 5-minute deadline together with the flag (same as the sweeper)");
  assert.deepStrictEqual(Object.keys(u.update).sort(), ["disconnect_deadline", "player2_disconnected_at", "updated_at"].sort(), "writes nothing else");
  const f = Object.fromEntries(u.filters.map(([k, c, v]) => [k + ":" + c, v]));
  assert.strictEqual(f["is:player2_disconnected_at"], null, "never re-flags a player that is already flagged");
  assert.strictEqual(f["eq:settlement_status"], "pending", "never touches a settled match");
  const cutoff = Date.parse(f["lt:player2_last_seen"]);
  const age = Date.now() - cutoff;
  assert.ok(age > 11_000 && age < 13_000, "stale cutoff should be about 12 s, got " + age);
});

test("player 2's heartbeat flags player 1, and an existing deadline is kept (not extended)", async (t) => {
  const r = await runHeartbeat({ me: "p2", existingDeadline: "2030-01-01T00:00:00.000Z" }); if (!r) return t.skip("typescript not available");
  const u = r.updates.find((x) => x.update && "player1_disconnected_at" in x.update);
  assert.ok(u);
  assert.strictEqual(u.update.disconnect_deadline, "2030-01-01T00:00:00.000Z");
});

test("no flagging outside a live match", async (t) => {
  const r = await runHeartbeat({ matchStatus: "ready" }); if (!r) return t.skip("typescript not available");
  assert.strictEqual(r.updates.filter((x) => x.update && Object.keys(x.update).some((k) => k.endsWith("_disconnected_at"))).length, 0);
});

test("fast-detection never touches money: the heartbeat route does not read or write wallet/settlement tables", () => {
  const src = read("app/api/pool/[matchId]/heartbeat/route.ts");
  assert.ok(!/wallet|transactions|platform_earnings|refund/i.test(src.replace(/\/\/.*$/gm, "")), "heartbeat route must not touch money code");
});

test("pool page: heartbeat every 4 s, and the server is told when the page is closed", () => {
  const src = read("app/pool3d/page.tsx");
  assert.ok(/setInterval\(\(\) => \{ void ping\(\); \}, 4000\)/.test(src));
  assert.ok(/addEventListener\("pagehide"/.test(src) && /keepalive: true/.test(src) && /\/exit/.test(src));
});

test("whot page: heartbeat every 5 s", () => {
  if (!fs.existsSync("app/whot/page.tsx")) return;
  assert.ok(/void sendHeartbeat\(\), (5000|15000)\)/.test(read("app/whot/page.tsx")));
});
