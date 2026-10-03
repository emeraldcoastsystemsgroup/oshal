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
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const configPath = path.join(root, 'src/shared/logger/pino-config.json');
const config = require(configPath);
const logger = require('../../any-bot/server/utils/logger');
const helpers = require('../../any-bot/server/services/queue-manager/LoggingStandard');

/** Capture the real stdout stream; no Pino, serializer, adapter or helper is mocked. */
async function capture(fn) {
  const original = process.stdout.write;
  let output = '';
  process.stdout.write = function (chunk, encoding, callback) {
    output += chunk.toString();
    if (typeof encoding === 'function') encoding();
    else if (callback) callback();
    return true;
  };
  try { await fn(); } finally { process.stdout.write = original; }
  return output.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
function plant(target, field, value) {
  const segments = field.split('.').map((s) => s === '*' ? 'nested' : s);
  let cursor = target;
  for (const segment of segments.slice(0, -1)) cursor = cursor[segment] ??= {};
  cursor[segments.at(-1)] = value;
}
test('actual JavaScript module writes JSON with module, correlation and every shared redaction path', async () => {
  const payload = { ticketId: 'synthetic-ticket', agentId: 'synthetic-agent', runId: 'synthetic-run', phase: 3 };
  for (const field of config.redact.paths) plant(payload, field, 'synthetic-secret-' + field);
  const [line] = await capture(() => logger.child({ module: 'fixture' }).info('event', payload));
  assert.equal(line.module, 'fixture');
  assert.equal(line.ticketId, 'synthetic-ticket');
  assert.equal(line.agentId, 'synthetic-agent');
  assert.equal(line.runId, 'synthetic-run');
  assert.equal(line.phase, 3);
  assert.equal(line.level, 30);
  assert.equal(line.msg, 'event');
  assert.match(line.time, /^\d{4}-\d\d-\d\dT.*Z$/);
  assert.equal(JSON.stringify(line).includes('synthetic-secret-'), false);
  assert.ok((JSON.stringify(line).match(/\[REDACTED\]/g) || []).length >= config.redact.paths.length);
});
test('legacy and object-first signatures retain metadata, errors and inherited redaction', async () => {
  const err = Object.assign(new Error('synthetic failure'), { token: 'synthetic-error-token-sentinel' });
  const child = logger.child({ module: 'compatibility', ticketId: 'ticket-child', token: 'synthetic-binding-token-sentinel' });
  const rows = await capture(() => {
    child.error('legacy error', err);
    child.error({ err, agentId: 'agent-object' }, 'native error');
    child.error(err, 'error-first');
    child.warn('metadata error', { error: err, count: 2 });
    child.info('value %s', 'visible', { secret: 'synthetic-metadata-secret-sentinel' });
    child.log('info', 'generic', { ok: true });
    child.log({ level: 'warn', message: 'record', ok: true });
    child.stream.write('HTTP synthetic fixture\n');
  });
  assert.equal(rows.length, 8);
  for (const row of rows) {
    assert.equal(row.module, 'compatibility');
    assert.equal(row.ticketId, 'ticket-child');
    assert.equal(row.token, '[REDACTED]');
  }
  for (const row of rows.slice(0, 4)) {
    assert.equal(row.err.type, 'Error');
    assert.equal(row.err.message, 'synthetic failure');
    assert.match(row.err.stack, /Error: synthetic failure/);
    assert.equal(row.err.token, '[REDACTED]');
  }
  assert.equal(rows[1].agentId, 'agent-object');
  assert.equal(rows[3].count, 2);
  assert.equal(rows[4].msg, 'value visible');
  assert.equal(rows[5].ok, true);
  assert.equal(rows[6].level, 40);
  assert.equal(rows[7].msg, 'HTTP synthetic fixture');
  assert.equal(JSON.stringify(rows).includes('synthetic-metadata-secret-sentinel'), false);
});
test('LoggingStandard preserves helpers, return/rethrow and known identifiers with serialized err', async () => {
  const oldLevel = logger.level;
  logger.level = 'debug';
  const service = helpers.createLogger('SyntheticService');
  const err = new Error('synthetic traced failure');
  try {
    const rows = await capture(async () => {
      service.start('work', { ticketId: 't', agentId: 'a' });
      service.complete('work', { ticketId: 't', count: 1 });
      service.error('work', err, { ticketId: 't', agentId: 'a' });
      service.event('work', 'DONE', { ticketId: 't', agentId: 'a' });
      service.info('work', 'info', { ticketId: 't' });
      service.warn('work', 'warn');
      service.debug('work', 'debug');
      helpers.logTicketEvent('SyntheticService', 'work', 't', 'ticket');
      helpers.logAgentEvent('SyntheticService', 'work', 'a', 't', 'agent');
      helpers.logPhaseTransition('SyntheticService', 'work', 't', 1, 2, 'a');
      assert.equal(await service.traced('success', async () => 42, { ticketId: 't' }), 42);
      await assert.rejects(service.traced('failure', async () => { throw err; }, { ticketId: 't' }), (e) => e === err);
    });
    assert.equal(rows.length, 14);
    assert.ok(rows.every((r) => r.module === 'SyntheticService'));
    assert.equal(rows[0].ticketId, 't');
    assert.equal(rows[0].agentId, 'a');
    assert.equal(rows[2].err.message, err.message);
    assert.match(rows[2].err.stack, /synthetic traced failure/);
    assert.equal(rows[8].agentId, 'a');
    assert.equal(rows[9].ticketId, 't');
    assert.equal(rows[11].ticketId, 't');
    assert.equal(rows[13].ticketId, 't');
  } finally { logger.level = oldLevel; }
});
test('migrated metrics failure retains known ticket/agent/phase and real serialized error', async () => {
  const AgentMetricsService = require('../../any-bot/server/services/queue-manager/AgentMetricsService');
  const err = new Error('synthetic Redis failure');
  const service = new AgentMetricsService({ zadd: async () => { throw err; } });
  const [row] = await capture(() => service.recordResponseTime('a', 't', 2, 100));
  assert.equal(row.module, 'AgentMetricsService');
  assert.equal(row.ticketId, 't');
  assert.equal(row.agentId, 'a');
  assert.equal(row.phase, 2);
  assert.equal(row.err.message, err.message);
  assert.match(row.err.stack, /synthetic Redis failure/);
});
test('level filtering and independent child contexts remain compatible', async () => {
  const old = logger.level;
  logger.level = 'warn';
  try {
    const rows = await capture(() => {
      logger.info('filtered');
      logger.child({ module: 'one', ticketId: 'one' }).warn('one');
      logger.child({ module: 'two', ticketId: 'two' }).warn('two');
    });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.ticketId), ['one', 'two']);
    assert.equal(logger.isLevelEnabled('debug'), false);
  } finally { logger.level = old; }
});

