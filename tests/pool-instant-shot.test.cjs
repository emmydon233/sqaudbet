const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const page = fs.readFileSync("app/pool3d/page.tsx", "utf8");

test("instant shot: local prediction runs before the server request and the server can still correct or reject it", () => {
  const predict = page.indexOf("simulateShot(startSnap");
  const play = page.indexOf("api.playApprovedShot(startSnap");
  const fetchShot = page.indexOf("/shot`");
  assert.ok(predict > 0 && play > predict && fetchShot > play, "prediction + playback must come before the /shot request");
  assert.match(page, /rollback\(\)/, "a rejected shot is rolled back");
  assert.match(page, /settleTo\(server\)/, "a differing server result overrides the local one");
  assert.match(page, /if \(!final\.gameOver\)/, "a match-ending shot is never shown optimistically");
  assert.match(page, /expectedVersion: stateVersionRef\.current/, "the server still checks the version");
});
