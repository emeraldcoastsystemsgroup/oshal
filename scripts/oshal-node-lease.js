#!/usr/bin/env node
/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add the trusted host-automation bridge to the PostgreSQL node-resource lease used by both daily recap and the controller video pump.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Bound database connection startup so a wedged container port fails the recap preflight instead of hanging the scheduler indefinitely.
 *
 * @description Token-bound node-resource lease CLI. It is intended to run inside the controller
 * container via docker exec: the initiating host is trusted, the database role remains the normal
 * least-privilege app role, and this invocation explicitly stamps its transaction as system work.
 */
'use strict';

const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** @description Emit the single machine-readable record consumed by the PowerShell runner. */
function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** @description Emit a structured error without exposing the connection string. */
function fail(message, code = 1) {
  process.stderr.write(`${JSON.stringify({ level: 'error', module: 'oshal-node-lease', message })}\n`);
  process.exitCode = code;
}

/** @description Read one required command-line flag without positional ambiguity. */
function flag(name, required = true) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if ((!value || value.startsWith('--')) && required) throw new TypeError(`${name} is required`);
  return value;
}

/** @description Validate a bounded operational label before it reaches PostgreSQL. */
function label(value, name, max) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f]/.test(normalized)) {
    throw new TypeError(`${name} is invalid`);
  }
  return normalized;
}

/** @description Parse the same bounded TTL enforced by migration 120. */
function ttlSeconds() {
  const value = Number(flag('--ttl-seconds'));
  if (!Number.isInteger(value) || value < 30 || value > 43200) {
    throw new TypeError('--ttl-seconds must be an integer between 30 and 43200');
  }
  return value;
}

/** @description Parse optional non-secret audit metadata with a small upper bound. */
function metadata() {
  const raw = flag('--metadata-json', false) || '{}';
  if (Buffer.byteLength(raw, 'utf8') > 8192) throw new TypeError('--metadata-json exceeds 8192 bytes');
  const value = JSON.parse(raw);
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new TypeError('--metadata-json must contain an object');
  }
  return value;
}

/** @description Run one operation in an explicit system/operator transaction on the app role. */
async function withOperatorClient(work) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 10_000 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('oshal.current_sub','',true), set_config('oshal.is_operator','on',true)");
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

/** @description Acquire an absent/expired resource and return the incumbent on contention. */
async function acquire(client) {
  const resource = label(flag('--resource'), 'resource', 255);
  const holder = label(flag('--holder'), 'holder', 255);
  const purpose = label(flag('--purpose'), 'purpose', 120);
  const result = await client.query(
    'SELECT * FROM oshal_acquire_node_resource_lease($1,$2,$3,$4,$5,$6::jsonb)',
    [resource, randomUUID(), holder, purpose, ttlSeconds(), JSON.stringify(metadata())],
  );
  if (!result.rows[0]) throw new Error('lease acquisition returned no row');
  const row = result.rows[0];
  if (!row.acquired) process.exitCode = 3;
  return row;
}

/** @description Renew only the exact unexpired capability. */
async function renew(client) {
  const leaseId = flag('--lease-id');
  if (!UUID.test(leaseId)) throw new TypeError('--lease-id must be a UUID');
  const result = await client.query(
    'SELECT * FROM oshal_renew_node_resource_lease($1,$2,$3,$4)',
    [label(flag('--resource'), 'resource', 255), leaseId,
      label(flag('--holder'), 'holder', 255), ttlSeconds()],
  );
  if (!result.rows[0]) process.exitCode = 3;
  return { renewed: Boolean(result.rows[0]), ...(result.rows[0] || {}) };
}

/** @description Release only the exact capability. */
async function release(client) {
  const leaseId = flag('--lease-id');
  if (!UUID.test(leaseId)) throw new TypeError('--lease-id must be a UUID');
  const result = await client.query(
    'SELECT oshal_release_node_resource_lease($1,$2,$3) AS released',
    [label(flag('--resource'), 'resource', 255), leaseId, label(flag('--holder'), 'holder', 255)],
  );
  const released = Boolean(result.rows[0]?.released);
  if (!released) process.exitCode = 3;
  return { released };
}

/** @description Dispatch the closed command set; arbitrary SQL is deliberately impossible. */
async function main() {
  const command = process.argv[2];
  const operations = { acquire, renew, release };
  if (!Object.prototype.hasOwnProperty.call(operations, command)) {
    throw new TypeError('usage: oshal-node-lease <acquire|renew|release> [flags]');
  }
  output(await withOperatorClient(operations[command]));
}

module.exports = { acquire, renew, release, withOperatorClient };

if (require.main === module) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
