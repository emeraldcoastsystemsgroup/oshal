/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Prove MAVLink signing, system pinning, replay rejection,
 *                     |                             | and signed command/ACK exchange across a real TCP socket.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Prove an unframed oversized TCP stream is bounded and closes the hardware command link without crashing the node.
 */

import * as net from 'node:net';
import { once } from 'node:events';
import {
  MavLinkPacketParser,
  MavLinkPacketSplitter,
  MavLinkProtocolV2,
  common,
  minimal,
  send,
  sendSigned,
  type MavLinkData,
  type MavLinkPacket,
} from 'node-mavlink';
import { afterEach, describe, expect, it } from 'vitest';
import { DroneCommandError, MavlinkDroneProvider } from '@/features/drone';

const SIGNING_KEY = Buffer.alloc(32, 0x31);
const WRONG_KEY = Buffer.alloc(32, 0x7f);
const VEHICLE_SYSTEM_ID = 7;
const VEHICLE_COMPONENT_ID = 1;
const VEHICLE_LINK_ID = 23;
const SIGNING_EPOCH_MS = Date.now();

interface MavlinkPeer {
  server: net.Server;
  socket: Promise<net.Socket>;
  port: number;
}

const providers: MavlinkDroneProvider[] = [];
const peers: MavlinkPeer[] = [];

/** Close every real socket opened by a case so Vitest never inherits a control link. */
afterEach(async () => {
  for (const provider of providers.splice(0)) provider.disconnect();
  for (const peer of peers.splice(0)) {
    const sockets = await Promise.allSettled([peer.socket]);
    for (const socket of sockets) if (socket.status === 'fulfilled') socket.value.destroy();
    peer.server.close();
    await once(peer.server, 'close').catch(() => undefined);
  }
});

