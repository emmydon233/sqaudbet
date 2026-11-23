// loads lib/pool/pause.ts for tests that import it through the "@/" alias
const fs = require("node:fs");
let ts; try { ts = require("typescript"); } catch { ts = require("/home/claude/.npm-global/lib/node_modules/typescript"); }
const js = ts.transpileModule(fs.readFileSync("lib/pool/pause.ts", "utf8"), { compilerOptions: { module: "commonjs", target: "es2020" } }).outputText;
const m = { exports: {} }; new Function("module", "exports", js)(m, m.exports); module.exports = m.exports;
