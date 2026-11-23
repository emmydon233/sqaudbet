// Tests for the Naija pop-up message collections, random picking, dedupe and the 5-second timing contract.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const vm = require("node:vm");

function load(rel, deps = {}) {
  const src = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(js, { module: mod, exports: mod.exports, require: (n) => deps[n] ?? require(n), ...deps.globals });
  return mod.exports;
}
const messages = load("lib/naija/messages.ts");

function fakeWindow() {
  const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
  const listeners = [];
  const win = { localStorage: store(), sessionStorage: store(), dispatchEvent: (e) => { listeners.forEach((l) => l(e)); return true; }, addEventListener: (_t, l) => listeners.push(l) };
  return { win, listeners };
}
function loadBus(win) {
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } }
  return load("lib/naija/popup-bus.ts", { "./messages": messages, globals: { window: win, CustomEvent, Date, Math, JSON, Object, Map, Number } });
}

test("four separate, non-empty collections that include the owner's examples", () => {
  for (const k of ["login", "register", "win", "loss"]) assert.ok(messages.NAIJA_MESSAGES[k].length >= 5, k);
  assert.ok(messages.LOGIN_MESSAGES.includes("Omo, wetin carry you come here? 😂"));
  assert.ok(messages.REGISTER_MESSAGES.includes("Omo, you don finally join us! 😂"));
  assert.ok(messages.WIN_MESSAGES.includes("Oya collect your flowers, superstar! 💐") || messages.WIN_MESSAGES.some((m) => m.startsWith("Oya collect your flowers")));
  assert.ok(messages.LOSS_MESSAGES.includes("Your village people try small today o!"));
  const all = Object.values(messages.NAIJA_MESSAGES).flat();
  assert.equal(new Set(all).size, all.length, "no message is shared between occasions");
});

test("pickNaijaMessage stays inside its category, is random, and avoids an immediate repeat", () => {
  for (const kind of ["login", "register", "win", "loss"]) {
    const seen = new Set();
    for (let i = 0; i < 400; i += 1) { const m = messages.pickNaijaMessage(kind); assert.ok(messages.NAIJA_MESSAGES[kind].includes(m)); seen.add(m); }
    assert.ok(seen.size > 1, `${kind}: random`);
    for (let i = 0; i < 100; i += 1) assert.notEqual(messages.pickNaijaMessage(kind, messages.NAIJA_MESSAGES[kind][0]), messages.NAIJA_MESSAGES[kind][0]);
  }
});

test("all four occasions queue a pop-up of the right kind", () => {
  const { win, listeners } = fakeWindow(); const bus = loadBus(win); const got = [];
  listeners.push((e) => got.push(e.detail));
  assert.ok(bus.queueNaijaPopup("login", "login:u1", 15000));
  assert.ok(bus.queueNaijaPopup("register", "register:u1"));
  assert.ok(bus.queueGameResultPopup("pool", "m1", "u1", true));
  assert.ok(bus.queueGameResultPopup("whot", "m2", "u1", false));
  assert.deepEqual(got.map((d) => d.kind), ["login", "register", "win", "loss"]);
  got.forEach((d) => assert.ok(messages.NAIJA_MESSAGES[d.kind].includes(d.message)));
});

test("duplicates are suppressed: repeated auth callbacks and repeated result events", () => {
  const { win } = fakeWindow(); const bus = loadBus(win);
  assert.equal(bus.queueNaijaPopup("login", "login:u1", 15000), true);
  assert.equal(bus.queueNaijaPopup("login", "login:u1", 15000), false, "second login callback within window");
  assert.equal(bus.queueGameResultPopup("pool", "m1", "u1", true), true);
  assert.equal(bus.queueGameResultPopup("pool", "m1", "u1", true), false, "duplicate result event");
  assert.equal(bus.queueGameResultPopup("pool", "m1", "u1", false), false, "result for the same match never flips");
  assert.equal(bus.queueGameResultPopup("pool", "m2", "u1", true), true, "a different match is a new occasion");
  assert.equal(bus.queueGameResultPopup("ludo", "m1", "u1", true), true, "same id on another game is separate");
});

test("a pop-up parked before navigation is taken exactly once", () => {
  const { win } = fakeWindow(); const bus = loadBus(win);
  bus.queueNaijaPopup("login", "login:u9", 15000);
  const first = bus.takePendingNaijaPopup();
  assert.equal(first.kind, "login");
  assert.equal(bus.takePendingNaijaPopup(), null);
});

test("host component: exactly 5000 ms lifetime, close button, animations, one pop-up at a time", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "components/naija-popup.tsx"), "utf8");
  assert.match(src, /NAIJA_POPUP_MS = 5000/);
  assert.match(src, /setTimeout\(\(\) => \{ setShown\(null\); setLeaving\(false\); currentKey\.current = null; \}, NAIJA_POPUP_MS\)/, "removed at 5 s");
  assert.match(src, /NAIJA_POPUP_MS - EXIT_MS/, "exit animation finishes inside the 5 s");
  assert.match(src, /aria-label="Close message"/);
  assert.match(src, /@keyframes sbn-in/); assert.match(src, /@keyframes sbn-out/);
  assert.match(src, /prefers-reduced-motion/);
  assert.match(src, /currentKey\.current === req\.key/, "duplicate key already on screen is ignored");
});

test("wiring: pop-ups are triggered only after success and never inside auth/settlement logic", () => {
  const rd = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
  const login = rd("app/login/page.tsx");
  assert.ok(login.indexOf("if (error)") < login.indexOf('queueNaijaPopup("login"'), "after the error check");
  assert.match(rd("app/register/page.tsx"), /data\.user && data\.session\) \{\s*queueNaijaPopup\("register"/);
  assert.match(rd("app/pool3d/page.tsx"), /queueGameResultPopup\("pool"/);
  assert.match(rd("app/whot/page.tsx"), /queueGameResultPopup\("whot"/);
  assert.match(rd("app/layout.tsx"), /<NaijaPopupHost \/>/);
});
