/** Cross-app draft navigation, available from an application's own selected work. */
import { stageHandoff } from './app-handoff.js';

export async function integrationPlan() {
  const response = await fetch('/api/swarm/apps/home-plan', { credentials: 'same-origin', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw Error('Could not check connected applications.');
  return (await response.json()).apps.flatMap(entry => entry.integrationSources || []);
}

/** The active frame must belong to the source manifest, including declared query selectors. */
export function ownsSurface(source, frameUrl) {
  try {
    const actual = new URL(frameUrl, window.location.href);
    if (actual.origin !== window.location.origin) return false;
    return source.surfaces.some(surface => {
      const declared = new URL(surface.url, window.location.href);
      return declared.origin === actual.origin && declared.pathname === actual.pathname
        && [...declared.searchParams].every(([key, value]) => actual.searchParams.get(key) === value);
    });
  } catch { return false; }
}

/** Bind to exactly the current frame; recheck catalog and frame after the asynchronous read. */
export function bindAppHandoffs(frame, navigate) {
  let active = true, busy = false;
  const listener = async event => {
    const m = event.data;
    if (!active || busy || !frame.isConnected || event.source !== frame.contentWindow || event.origin !== window.location.origin
      || m?.type !== 'oshal:request-app-context' || typeof m.requestId !== 'string' || m.requestId.length > 80) return;
    busy = true;
    try {
      const senderUrl = frame.contentWindow.location.href;
      const sources = await integrationPlan();
      const source = sources.find(s => s.app === m.app);
      if (!active || !frame.isConnected || frame.contentWindow.location.href !== senderUrl || !source || !ownsSurface(source, senderUrl)) throw Error('The source application is no longer available.');
      const offer = source.offers.find(o => o.id === m.offer);
      if (!stageHandoff(offer, m.context)) throw Error('This connected action is unavailable or its context is invalid.');
      event.source.postMessage({ type: 'oshal:app-context-result', requestId: m.requestId, ok: true }, event.origin);
      navigate(`tool-${offer.surface}`, { name: offer.surface, url: offer.surfaceUrl });
    } catch (error) {
      if (active && frame.isConnected) event.source.postMessage({ type: 'oshal:app-context-result', requestId: m.requestId, error: error.message }, event.origin);
    } finally { busy = false; }
  };
  window.addEventListener('message', listener);
  return () => { active = false; window.removeEventListener('message', listener); };
}

export function requestHandoff(app, offer, context) {
  if (window.parent === window) return Promise.reject(Error('Open this application in the cockpit to use connected actions.'));
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const finish = error => { clearTimeout(timer); window.removeEventListener('message', listener); error ? reject(Error(error)) : resolve(); };
    const listener = event => {
      if (event.source !== window.parent || event.origin !== window.location.origin
        || event.data?.type !== 'oshal:app-context-result' || event.data.requestId !== requestId) return;
      finish(event.data.ok ? null : event.data.error || 'Could not open the receiving application.');
    };
    const timer = setTimeout(() => finish('The cockpit did not respond. Please try again.'), 8000);
    window.addEventListener('message', listener);
    window.parent.postMessage({ type: 'oshal:request-app-context', requestId, app, offer, context }, window.location.origin);
  });
}

/** Apps supply the selected context, per offer; no DOM scraping or business reads in the shell. */
export async function mountConnectedActions({ app, element, contextForOffer }) {
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const heading = document.createElement('strong'); heading.textContent = 'Continue in another app';
  element.append(heading, status);
  try {
    const source = (await integrationPlan()).find(s => s.app === app);
    for (const offer of source?.offers || []) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = offer.label;
      button.disabled = offer.state !== 'available';
      if (button.disabled) {
        button.title = offer.state === 'unavailable' ? 'Receiving app is not loaded' : 'Receiving app needs a compatible action';
        const note = document.createElement('small'); note.textContent = `${offer.label}: ${button.title}.`; element.insertBefore(note, status);
      }
      button.addEventListener('click', async () => {
        status.textContent = ''; button.disabled = true;
        try { const context = await contextForOffer(offer.id); if (!context) throw Error('Select or enter the work to continue first.'); await requestHandoff(app, offer.id, context); }
        catch (error) { status.textContent = error.message; }
        finally { button.disabled = false; }
      });
      element.insertBefore(button, status);
    }
    if (!source?.offers?.length) status.textContent = 'No connected actions are declared for this application.';
  } catch (error) { status.textContent = error.message; }
}
