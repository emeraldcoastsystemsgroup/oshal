/**
 * Workflow Studio — surface-bridge adopter.
 *
 * The first shipped kernel surface to consume the generic surface-bridge contract (the presentations
 * surface, the original intended adopter, was carved to the store — ADR-085 Wave 2). It includes the
 * shared surface-side client and marks a small dock with `data-bridge-*` hosts, so the cockpit chat
 * rail's bot can drive this surface through the SAME manifest-keyed contract every future app uses:
 *
 *   bot reply ```oshal:surface fence  →  chat-rail producer posts a `to_surface` envelope
 *     →  cockpit relay (validates channel/version/app + this app's manifest `surface.ops`)
 *       →  THIS client renders render_options / propose / notify / set_content
 *         →  the user clicks an option  →  client emits `select` (a `to_bot` envelope)
 *           →  cockpit relay  →  chat rail turns it into a message to the bot (loop closed)
 *
 * The `app` MUST equal the manifest name (`workflow-studio`) and the ops the bot may drive are the
 * manifest's `surface.ops` allow-list — the relay fail-closes on anything else. This module adds NO
 * new vocabulary and touches none of the studio's own canvas/chat state; it is a pure additive view.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — adopt the surface-bridge client on the Workflow Studio surface (data-bridge dock: options/notices hosts + a content region) so the chat-rail bot can render selectable options here and a selection flows back to the bot. First kernel adopter of the contract.
 */

import { createSurfaceBridgeClient } from '/shared/ui/js/surface-bridge-client.js';

// One client per surface, bound to this app's manifest name. attach() starts rendering delivered
// bot→surface ops into the data-bridge-* hosts and auto-emits field_change / select back to the bot.
const bridge = createSurfaceBridgeClient({ app: 'workflow-studio' });
bridge.attach();

// Expose for debugging/manual verification from the surface console (never posts on its own).
window.__workflowStudioBridge = bridge;