/** Reproduce the shipped relative source layout, using only installed dependencies. */
function packaged() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oshal-logging-package-'));
  for (const file of ['any-bot/server/utils/logger.js', 'src/shared/logger/pino-config.json']) {
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, file), target);
  }
  fs.symlinkSync(fs.realpathSync(path.join(root, 'node_modules')), path.join(dir, 'node_modules'), 'junction');
  return dir;
}
test('real Node resolution loads the logger in relocated image source layout, not from cwd', async () => {
  const dir = packaged();
  try {
    const loaded = createRequire(path.join(dir, 'probe.cjs'))('./any-bot/server/utils/logger.js');
    const [row] = await capture(() => loaded.child({ module: 'packaged' }).info('packaged', { token: 'fixture-secret' }));
    assert.equal(row.module, 'packaged');
    assert.equal(row.token, '[REDACTED]');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('missing or malformed shared config refuses module load without fallback', () => {
  for (const malformed of [false, true]) {
    const dir = packaged();
    try {
      const file = path.join(dir, 'src/shared/logger/pino-config.json');
      if (malformed) fs.writeFileSync(file, '{invalid-json');
      else fs.unlinkSync(file);
      assert.throws(() => createRequire(path.join(dir, 'probe.cjs'))('./any-bot/server/utils/logger.js'));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});
test('both adapters load the one contract; actual build inputs preserve its runtime paths', () => {
  const tsSource = fs.readFileSync(path.join(root, 'src/shared/logger/logger.ts'), 'utf8');
  const jsSource = fs.readFileSync(path.join(root, 'any-bot/server/utils/logger.js'), 'utf8');
  assert.match(tsSource, /import pinoConfig from '.\/pino-config.json'/);
  assert.match(tsSource, /LOG_REDACT_OPTIONS = pinoConfig.redact/);
  assert.match(tsSource, /\.\.\.pinoConfig,/);
  assert.match(jsSource, /require\('\.\.\/\.\.\/\.\.\/src\/shared\/logger\/pino-config.json'\)/);
  assert.match(jsSource, /\.\.\.config,/);
  for (const source of [tsSource, jsSource]) {
    assert.match(source, /timestamp: pino.stdTimeFunctions.isoTime/);
    assert.match(source, /serializers: \{ err: pino.stdSerializers.err \}/);
    assert.doesNotMatch(source, /paths:\s*\[/);
  }
  const docker = fs.readFileSync(path.join(root, 'Dockerfile.oshal'), 'utf8');
  assert.match(docker, /COPY src\/shared\/ \.\/src\/shared\//);
  assert.match(docker, /COPY any-bot\/server\/ \.\/any-bot\/server\//);
  for (const file of ['tsconfig.json', 'tsconfig.server.json']) {
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')).compilerOptions.resolveJsonModule, true);
  }
});
test('Test Lab registers the actual suites without claiming container acceptance from HTTP', () => {
  const scenario = fs.readFileSync(path.join(root, 'src/app/routes/test-lab-logging-scenarios.ts'), 'utf8');
  const registry = fs.readFileSync(path.join(root, 'src/app/routes/test-lab-scenarios.ts'), 'utf8');
  assert.match(registry, /\.\.\.LOGGING_SCENARIOS/);
  for (const file of ['javascript-structured-logging.test.cjs', 'javascript-logging-guard.test.cjs']) {
    assert.ok(scenario.includes('tests/logging/' + file));
  }
  assert.match(scenario, /state: 'gap'/);
  assert.match(scenario, /container/);
});
