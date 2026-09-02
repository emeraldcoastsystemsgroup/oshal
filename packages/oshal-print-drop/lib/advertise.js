/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — mDNS/DNS-SD advertisement (_ipp._tcp) via bonjour-service so Windows/macOS/Linux clients discover the printer in their native Add-Printer flow. TXT records follow the IPP-everywhere shape Windows keys on: rp must match the HTTP endpoint path, pdl declares PDF so clients transcode before sending. mDNS failure (port 5353 contention, VPN, isolated Wi-Fi) is downgraded to a warning — the printer stays reachable by manual URL — never a crash.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Advertise the '_print' subtype (PTR at _print._sub._ipp._tcp) — IPP Everywhere (PWG 5100.14) requires it and Windows' Add-Printer discovery browses that subtype specifically, so the bare-type advertisement answered raw _ipp._tcp browses but never appeared in Windows Settings. Found live: self-browse saw the printer, the Windows Add-device list did not.
 */
'use strict';

/**
 * @description Publish the printer over mDNS. Returns a handle whose stop()
 * withdraws the advertisement (mDNS goodbye) and closes the sockets.
 * @param {{printerName:string,port:number,hostname:string,uuid:string}} config Printer identity.
 * @param {{info:Function,warn:Function}} log Structured logger.
 * @returns {{stop:()=>Promise<void>}} The advertisement handle (no-op when mDNS is unavailable).
 */
function advertisePrinter(config, log) {
  let bonjour;
  try {
    const { Bonjour } = require('bonjour-service');
    bonjour = new Bonjour(undefined, (err) => {
      log.warn('mDNS socket error - discovery may be degraded; manual URL add still works', { error: err && err.message });
    });
    bonjour.publish({
      name: config.printerName,
      type: 'ipp',
      subtypes: ['print'],
      port: config.port,
      txt: {
        txtvers: '1',
        qtotal: '1',
        rp: 'ipp/print',
        ty: config.printerName,
        note: config.hostname,
        pdl: 'application/pdf,application/octet-stream',
        product: '(oshal print-drop)',
        Color: 'T',
        Duplex: 'F',
        UUID: config.uuid,
        adminurl: `http://${config.hostname}:${config.port}/`,
        'printer-state': '3',
        'printer-type': '0x480900e',
      },
    });
    log.info('advertising printer over mDNS', { name: config.printerName, type: '_ipp._tcp', port: config.port });
  } catch (err) {
    log.warn('mDNS advertisement unavailable - clients must add the printer by URL', { error: err.message });
    return { stop: async () => {} };
  }
  return {
    stop: () =>
      new Promise((resolve) => {
        try {
          bonjour.unpublishAll(() => {
            bonjour.destroy();
            resolve();
          });
        } catch (_err) {
          resolve();
        }
      }),
  };
}

module.exports = { advertisePrinter };
