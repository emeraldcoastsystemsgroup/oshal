/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — WS-Discovery (2005/04 draft, the dialect Windows WSDAPI speaks) responder on UDP 3702: multicast Hello on start / Bye on stop, and unicast ProbeMatches / ResolveMatches answers to client Probe / Resolve. This is the SECOND discovery rail alongside mDNS, and the reason it exists: Windows boxes routinely have a dead native mDNS listener (browsers/Bonjour steal port 5353 from Dnscache) while WSD — owned by svchost on 3702 — keeps working; hardware printers (HP et al.) are discovered through it. Listens on BOTH IPv4 (239.255.255.250) and IPv6 (ff02::c) since Windows often prefers the IPv6 link-local path for WSD. All failures degrade to warnings; mDNS and manual add remain.
 */
'use strict';

const dgram = require('dgram');
const os = require('os');
const { extractTag, messageId } = require('./xml');

const WSD_PORT = 3702;
const V4_GROUP = '239.255.255.250';
const V6_GROUP = 'ff02::c';
const ACTION = {
  HELLO: 'http://schemas.xmlsoap.org/ws/2005/04/discovery/Hello',
  BYE: 'http://schemas.xmlsoap.org/ws/2005/04/discovery/Bye',
  PROBE: 'http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe',
  PROBE_MATCHES: 'http://schemas.xmlsoap.org/ws/2005/04/discovery/ProbeMatches',
  RESOLVE: 'http://schemas.xmlsoap.org/ws/2005/04/discovery/Resolve',
  RESOLVE_MATCHES: 'http://schemas.xmlsoap.org/ws/2005/04/discovery/ResolveMatches',
};

/**
 * @description Build a WS-Discovery SOAP envelope.
 * @param {{action:string,to:string,relatesTo?:string,body:string,instanceId:number,messageNumber:number}} parts Envelope parts.
 * @returns {string} The XML text.
 */
