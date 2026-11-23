const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

const src = fs.readFileSync("app/dashboard/page.tsx", "utf8");
const block = src.slice(src.indexOf("// Stake choices"), src.indexOf("export default function"));
const js = ts.transpileModule(block + "\nthis.isAllowedStake = isAllowedStake; this.stakeProblem = stakeProblem;", { compilerOptions: { target: "ES2020" } }).outputText;
const ctx = {}; vm.runInNewContext(js, ctx);

test("exactly the amounts 500, 1000, 1500 ... 50000 are allowed (100 of them)", () => {
  const ok = [];
  for (let v = 0; v <= 60000; v += 1) if (ctx.isAllowedStake(v)) ok.push(v);
  assert.strictEqual(ok.length, 100);
  assert.deepStrictEqual(ok.slice(0, 4), [500, 1000, 1500, 2000]);
  assert.strictEqual(ok[ok.length - 1], 50000);
  assert.ok(ok.every((v) => v % 500 === 0));
});

test("amounts in between or outside the range are not allowed", () => {
  for (const bad of [0, 200, 250, 290, 499, 501, 750, 1250, 50500, 55000, -500, 1000.5, NaN]) assert.strictEqual(ctx.isAllowedStake(bad), false, String(bad));
  for (const good of [500, 1000, 1500, 2000, 2500, 25000, 50000]) assert.strictEqual(ctx.isAllowedStake(good), true, String(good));
});

test("a typed amount like 1300 is rejected and the message says what to use instead", () => {
  const m = ctx.stakeProblem(1300);
  assert.match(m, /1,300 is not allowed/);
  assert.match(m, /1,500 instead/);
  assert.match(m, /1,000/);
  assert.match(m, /2,000 and above/);
  assert.match(ctx.stakeProblem(200), /minimum stake is .*500/);
  assert.match(ctx.stakeProblem(51000), /maximum stake is .*50,000/);
  assert.match(ctx.stakeProblem(NaN), /Enter a stake amount/);
  assert.strictEqual(ctx.stakeProblem(1500), null);
  assert.strictEqual(ctx.stakeProblem(50000), null);
});

test("the dashboard validates with the same rule before sending a challenge", () => {
  assert.match(src, /const stakeIssue = stakeProblem\(stake\)/);
  assert.match(src, /if \(stakeIssue\)/);
});