/** Open a loopback TCP server that exercises node-mavlink's actual packet parser. */
async function openPeer(onPacket?: (packet: MavLinkPacket, socket: net.Socket) => void): Promise<MavlinkPeer> {
  let accept: ((socket: net.Socket) => void) | undefined;
  const socket = new Promise<net.Socket>((resolve) => { accept = resolve; });
  const server = net.createServer((connection) => {
    const reader = connection.pipe(new MavLinkPacketSplitter()).pipe(new MavLinkPacketParser());
    if (onPacket) reader.on('data', (packet: MavLinkPacket) => onPacket(packet, connection));
    accept?.(connection);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('loopback MAVLink peer did not bind a TCP port');
  const peer = { server, socket, port: address.port };
  peers.push(peer);
  return peer;
}

/** Construct an autopilot heartbeat with deterministic state for protocol tests. */
function heartbeat(customMode = 0): InstanceType<typeof minimal.Heartbeat> {
  const message = new minimal.Heartbeat();
  message.type = 2 as never;
  message.autopilot = 3 as never;
  message.baseMode = 0 as never;
  message.customMode = customMode;
  message.systemStatus = 4 as never;
  message.mavlinkVersion = 3 as never;
  return message;
}

/** Construct live global-position telemetry in the mapping's integer wire units. */
function position(lat: number, lon: number, relativeAlt = 12_000): InstanceType<typeof common.GlobalPositionInt> {
  const message = new common.GlobalPositionInt();
  message.timeBootMs = 100;
  message.lat = lat;
  message.lon = lon;
  message.alt = relativeAlt;
  message.relativeAlt = relativeAlt;
  message.vx = 0;
  message.vy = 0;
  message.vz = 0;
  message.hdg = 9_000;
  return message;
}

/** Construct a successful COMMAND_ACK for one outbound command. */
function commandAck(command: number): InstanceType<typeof common.CommandAck> {
  const message = new common.CommandAck();
  message.command = command as never;
  message.result = 0 as never;
  message.progress = 100;
  message.resultParam2 = 0;
  message.targetSystem = 255;
  message.targetComponent = 190;
  return message;
}

/** Write one signed flight-controller packet over the real stream. */
async function writeSigned(
  socket: net.Socket,
  message: MavLinkData,
  timestamp: number,
  key = SIGNING_KEY,
  systemId = VEHICLE_SYSTEM_ID,
): Promise<void> {
  await sendSigned(socket, message, key, VEHICLE_LINK_ID, systemId, VEHICLE_COMPONENT_ID, SIGNING_EPOCH_MS + timestamp);
}

/** Write an unsigned packet so the provider must reject it at its protocol boundary. */
async function writeUnsigned(socket: net.Socket, message: MavLinkData): Promise<void> {
  await send(socket, message, new MavLinkProtocolV2(VEHICLE_SYSTEM_ID, VEHICLE_COMPONENT_ID));
}

/** Poll an observable outcome without replacing the TCP/protocol boundary with a mock. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for MAVLink boundary state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Create a signed provider pointed at one ephemeral loopback peer. */
function providerFor(peer: MavlinkPeer): MavlinkDroneProvider {
  const provider = new MavlinkDroneProvider({
    droneId: 'signed-real-boundary',
    url: `tcp://127.0.0.1:${peer.port}`,
    signingKey: SIGNING_KEY,
    signingLinkId: 41,
  });
  providers.push(provider);
  return provider;
}

describe('MAVLink signed TCP boundary', () => {
  it('requires an exact signing key before a hardware link can exist', () => {
    expect(() => new MavlinkDroneProvider({ url: 'tcp://127.0.0.1:9', signingKey: Buffer.alloc(31) }))
      .toThrow(DroneCommandError);
  });

  it('drops unsigned, invalid, pre-heartbeat, cross-system, and replayed telemetry', async () => {
    const peer = await openPeer();
    const provider = providerFor(peer);
    const connecting = provider.connect(3_000);
    const socket = await peer.socket;

    await writeUnsigned(socket, heartbeat());
    await writeSigned(socket, heartbeat(), 10, WRONG_KEY);
    await writeSigned(socket, position(301_000_000, -864_000_000), 11);
    await writeSigned(socket, heartbeat(), 12);
    await writeSigned(socket, position(302_000_000, -865_000_000), 13);
    await connecting;
    expect(provider.getTelemetry().position.lat).toBe(30.2);

    await writeSigned(socket, position(400_000_000, -865_000_000), 14, SIGNING_KEY, 8);
    await writeSigned(socket, position(410_000_000, -865_000_000), 13);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(provider.getTelemetry().position.lat).toBe(30.2);

    await writeSigned(socket, position(303_000_000, -866_000_000), 14);
    await waitFor(() => provider.getTelemetry().position.lat === 30.3);

    const closed = once(socket, 'close');
    socket.write(Buffer.alloc(5_000, 0x55));
    await closed;
    await expect(provider.arm()).rejects.toThrow('no MAVLink link');
  });

  it('signs every command and waits for a fresh authenticated ACK', async () => {
    const outbound: MavLinkPacket[] = [];
    const commands: number[] = [];
    let nextInboundTimestamp = 102;
    const peer = await openPeer((packet, socket) => {
      outbound.push(packet);
      if (packet.header.msgid !== common.CommandLong.MSG_ID) return;
      const command = packet.protocol.data(packet.payload, common.CommandLong).command as number;
      commands.push(command);
      if (command === 176) {
        void writeUnsigned(socket, commandAck(command));
        void writeSigned(socket, commandAck(command), nextInboundTimestamp++);
        return;
      }
      void writeSigned(socket, commandAck(command), nextInboundTimestamp - 1);
      setTimeout(() => { void writeSigned(socket, commandAck(command), nextInboundTimestamp++); }, 120);
    });
    const provider = providerFor(peer);
    const connecting = provider.connect(3_000);
    const socket = await peer.socket;
    await writeSigned(socket, heartbeat(), 100);
    await writeSigned(socket, position(302_000_000, -865_000_000), 101);
    await connecting;

    const started = Date.now();
    await provider.arm();
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(commands).toEqual([176, 400]);
    expect(outbound.length).toBeGreaterThanOrEqual(2);
    expect(outbound.every((packet) => packet.signature?.matches(SIGNING_KEY) === true)).toBe(true);
    const timestamps = outbound.map((packet) => packet.signature?.timestamp ?? 0);
    expect(timestamps.every((timestamp, index) => index === 0 || timestamp > timestamps[index - 1])).toBe(true);
  });
});
