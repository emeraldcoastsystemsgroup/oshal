/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial creation — ADR-099 fleet plane
 *                     |                             | coverage: heartbeat ingest/liveness/staleness, id + local
 *                     |                             | claim guards, remote command proxying over the secret rail
 *                     |                             | (injected fetch), event ack cursor, and the real-hardware
 *                     |                             | confirm rail on the fleet-aware DroneService.
 */

import { describe, expect, it } from 'vitest';
import {
  DroneCommandError,
  DroneFleet,
  DroneService,
  RemoteDroneProvider,
  type DroneNodeHeartbeat,
  type DroneTelemetry,
} from '@/features/drone';

function telemetry(over: Partial<DroneTelemetry> = {}): DroneTelemetry {
  return {
    droneId: 'drone-1',
    status: 'disarmed',
    position: { lat: 30.0, lon: -86.0, alt: 0 },
    home: { lat: 30.0, lon: -86.0, alt: 0 },
    headingDeg: 0,
    groundSpeedMps: 0,
    batteryPct: 100,
    distanceFromHomeM: 0,
    mission: null,
    failsafe: null,
    ...over,
  };
}

function heartbeat(over: Partial<DroneNodeHeartbeat> = {}): DroneNodeHeartbeat {
  return {
    droneId: 'drone-1',
    endpointUrl: 'http://127.0.0.1:9',
    engine: 'sim',
    telemetry: telemetry(),
    events: [],
    ...over,
  };
}

describe('DroneFleet — node registry + liveness', () => {
  it('mints a remote drone on first heartbeat and lists it online', () => {
    let t = 0;
    const fleet = new DroneFleet({ clock: () => t });
    fleet.ingestHeartbeat(heartbeat());
    const list = fleet.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ droneId: 'drone-1', remote: true, online: true, kind: 'sim' });
    expect(list[0].telemetry?.batteryPct).toBe(100);
  });

  it('marks a silent node offline and rejects commands to it', () => {
    let t = 0;
    const fleet = new DroneFleet({ clock: () => t });
    fleet.ingestHeartbeat(heartbeat());
    expect(fleet.isOnline('drone-1')).toBe(true);
    t += 20_000; // > HEARTBEAT_STALE_MS
    expect(fleet.isOnline('drone-1')).toBe(false);
    expect(() => fleet.get('drone-1')).toThrow(/offline/);
    fleet.ingestHeartbeat(heartbeat()); // heartbeat resumes → back online
    expect(fleet.isOnline('drone-1')).toBe(true);
  });

  it('rejects unknown drones, hostile ids, and node claims on local ids', () => {
    const fleet = new DroneFleet({ clock: () => 0 });
    expect(() => fleet.get('ghost')).toThrow(DroneCommandError);
    expect(() => fleet.ingestHeartbeat(heartbeat({ droneId: '../etc' }))).toThrow(/invalid droneId/);
    fleet.registerLocal('alpha', new RemoteDroneProvider({ droneId: 'alpha' }) as never);
    // registerLocal stores it as local (remote: null) — a node may not heartbeat-claim it.
    expect(() => fleet.ingestHeartbeat(heartbeat({ droneId: 'alpha' }))).toThrow(/local drone/);
  });

  it('acks the highest event seq and serves events since a cursor', () => {
    const fleet = new DroneFleet({ clock: () => 0 });
    const ack1 = fleet.ingestHeartbeat(heartbeat({ events: [
      { seq: 1, ts: 0, level: 'info', message: 'Armed' },
      { seq: 2, ts: 1, level: 'info', message: 'Taking off' },
    ] }));
    expect(ack1).toBe(2);
    const ack2 = fleet.ingestHeartbeat(heartbeat({ events: [{ seq: 2, ts: 1, level: 'info', message: 'Taking off' }] }));
    expect(ack2).toBe(2); // duplicate seq deduped
    expect(fleet.get('drone-1').getEvents(1).map((e) => e.message)).toEqual(['Taking off']);
  });
});

describe('RemoteDroneProvider — command proxying', () => {
  it('POSTs the command envelope to the node and refreshes cached telemetry', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const remote = new RemoteDroneProvider({
      droneId: 'drone-1',
      clock: () => 0,
      fetchImpl: async (url, init) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return { ok: true, status: 200, json: async () => ({ ok: true, telemetry: telemetry({ status: 'armed' }) }), text: async () => '' };
      },
    });
    remote.ingestHeartbeat(heartbeat());
    await remote.arm();
    expect(calls[0].url).toBe('http://127.0.0.1:9/api/drone-node/command');
    expect(calls[0].body).toMatchObject({ command: 'arm' });
    expect(remote.getTelemetry().status).toBe('armed');
  });

  it('surfaces a node-side rejection as DroneCommandError with the node reason', async () => {
    const remote = new RemoteDroneProvider({
      droneId: 'drone-1',
      clock: () => 0,
      fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ error: 'cannot arm while hold' }), text: async () => '' }),
    });
    remote.ingestHeartbeat(heartbeat());
    await expect(remote.arm()).rejects.toThrow('cannot arm while hold');
  });

  it('rejects commands before any heartbeat established an endpoint', async () => {
    const remote = new RemoteDroneProvider({ droneId: 'drone-1', clock: () => 0 });
    await expect(remote.arm()).rejects.toThrow(/no known endpoint/);
    expect(() => remote.getTelemetry()).toThrow(/not reported telemetry/);
  });
});

describe('DroneService — fleet plane + hardware confirm rail', () => {
  it('keeps the embedded alpha working with no droneId (back-compat) and lists the fleet', () => {
    let t = 0;
    const svc = new DroneService({ clock: () => t });
    expect(svc.getState().droneId).toBe('alpha');
    svc.ingestHeartbeat(heartbeat());
    const ids = svc.listFleet().map((f) => f.droneId);
    expect(ids).toEqual(['alpha', 'drone-1']);
    expect(svc.getState('drone-1').online).toBe(true);
  });

  it('requires confirm for a non-sim engine but never for making the vehicle safer', async () => {
    let t = 0;
    const svc = new DroneService({ clock: () => t });
    svc.ingestHeartbeat(heartbeat({ engine: 'mavlink' }));
    // Flight-initiating command without confirm → blocked by the rail, no network attempted.
    await expect(svc.takeoff(30, 'drone-1')).rejects.toThrow(/real hardware.*confirm/);
    // With confirm the rail opens; the command then fails only because no node answers :9.
    await expect(svc.takeoff(30, 'drone-1', true)).rejects.toThrow(/unreachable|HTTP/);
    // Safety commands (land/RTL/abort) skip the confirm rail by design.
    await expect(svc.land('drone-1')).rejects.toThrow(/unreachable|HTTP/);
  });
});