function envelope(parts) {
  const relates = parts.relatesTo ? `<wsa:RelatesTo>${parts.relatesTo}</wsa:RelatesTo>` : '';
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:wsa="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:wsd="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:wsdp="http://schemas.xmlsoap.org/ws/2006/02/devprof">
<soap:Header>
<wsa:To>${parts.to}</wsa:To>
<wsa:Action>${parts.action}</wsa:Action>
<wsa:MessageID>${messageId()}</wsa:MessageID>
${relates}
<wsd:AppSequence InstanceId="${parts.instanceId}" MessageNumber="${parts.messageNumber}"/>
</soap:Header>
<soap:Body>${parts.body}</soap:Body>
</soap:Envelope>`;
}

/**
 * @description The endpoint block shared by Hello/ProbeMatch/ResolveMatch.
 * @param {{uuidUri:string,xaddrs:string}} identity The device identity.
 * @returns {string} The XML fragment.
 */
function endpointBlock(identity) {
  return `<wsa:EndpointReference><wsa:Address>${identity.uuidUri}</wsa:Address></wsa:EndpointReference>
<wsd:Types>wsdp:Device</wsd:Types>
<wsd:XAddrs>${identity.xaddrs}</wsd:XAddrs>
<wsd:MetadataVersion>1</wsd:MetadataVersion>`;
}

/**
 * @description Whether a Probe's Types constraint matches this device: empty
 * Types matches everything, otherwise any type whose local name is Device.
 * @param {string} xml The Probe XML.
 * @returns {boolean} True when this device should answer.
 */
function probeMatchesDevice(xml) {
  const types = extractTag(xml, 'Types');
  if (!types) return true;
  return types.split(/\s+/).some((t) => t.split(':').pop() === 'Device');
}

/**
 * @description Handle one datagram: answer Probe with ProbeMatches and Resolve
 * (for our endpoint) with ResolveMatches, unicast back to the sender.
 * @param {object} state The responder state.
 * @param {Buffer} msg The datagram.
 * @param {object} rinfo Sender address info.
 * @param {import('dgram').Socket} sock The receiving socket (replies go out the same family).
 * @returns {void}
 */
function handleDatagram(state, msg, rinfo, sock) {
  const xml = msg.toString('utf8');
  const action = extractTag(xml, 'Action');
  let reply = null;
  if (action === ACTION.PROBE && probeMatchesDevice(xml)) {
    state.messageNumber += 1;
    reply = envelope({
      action: ACTION.PROBE_MATCHES,
      to: 'http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous',
      relatesTo: extractTag(xml, 'MessageID'),
      instanceId: state.instanceId,
      messageNumber: state.messageNumber,
      body: `<wsd:ProbeMatches><wsd:ProbeMatch>${endpointBlock(state.identity)}</wsd:ProbeMatch></wsd:ProbeMatches>`,
    });
  } else if (action === ACTION.RESOLVE && xml.includes(state.identity.uuidUri)) {
    state.messageNumber += 1;
    reply = envelope({
      action: ACTION.RESOLVE_MATCHES,
      to: 'http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous',
      relatesTo: extractTag(xml, 'MessageID'),
      instanceId: state.instanceId,
      messageNumber: state.messageNumber,
      body: `<wsd:ResolveMatches><wsd:ResolveMatch>${endpointBlock(state.identity)}</wsd:ResolveMatch></wsd:ResolveMatches>`,
    });
  }
  if (reply) {
    const buf = Buffer.from(reply, 'utf8');
    sock.send(buf, 0, buf.length, rinfo.port, rinfo.address);
    state.log.info('answered WSD ' + (action === ACTION.PROBE ? 'Probe' : 'Resolve'), { client: rinfo.address });
  }
}

/**
 * @description Multicast an announcement (Hello or Bye) on one socket.
 * @param {object} state The responder state.
 * @param {import('dgram').Socket} sock The socket.
 * @param {string} group The multicast group for this family.
 * @param {string} action Hello or Bye action URI.
 * @returns {void}
 */
function announce(state, sock, group, action) {
  state.messageNumber += 1;
  const name = action === ACTION.HELLO ? 'Hello' : 'Bye';
  const body = `<wsd:${name}>${endpointBlock(state.identity)}</wsd:${name}>`;
  const xml = envelope({
    action,
    to: 'urn:schemas-xmlsoap-org:ws:2005:04:discovery',
    instanceId: state.instanceId,
    messageNumber: state.messageNumber,
    body,
  });
  const buf = Buffer.from(xml, 'utf8');
  try {
    sock.send(buf, 0, buf.length, state.port, group);
  } catch (err) {
    state.log.warn(`WSD ${name} send failed`, { group, error: err.message });
  }
}

/**
 * @description Open the IPv4 WSD socket: bind 3702 (shared), join the group on
 * the pinned interface, send Hello.
 * @param {object} state The responder state.
 * @param {string} interfaceAddress The pinned IPv4, '' for default.
 * @returns {Promise<import('dgram').Socket|null>} The socket, null on failure.
 */
function openV4(state, interfaceAddress) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', (err) => {
      state.log.warn('WSD IPv4 socket error', { error: err.message });
      resolve(null);
    });
    sock.on('message', (msg, rinfo) => handleDatagram(state, msg, rinfo, sock));
    sock.bind(state.port, () => {
      try {
        sock.addMembership(V4_GROUP, interfaceAddress || undefined);
        if (interfaceAddress) sock.setMulticastInterface(interfaceAddress);
      } catch (err) {
        state.log.warn('WSD IPv4 group join failed', { error: err.message });
      }
      announce(state, sock, V4_GROUP, ACTION.HELLO);
      resolve(sock);
    });
  });
}

/**
 * @description Open the IPv6 WSD socket: bind 3702 (shared), join ff02::c on
 * every non-internal interface scope, send Hello. Best-effort — Windows often
 * prefers this path for WSD, but failure only degrades to IPv4.
 * @param {object} state The responder state.
 * @returns {Promise<import('dgram').Socket|null>} The socket, null on failure.
 */
function openV6(state) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp6', reuseAddr: true });
    sock.on('error', (err) => {
      state.log.warn('WSD IPv6 socket error - continuing IPv4-only', { error: err.message });
      resolve(null);
    });
    sock.on('message', (msg, rinfo) => handleDatagram(state, msg, rinfo, sock));
    sock.bind(state.port, () => {
      let joined = 0;
      for (const addrs of Object.values(os.networkInterfaces())) {
        for (const addr of addrs || []) {
          if (addr.family === 'IPv6' && !addr.internal && addr.scopeid) {
            try {
              sock.addMembership(V6_GROUP, `::%${addr.scopeid}`);
              joined += 1;
            } catch (err) { /* scope not joinable - skip */ }
          }
        }
      }
      if (!joined) {
        try { sock.addMembership(V6_GROUP); joined += 1; } catch (err) {
          state.log.warn('WSD IPv6 group join failed - continuing IPv4-only', { error: err.message });
        }
      }
      if (joined) announce(state, sock, V6_GROUP, ACTION.HELLO);
      resolve(joined ? sock : null);
    });
  });
}

/**
 * @description Start the WS-Discovery responder.
 * @param {{uuidUri:string,xaddrs:string,interfaceAddress?:string}} identity Device identity: endpoint urn, metadata URL(s), pinned IPv4.
 * @param {{info:Function,warn:Function}} log Structured logger.
 * @param {number} [portOverride] Alternate UDP port — tests only (3702 is shared with the OS WSD service, so unicast test probes would race it).
 * @returns {Promise<{stop:()=>Promise<void>}>} Handle whose stop() sends Bye and closes sockets.
 */
async function startWsdDiscovery(identity, log, portOverride) {
  const state = {
    identity,
    log,
    port: portOverride || WSD_PORT,
    instanceId: Math.floor(Date.now() / 1000),
    messageNumber: 0,
  };
  const v4 = await openV4(state, identity.interfaceAddress || '');
  const v6 = await openV6(state);
  if (v4 || v6) {
    log.info('WSD discovery active', { port: WSD_PORT, ipv4: !!v4, ipv6: !!v6, xaddrs: identity.xaddrs });
  } else {
    log.warn('WSD discovery unavailable on both address families');
  }
  return {
    stop: async () => {
      if (v4) {
        announce(state, v4, V4_GROUP, ACTION.BYE);
        await new Promise((r) => setTimeout(r, 50));
        try { v4.close(); } catch (err) { /* already closed */ }
      }
      if (v6) {
        announce(state, v6, V6_GROUP, ACTION.BYE);
        await new Promise((r) => setTimeout(r, 50));
        try { v6.close(); } catch (err) { /* already closed */ }
      }
    },
  };
}

module.exports = { startWsdDiscovery, ACTION, WSD_PORT };
