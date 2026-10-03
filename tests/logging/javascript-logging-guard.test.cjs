/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard ADR-171 cross-runtime structured logging and its actual module boundary.
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspectSource, checkTree, main } = require('../../scripts/check-javascript-logging.cjs');
const root = path.resolve(__dirname, '../..');

test('complete current server tree passes the blocking guard', () => {
  assert.deepEqual(checkTree(root), []);
});
test('syntax guard refuses direct, aliased, bracket and imported console and Winston', () => {
  for (const violation of [
    'console.log("bad")', 'console["warn"]("bad")', 'const sink = console; sink.error("bad")',
    'globalThis["console"].warn("bad")', 'const { log } = console;',
    'const log = require("winston");', 'import log from "winston";',
    'const log = await import("winston/lib/winston");', 'require("node:console");',
  ]) assert.ok(inspectSource(violation).length, violation);
  assert.deepEqual(inspectSource('// console.log("example")\nconst note = "winston"; logger.info("winston");'), []);
});
test('planted console and Winston violations each turn the exact gate red, then restore green', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-logging-mutation-'));
  try {
    const server = path.join(dir, 'any-bot/server');
    fs.mkdirSync(server, { recursive: true });
    const file = path.join(server, 'new-provider.js');
    const clean = 'module.exports = {};\n';
    fs.writeFileSync(file, clean);
    assert.equal(main(dir, { write() {} }), 0);
    for (const mutation of ['console.error("synthetic fixture");', 'require("winston");']) {
      fs.writeFileSync(file, clean + mutation);
      let evidence = '';
      assert.equal(main(dir, { write(line) { evidence += line; } }), 1);
      assert.match(evidence, /new-provider.js:2: (console-reference|logger-import)/);
      fs.writeFileSync(file, clean);
      assert.equal(main(dir, { write() {} }), 0);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('missing source fails closed; the normal local gate invokes scan and tests', () => {
  assert.equal(main(path.join(os.tmpdir(), 'missing-oshal-logging-tree'), { write() {} }), 1);
  const ci = fs.readFileSync(path.join(root, 'scripts/ci-local.sh'), 'utf8');
  assert.match(ci, /run_gate javascript-logging gate_javascript_logging/);
  assert.match(ci, /node --max-old-space-size=384 scripts\/check-javascript-logging.cjs/);
  assert.match(ci, /tests\/logging\/\*.test.cjs/);
});
