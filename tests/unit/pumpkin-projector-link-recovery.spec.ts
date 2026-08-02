/**
 * PROJECTOR SURVIVAL GUARDS — the browser half of the pumpkin prop.
 *
 * The prop runs unattended for six hours in a yard with nobody watching a console, so every failure
 * here is silent by nature: the projector keeps rendering a happy face while the room it is paired to
 * no longer exists. These are BEHAVIOURAL guards — pumpkin-app.js is evaluated in a vm with an
 * injected fetch, a controllable EventSource, an injected clock and an injected timer scheduler, and
 * every assertion is about a CALL that happened (or provably did not), never a source substring.
 *
 * The three things being pinned:
 *   1. Every way the room can die ends in a RE-REGISTER, not a retry loop against a dead room.
 *      (`{type:"error",error:"unknown_room"}`, `{type:"evicted"}`, a terminal EventSource close, 70s
 *      of silence on a half-open socket, a heartbeat answering `{ok:false}`, a failed first register.)
 *   2. Exactly ONE heartbeat interval survives any number of re-registers.
 *   3. The self-hearing loop stays closed: nothing the prop says can come back in through its own mic
 *      and buy another LLM turn.
 */
import { readFileSync } from 'fs';
import path from 'path';
import vm from 'vm';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const APP_SRC = readFileSync(path.join(ROOT, 'src/pages/pumpkin/pumpkin-app.js'), 'utf8');
const AUDIO_SRC = readFileSync(path.join(ROOT, 'src/pages/pumpkin/pumpkin-audio.js'), 'utf8');

// ── An injectable clock + scheduler, so "70 seconds of silence" costs no wall time ──────────────
interface Timer { at: number; fn: (...a: unknown[]) => void; args: unknown[]; every: number | null }

class FakeClock {
  now = 1_700_000_000_000;
  private seq = 1;
  readonly timers = new Map<number, Timer>();

  setTimeout = (fn: (...a: unknown[]) => void, ms = 0, ...args: unknown[]): number => {
    const id = this.seq++;
    this.timers.set(id, { at: this.now + ms, fn, args, every: null });
    return id;
  };

  setInterval = (fn: (...a: unknown[]) => void, ms = 0, ...args: unknown[]): number => {
    const id = this.seq++;
    this.timers.set(id, { at: this.now + ms, fn, args, every: ms });
    return id;
  };

  clearTimeout = (id: number): void => { this.timers.delete(id); };
  clearInterval = (id: number): void => { this.timers.delete(id); };

  /** How many repeating timers are live — the stacked-heartbeat detector. */
  intervalCount(): number {
    return [...this.timers.values()].filter((t) => t.every !== null).length;
  }

  /** Fire everything due within `ms`, in real due order, advancing `now` as it goes. */
  tick(ms: number): void {
    const target = this.now + ms;
    for (let guard = 0; guard < 10_000; guard++) {
      let pickId = -1;
      let pick: Timer | null = null;
      for (const [id, t] of this.timers) {
        if (t.at <= target && (pick === null || t.at < pick.at)) { pick = t; pickId = id; }
      }
      if (!pick) break;
      this.now = pick.at;
      if (pick.every !== null) pick.at = this.now + pick.every;
      else this.timers.delete(pickId);
      pick.fn(...pick.args);
    }
    this.now = target;
  }
}

/** Drain the microtask queue so promise chains inside the vm settle before we assert. */
async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

// ── DOM / platform doubles ──────────────────────────────────────────────────────────────────────
function makeClassList() {
  const set = new Set<string>();
  return {
    add: (c: string) => { set.add(c); },
    remove: (c: string) => { set.delete(c); },
    contains: (c: string) => set.has(c),
    toggle: (c: string, force?: boolean) => {
      const on = force === undefined ? !set.has(c) : force;
      if (on) set.add(c); else set.delete(c);
      return on;
    },
  };
}

function makeElement(id: string) {
  const listeners = new Map<string, ((e: unknown) => void)[]>();
  return {
    id,
    textContent: '',
    className: '',
    hidden: true,
    classList: makeClassList(),
    onclick: null as null | (() => void),
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      listeners.set(type, [...(listeners.get(type) || []), fn]);
    },
    /** Deliver a real DOM-ish event so the button paths are driven, not called directly. */
    fire: (type: string, evt: Record<string, unknown> = {}) => {
      for (const fn of listeners.get(type) || []) fn({ preventDefault: () => {}, pointerId: 1, ...evt });
    },
    setPointerCapture: () => {},
  };
}

interface Harness {
  clock: FakeClock;
  ctx: Record<string, unknown>;
  fetchCalls: { url: string; method: string; body: unknown }[];
  es: FakeEventSource[];
  els: Map<string, ReturnType<typeof makeElement>>;
  audio: FakeAudio;
  face: { calls: string[] };
  order: string[];
  countFetches: (fragment: string) => number;
  registerCount: () => number;
  /** Every AbortSignal handed to fetch, in call order — "was the wedged request really cancelled?" */
  signals: AbortSignal[];
  advance: (ms: number) => Promise<void>;
  routes: Map<string, () => { ok?: boolean; status?: number; json?: unknown; hold?: boolean }>;
  /** Resolve the oldest held request — used to hold a reply open across the whole "thinking" turn. */
  release: (json: unknown) => Promise<void>;
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  closed = false;
  onopen: null | (() => void) = null;
  onmessage: null | ((m: { data: string }) => void) = null;
  onerror: null | (() => void) = null;

  constructor(public url: string) { FakeEventSource.instances.push(this); }
  close(): void { this.closed = true; this.readyState = 2; }
  open(): void { this.readyState = 1; this.onopen?.(); }
  emit(evt: unknown): void { this.onmessage?.({ data: JSON.stringify(evt) }); }
  fail(readyState: number): void { this.readyState = readyState; this.onerror?.(); }
}

class FakeAudio {
  speaking = false;
  lastCb: Record<string, (v?: unknown) => void> | null = null;
  startListeningCalls = 0;
  stopListeningCalls = 0;
  speakCalls: string[] = [];
  forceStopCalls = 0;
  private order: string[];

  constructor(order: string[]) { this.order = order; }
  unlock(): Promise<void> { return Promise.resolve(); }
  contextState(): string { return 'running'; }
  forceStop(): void { this.forceStopCalls += 1; }

  startListening(cb: Record<string, (v?: unknown) => void>): void {
    this.startListeningCalls += 1;
    this.order.push('startListening');
    this.lastCb = cb;
  }

  stopListening(): void {
    this.stopListeningCalls += 1;
    this.order.push('stopListening');
  }

  speak(text: string, _voice: unknown, cb: Record<string, (v?: unknown) => void>): void {
    this.speakCalls.push(text);
    this.order.push(`speak:${text}`);
    this.speaking = true;
    this.lastSpeakEnd = () => { this.speaking = false; cb.onEnd?.(); };
  }

  lastSpeakEnd: (() => void) | null = null;
}

type ScriptedRoute = () => { ok?: boolean; status?: number; json?: unknown; hold?: boolean };

/** The happy-path server, with per-test overrides layered on top. */
function defaultRoutes(overrides?: Record<string, ScriptedRoute>): Map<string, ScriptedRoute> {
  const routes = new Map<string, ScriptedRoute>();
  routes.set('/api/pumpkin/rooms/register', () => ({ json: { room: 'front-porch', label: 'Front Porch', token: 'tok-1' } }));
  routes.set('/api/pumpkin/rooms/heartbeat', () => ({ json: { ok: true, room: 'front-porch' } }));
  routes.set('/api/pumpkin/chat', () => ({ json: { reply: { say: 'Boo! The candle flickers.', expression: 'spooky', intensity: 0.9 } } }));
  for (const [k, v] of Object.entries(overrides || {})) routes.set(k, v);
  return routes;
}

/** Scripted network. A `hold: true` route never settles until the test releases it. */
function makeFetchDouble(deps: {
  fetchCalls: { url: string; method: string; body: unknown }[];
  routes: Map<string, ScriptedRoute>;
  held: ((json: unknown) => void)[];
  signals: AbortSignal[];
  presetName?: string;
}) {
  return (url: string, init: { method?: string; body?: string; signal?: AbortSignal } = {}) => {
    deps.fetchCalls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    if (init.signal) deps.signals.push(init.signal);
    const key = [...deps.routes.keys()].find((k) => url.startsWith(k));
    const scripted = key
      ? deps.routes.get(key)!()
      : { json: { preset: { name: deps.presetName || 'inflatable', label: 'Inflatable' } } } as ReturnType<ScriptedRoute>;
    const respond = (json: unknown, status = 200) => ({
      ok: scripted.ok ?? status < 400,
      status,
      json: () => Promise.resolve(json ?? {}),
    });
    // A held request models the real 3-10s claude-code CLI spawn: the reply has NOT landed yet,
    // which is the exact window in which the ear must stay shut.
    if (scripted.hold) return new Promise((resolve) => deps.held.push((json) => resolve(respond(json))));
    return Promise.resolve(respond(scripted.json, scripted.status ?? 200));
  };
}

function makeDocumentDouble(els: Map<string, ReturnType<typeof makeElement>>) {
  return {
    readyState: 'complete',
    visibilityState: 'visible',
    fullscreenElement: null,
    documentElement: { requestFullscreen: () => {} },
    exitFullscreen: () => {},
    body: { classList: makeClassList() },
    getElementById: (id: string) => {
      if (!els.has(id)) els.set(id, makeElement(id));
      return els.get(id)!;
    },
    addEventListener: () => {},
  };
}

function makeWindowDouble(search: string, clock: FakeClock): Record<string, unknown> {
  return {
    // The projector reads window.AbortController so the think deadline can actually cancel the
    // request. It is the real one — a stub would let an "abort" that does nothing pass.
    AbortController,
    location: { search, origin: 'https://oshal.example.com', pathname: '/pumpkin/' },
    localStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: () => {},
    requestAnimationFrame: () => 0,
    performance: { now: () => clock.now },
    BroadcastChannel: class {
      onmessage: null | ((e: { data: unknown }) => void) = null;
      constructor(public name: string) {}
      postMessage(): void {}
    },
  };
}

/** Date.now() must read the injected clock — the deaf window is measured with it. */
function makeDateDouble(clock: FakeClock): DateConstructor {
  return class FakeDate extends Date { static now(): number { return clock.now; } } as DateConstructor;
}

/** Pinning random() makes the ±20% backoff jitter land exactly on the nominal step. */
function makeMathDouble(): Math {
  const fake = Object.create(Math) as Math & { random: () => number };
  fake.random = () => 0.5;
  return fake;
}

function makeFaceClass(faceCalls: string[], order: string[]) {
  return class {
    constructor() { faceCalls.push('construct'); }
    setPreset(): void { faceCalls.push('setPreset'); }
    setExpression(e: string): void { faceCalls.push(`setExpression:${e}`); order.push(`setExpression:${e}`); }
    setSpeaking(on: boolean): void { faceCalls.push(`setSpeaking:${on}`); }
    setLevel(): void {}
    render(): void {}
  };
}

/**
 * Boot pumpkin-app.js in a fresh realm with every dependency injected.
 * `opts.routes` is applied BEFORE evaluation because init() registers synchronously at load — a
 * route swapped in afterwards would be answered by the default script and prove nothing.
 */
function boot(search: string, opts: { presetName?: string; routes?: Record<string, ScriptedRoute> } = {}): Harness {
  FakeEventSource.instances = [];
  const clock = new FakeClock();
  const order: string[] = [];
  const fetchCalls: { url: string; method: string; body: unknown }[] = [];
  const els = new Map<string, ReturnType<typeof makeElement>>();
  const faceCalls: string[] = [];
  const audio = new FakeAudio(order);

  const routes = defaultRoutes(opts.routes);
  const held: ((json: unknown) => void)[] = [];
  const signals: AbortSignal[] = [];
  const fakeFetch = makeFetchDouble({ fetchCalls, routes, held, signals, presetName: opts.presetName });

  const ctx: Record<string, unknown> = {
    window: makeWindowDouble(search, clock),
    document: makeDocumentDouble(els),
    navigator: {},
    EventSource: FakeEventSource,
    fetch: fakeFetch,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    Date: makeDateDouble(clock),
    Math: makeMathDouble(),
    URLSearchParams,
    PumpkinFace: makeFaceClass(faceCalls, order),
    PumpkinAudio: class { constructor() { return audio; } },
  };
  ctx.globalThis = ctx;

  vm.runInNewContext(APP_SRC, ctx);

  const countFetches = (fragment: string) => fetchCalls.filter((c) => c.url.includes(fragment)).length;

  return {
    clock,
    ctx,
    fetchCalls,
    es: FakeEventSource.instances,
    els,
    audio,
    face: { calls: faceCalls },
    order,
    countFetches,
    registerCount: () => countFetches('/api/pumpkin/rooms/register'),
    signals,
    routes,
    advance: async (ms: number) => { clock.tick(ms); await flush(); },
    release: async (json: unknown) => {
      const next = held.shift();
      if (!next) throw new Error('release() called with nothing held');
      next(json);
      await flush();
    },
  };
}

/** Boot and let the initial register + subscribe settle. */
async function bootLive(search = '?room=Front%20Porch'): Promise<Harness> {
  const h = boot(search);
  await flush();
  h.es[0]?.open();
  await flush();
  return h;
}

describe('pumpkin projector: the room link heals itself', () => {
  it('registers exactly once on boot and opens exactly one stream for that room', async () => {
    const h = await bootLive();
    expect(h.registerCount()).toBe(1);
    expect(h.fetchCalls[h.fetchCalls.length - 1].body).toEqual({ label: 'Front Porch' });
    expect(h.es).toHaveLength(1);
    expect(h.es[0].url).toBe('/api/pumpkin/stream?room=front-porch');
    expect(h.clock.intervalCount()).toBe(1); // the heartbeat, and only the heartbeat
  });

  it('an unknown_room frame closes the stream and RE-REGISTERS instead of looping on it', async () => {
    const h = await bootLive();
    // The server's old shape: HTTP 200 then a single error frame. EventSource treats the close as a
    // dropped connection and silently retries every ~3s forever, so the prop stays deaf all night.
    h.es[0].emit({ type: 'error', error: 'unknown_room' });
    await flush();
    expect(h.es[0].closed).toBe(true);

    await h.advance(1200);
    expect(h.registerCount()).toBe(2);
    expect(h.es).toHaveLength(2);
    expect(h.es[1].closed).toBe(false);
    expect(h.audio.speakCalls).toEqual([]); // an error frame is never mistaken for speech
  });

  it('an {type:"evicted"} frame re-registers and is never forwarded as speech', async () => {
    const h = await bootLive();
    h.es[0].emit({ type: 'evicted' });
    await h.advance(1200);
    expect(h.registerCount()).toBe(2);
    expect(h.audio.speakCalls).toEqual([]);
  });

  it('a terminal EventSource close (the 409/401 path) re-registers; a transient one does not', async () => {
    const h = await bootLive();

    h.es[0].fail(0); // CONNECTING — the browser is retrying on its own; do not stampede it
    await h.advance(1200);
    expect(h.registerCount()).toBe(1);

    h.es[0].fail(2); // CLOSED — a non-2xx status. EventSource will NEVER retry this by itself.
    await h.advance(1200);
    expect(h.registerCount()).toBe(2);
  });

  it('a heartbeat answering {ok:false} re-registers — the result is read, not discarded', async () => {
    const h = await bootLive();
    h.routes.set('/api/pumpkin/rooms/heartbeat', () => ({ json: { ok: false, reason: 'unknown_room' } }));

    await h.advance(30_000);
    expect(h.countFetches('/api/pumpkin/rooms/heartbeat')).toBe(1);

    await h.advance(1200);
    expect(h.registerCount()).toBe(2);
  });

  it('three consecutive heartbeat failures re-register rather than beating into nothing', async () => {
    const h = await bootLive();
    h.routes.set('/api/pumpkin/rooms/heartbeat', () => ({ status: 503, json: { error: 'down' } }));

    // KEEP THE STREAM FED. Three 30s beats is 90s of wall clock, which is past STREAM_SILENCE_MS —
    // so without these pings the silence watchdog produces the second register on its own and this
    // test passes green with the missed-beat branch deleted (mutation-verified). The server ping is
    // exactly what a healthy SSE link delivers every 25s while the heartbeat endpoint is failing.
    await h.advance(30_000);
    h.es[0].emit({ type: 'ping' });
    await h.advance(30_000);
    h.es[0].emit({ type: 'ping' });
    expect(h.registerCount()).toBe(1); // one blip is not a re-register

    await h.advance(30_000);           // the THIRD consecutive failure
    // Assert the REASON, not just the count: the code passes a distinguishing reason to reregister()
    // and the badge renders it, so this pins the missed-beat path rather than "something recovered".
    expect(h.els.get('linkText')!.textContent).toContain('beats_lost');
    expect(h.registerCount()).toBe(1); // the retry is scheduled, not yet fired
    await h.advance(1200);
    expect(h.registerCount()).toBe(2);
  });

  it('a failed FIRST register keeps retrying instead of giving up silently', async () => {
    const h = boot('?room=Front%20Porch', {
      routes: { '/api/pumpkin/rooms/register': () => ({ status: 502, json: { error: 'bad gateway' } }) },
    });
    await flush();
    expect(h.registerCount()).toBe(1);
    expect(h.es).toHaveLength(0);

    await h.advance(1200);
    expect(h.registerCount()).toBe(2);
    await h.advance(2400);
    expect(h.registerCount()).toBe(3);

    // …and it recovers the moment the api comes back.
    h.routes.set('/api/pumpkin/rooms/register', () => ({ json: { room: 'front-porch', label: 'Front Porch', token: 'tok-1' } }));
    await h.advance(5000);
    expect(h.es.length).toBeGreaterThan(0);
  });

  it('70s of silence closes the half-open socket and re-registers; a ping resets the deadline', async () => {
    const h = await bootLive();

    // The server pings every 25s. A ping must push the deadline out — otherwise a perfectly healthy
    // link tears itself down every 70 seconds all night.
    await h.advance(60_000);
    h.es[0].emit({ type: 'ping' });
    await h.advance(60_000);
    expect(h.es[0].closed).toBe(false);
    expect(h.registerCount()).toBe(1);

    // A half-open TCP socket delivers no frames, no FIN and no error — only a deadline finds it.
    await h.advance(71_000);
    expect(h.es[0].closed).toBe(true);
    await h.advance(1200);
    expect(h.registerCount()).toBe(2);
  });

  it('exactly ONE heartbeat interval survives five re-registers', async () => {
    const h = await bootLive();
    for (let i = 0; i < 5; i++) {
      h.es[h.es.length - 1].emit({ type: 'evicted' });
      await h.advance(40_000);
      h.es[h.es.length - 1].open();
      await flush();
    }
    expect(h.registerCount()).toBeGreaterThanOrEqual(6);
    expect(h.clock.intervalCount()).toBe(1);
  });

  it('backoff grows, is capped, and never gives up', async () => {
    const h = boot('?room=Front%20Porch', {
      routes: { '/api/pumpkin/rooms/register': () => ({ status: 502, json: {} }) },
    });
    await flush();

    // random() is pinned to 0.5, so the ±20% jitter lands exactly on the nominal step.
    const steps = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    let expected = 1;
    for (const step of steps) {
      await h.advance(step - 1);
      expect(h.registerCount()).toBe(expected);
      await h.advance(2);
      expected += 1;
      expect(h.registerCount()).toBe(expected);
    }
  });

  it('a 401 stops the loops and says SIGNED OUT in large type instead of failing silently', async () => {
    const h = await bootLive();
    h.routes.set('/api/pumpkin/rooms/heartbeat', () => ({ status: 401, json: { error: 'unauthenticated' } }));

    await h.advance(30_000);
    expect(h.els.get('reauth')!.hidden).toBe(false);
    expect(h.els.get('reauthUrl')!.textContent).toBe('https://oshal.example.com/pumpkin/');
    expect(h.els.get('link')!.className).toContain('unauthorized');
    // The operator chrome is pinned open so the 4s idle auto-hide cannot conceal a dead prop.
    expect((h.ctx.document as { body: { classList: { contains: (c: string) => boolean } } }).body.classList.contains('link-bad')).toBe(true);
  });

  it('the pairing token is never dropped while a re-register is in flight', async () => {
    const h = await bootLive();
    h.routes.set('/api/pumpkin/rooms/register', () => ({ json: { room: 'front-porch', label: 'Front Porch' } })); // no token
    h.es[0].emit({ type: 'evicted' });
    await h.advance(1200);

    // A null-token window would make every phone-remote push fail invalid_room_or_token for no reason.
    h.es[h.es.length - 1].open();
    await flush();
    expect(h.els.get('link')!.className).toContain('live');
  });

  it('the browser demo never touches a server room', async () => {
    const h = boot('?demo=1&channel=preview');
    await flush();
    await h.advance(120_000);
    expect(h.countFetches('/api/pumpkin/rooms/')).toBe(0);
    expect(h.countFetches('/api/pumpkin/stream')).toBe(0);
    expect(h.es).toHaveLength(0);
  });
});

describe('pumpkin projector: the self-hearing loop stays closed', () => {
  const LOOP = '?room=Front%20Porch&mode=autonomous&listen=open';

  it('the ear stays SHUT for the whole 3-10s think, so the prop cannot answer itself', async () => {
    const h = await bootLive(LOOP);
    expect(h.audio.startListeningCalls).toBe(1);

    // pumpkin-bot is a claude-code CLI spawn per utterance: 3-10 seconds with the reply NOT landed.
    h.routes.set('/api/pumpkin/chat', () => ({ hold: true }));
    h.audio.lastCb!.onFinal!('trick or treat');
    await flush();
    expect(h.countFetches('/api/pumpkin/chat')).toBe(1);

    // The race that used to lose: recognition (continuous:false) fires onend BEFORE the reply
    // returns, so `audio.speaking` was provably false when the 400ms timer re-opened the mic —
    // and the pumpkin's own voice then landed in an already-open microphone.
    h.audio.lastCb!.onEnd!();
    await h.advance(10_000);
    expect(h.audio.startListeningCalls).toBe(1);
    expect(h.audio.speakCalls).toEqual([]);

    await h.release({ reply: { say: 'Boo!', expression: 'spooky', intensity: 0.9 } });
    expect(h.audio.speakCalls).toEqual(['Boo!']);
    expect(h.audio.startListeningCalls).toBe(1); // still shut, now because playback owns the turn
  });

  it('the mic is shut BEFORE any sound leaves the speakers', async () => {
    // Mimic mode goes straight from transcript to speech with no LLM hop, so the ONLY stopListening
    // in the log is the one speakLine itself is responsible for. Asserted as ORDER, not two spies.
    const h = await bootLive('?room=Front%20Porch&mode=mimic&listen=ptt');
    h.els.get('btnTalk')!.fire('pointerdown'); // hold to talk — the real path, not a direct call
    expect(h.audio.startListeningCalls).toBe(1);
    h.order.length = 0;
    h.audio.lastCb!.onFinal!('repeat after me');
    await flush();

    const stopAt = h.order.indexOf('stopListening');
    const speakAt = h.order.findIndex((c) => c.startsWith('speak:'));
    expect(stopAt).toBeGreaterThanOrEqual(0);
    expect(speakAt).toBeGreaterThanOrEqual(0);
    expect(stopAt).toBeLessThan(speakAt);
  });

  it('a transcript arriving during playback or the deaf window buys nothing', async () => {
    const h = await bootLive(LOOP);
    const cb = h.audio.lastCb!;
    cb.onFinal!('trick or treat');
    await flush();
    expect(h.audio.speakCalls).toEqual(['Boo! The candle flickers.']);

    cb.onFinal!('something a kid shouted mid-sentence');
    await flush();
    expect(h.countFetches('/api/pumpkin/chat')).toBe(1); // playback in progress ⇒ dropped

    h.audio.lastSpeakEnd!();          // utterance finished; 900ms deaf window opens
    await h.advance(200);
    h.audio.lastCb!.onFinal!('a completely different question');
    await flush();
    expect(h.countFetches('/api/pumpkin/chat')).toBe(1); // still inside the reverb tail ⇒ dropped

    await h.advance(2000);
    h.audio.lastCb!.onFinal!('a completely different question');
    await flush();
    expect(h.countFetches('/api/pumpkin/chat')).toBe(2); // a real guest gets through
  });

  it('late reverb of the prop\'s OWN line is rejected, an unrelated line is not', async () => {
    const h = await bootLive(LOOP);
    h.audio.lastCb!.onFinal!('trick or treat');
    await flush();
    h.audio.lastSpeakEnd!();
    await h.advance(3000);

    // Recognition punctuates and capitalizes differently — an exact compare would never fire.
    h.audio.lastCb!.onFinal!('boo the candle flickers');
    await flush();
    expect(h.countFetches('/api/pumpkin/chat')).toBe(1);

    h.audio.lastCb!.onFinal!('what is your name');
    await flush();
    expect(h.countFetches('/api/pumpkin/chat')).toBe(2);
  });

  it('a crowd of kids costs exactly one LLM turn, and the face reacts in frame 0', async () => {
    const h = await bootLive(LOOP);
    const before = h.order.length;
    h.audio.lastCb!.onFinal!('trick or treat');
    // Synchronously, before any await: the face must move the instant we hear you.
    expect(h.order.slice(before).some((c) => c.startsWith('setExpression:'))).toBe(true);

    h.audio.lastCb!.onFinal!('me too!');
    h.audio.lastCb!.onFinal!('and me!');
    await flush();
    expect(h.countFetches('/api/pumpkin/chat')).toBe(1);
  });

  it('an empty say is honoured as silence rather than a canned line that re-triggers the room', async () => {
    const h = await bootLive(LOOP);
    h.routes.set('/api/pumpkin/chat', () => ({ json: { reply: { say: '', expression: 'neutral', intensity: 0.2 } } }));
    h.audio.lastCb!.onFinal!('background television noise');
    await flush();
    expect(h.audio.speakCalls).toEqual([]);
  });

  it('always-on survives a quiet porch but stops LOUDLY on a denied mic', async () => {
    const h = await bootLive(LOOP);
    expect(h.audio.startListeningCalls).toBe(1);

    // Chrome fires no-speech within seconds of quiet. That is the idle cycle between trick-or-treaters,
    // and treating it as fatal is what used to kill the ear minutes into the night.
    h.audio.lastCb!.onError!('no-speech');
    h.audio.lastCb!.onEnd!();
    await h.advance(1000);
    expect(h.audio.startListeningCalls).toBe(2);

    h.audio.lastCb!.onError!('not-allowed');
    h.audio.lastCb!.onEnd!();
    await h.advance(30_000);
    expect(h.audio.startListeningCalls).toBe(2); // a denied mic is terminal — never hammer it
    expect(h.els.get('status')!.textContent).toMatch(/mic blocked/i);
  });

  it('an ear the operator closed stays closed', async () => {
    const h = await bootLive(LOOP);
    h.audio.lastCb!.onEnd!();          // enters the pending-restart window
    h.els.get('btnListen')!.onclick!(); // operator flips back to push-to-talk
    await h.advance(30_000);
    expect(h.audio.startListeningCalls).toBe(1);
  });
});

describe('pumpkin projector: a think that never lands cannot wedge the prop', () => {
  const LOOP = '?room=Front%20Porch&mode=autonomous&listen=open';

  it('a /chat that never settles releases the ear on the deadline instead of going deaf forever', async () => {
    const h = await bootLive(LOOP);
    h.routes.set('/api/pumpkin/chat', () => ({ hold: true }));   // the reply NEVER lands
    h.audio.lastCb!.onFinal!('trick or treat');
    await flush();
    expect(h.countFetches('/api/pumpkin/chat')).toBe(1);
    h.audio.lastCb!.onEnd!();

    // Before the deadline the ear is correctly shut — the self-hearing guard still owns this window.
    await h.advance(40_000);
    expect(h.audio.startListeningCalls).toBe(1);
    expect(h.els.get('status')!.textContent).toBe('thinking…');

    // Past it, the prop MUST be listening again. Nothing else in the file clears S.inFlight.
    await h.advance(10_000);
    expect(h.els.get('status')!.textContent).not.toBe('thinking…');
    expect(h.audio.startListeningCalls).toBe(2);

    // …and it can buy a NEW turn, which is the proof S.inFlight really was released.
    h.audio.lastCb!.onFinal!('is anyone there');
    await flush();
    expect(h.countFetches('/api/pumpkin/chat')).toBe(2);
  });

  it('on a push-to-talk projector the timed-out think leaves a readable status behind', async () => {
    // The runbook's default is listen=ptt, so nothing overwrites the line: an operator walking past
    // the projector can see WHY it went quiet instead of a face still captioned "thinking…".
    const h = await bootLive('?room=Front%20Porch&mode=autonomous&listen=ptt');
    h.routes.set('/api/pumpkin/chat', () => ({ hold: true }));
    h.els.get('btnTalk')!.fire('pointerdown');
    h.audio.lastCb!.onFinal!('trick or treat');
    await flush();
    expect(h.els.get('status')!.textContent).toBe('thinking…');

    await h.advance(46_000);
    expect(h.els.get('status')!.textContent).toMatch(/lost its train of thought/i);
  });

  it('the wedged request is ABORTED, so a late reply can never speak over the next turn', async () => {
    const h = await bootLive(LOOP);
    h.routes.set('/api/pumpkin/chat', () => ({ hold: true }));
    h.audio.lastCb!.onFinal!('trick or treat');
    await flush();

    await h.advance(46_000);
    expect(h.signals[0].aborted).toBe(true);

    // The server finally answers the abandoned request. It must be discarded, not spoken.
    await h.release({ reply: { say: 'A reply from ten minutes ago.', expression: 'spooky', intensity: 0.9 } });
    expect(h.audio.speakCalls).toEqual([]);
  });

  it('a human holding the talk button re-opens the ear mid-think — the manual override', async () => {
    // The old startListen() early-returned on turn === 'thinking', so pressing SPACE or the
    // Hold-to-talk button could not recover a wedged prop either: it was deaf to its operator.
    const h = await bootLive('?room=Front%20Porch&mode=autonomous&listen=ptt');
    h.routes.set('/api/pumpkin/chat', () => ({ hold: true }));
    h.els.get('btnTalk')!.fire('pointerdown');
    expect(h.audio.startListeningCalls).toBe(1);
    h.audio.lastCb!.onFinal!('trick or treat');
    await flush();
    expect(h.countFetches('/api/pumpkin/chat')).toBe(1);

    h.els.get('btnTalk')!.fire('pointerdown');     // the operator walks over and holds it again
    await flush();
    expect(h.audio.startListeningCalls).toBe(2);
    expect(h.signals[0].aborted).toBe(true);

    // And what they say is acted on, rather than dropped by the still-set in-flight guard.
    h.audio.lastCb!.onFinal!('say something');
    await flush();
    expect(h.countFetches('/api/pumpkin/chat')).toBe(2);
  });

  it('the automatic ear still refuses to re-open during a healthy think', async () => {
    // The recovery must not become a hole in the self-hearing guard: only a GESTURE may re-open the
    // mic mid-think, never armEar's timer.
    const h = await bootLive(LOOP);
    h.routes.set('/api/pumpkin/chat', () => ({ hold: true }));
    h.audio.lastCb!.onFinal!('trick or treat');
    await flush();
    h.audio.lastCb!.onEnd!();
    await h.advance(30_000);
    expect(h.audio.startListeningCalls).toBe(1);
  });
});

describe('pumpkin projector: the SHORT url restores the saved room, mode and look', () => {
  const SETTINGS = {
    '/api/pumpkin/settings': () => ({ json: { roomLabel: 'Front Porch', mode: 'autonomous', activePreset: 'graveyard' } }),
  };

  it('with no query string at all it registers the SAVED room, not "Main"', async () => {
    // The runbook's step 3 is the 40-character URL typed on the projector device. If this read does
    // not happen, the projector sits in room 'main' while the cockpit pushes to 'front-porch' — the
    // "no projector listening" failure, caused by the documentation.
    const h = boot('', { routes: SETTINGS });
    await flush();
    h.es[0]?.open();
    await flush();

    expect(h.countFetches('/api/pumpkin/settings')).toBe(1);
    expect(h.registerCount()).toBe(1);
    expect(h.fetchCalls.find((c) => c.url.startsWith('/api/pumpkin/rooms/register'))!.body)
      .toEqual({ label: 'Front Porch' });
    expect(h.countFetches('/api/pumpkin/presets/graveyard')).toBe(1);
    expect(h.audio.startListeningCalls).toBe(0);   // stored mode is autonomous, but listen stays ptt
  });

  it('an explicit query parameter always beats the stored default', async () => {
    const h = boot('?room=Back%20Gate&preset=inflatable', { routes: SETTINGS });
    await flush();

    expect(h.fetchCalls.find((c) => c.url.startsWith('/api/pumpkin/rooms/register'))!.body)
      .toEqual({ label: 'Back Gate' });
    expect(h.countFetches('/api/pumpkin/presets/inflatable')).toBe(1);
    expect(h.countFetches('/api/pumpkin/presets/graveyard')).toBe(0);
  });

  it('a fully-specified URL skips the settings read entirely', async () => {
    const h = boot('?room=Back%20Gate&preset=inflatable&mode=mimic', { routes: SETTINGS });
    await flush();
    expect(h.countFetches('/api/pumpkin/settings')).toBe(0);
    expect(h.registerCount()).toBe(1);
  });

  it('a failed settings read still brings the projector up', async () => {
    const h = boot('', { routes: { '/api/pumpkin/settings': () => ({ status: 500, json: { error: 'down' } }) } });
    await flush();
    expect(h.registerCount()).toBe(1);
    expect(h.fetchCalls.find((c) => c.url.startsWith('/api/pumpkin/rooms/register'))!.body)
      .toEqual({ label: 'Main' });
  });

  it('the browser demo never asks the server for settings', async () => {
    const h = boot('?demo=1&channel=preview', { routes: SETTINGS });
    await flush();
    expect(h.countFetches('/api/pumpkin/settings')).toBe(0);
  });
});

describe('pumpkin audio: a suspended context can no longer wedge the prop mute AND deaf', () => {
  function bootAudio(contextState: string) {
    const spoken: { onend?: () => void; onerror?: () => void }[] = [];
    const fetchCalls: string[] = [];
    const ctx: Record<string, unknown> = {
      window: {
        AudioContext: class {
          state = contextState;
          resume(): Promise<void> { return Promise.resolve(); } // still suspended afterwards
          createBufferSource(): unknown { throw new Error('the WebAudio path must not be reached'); }
        },
        speechSynthesis: {
          paused: false,
          speak: (u: { onend?: () => void }) => { spoken.push(u); },
          cancel: () => {},
          getVoices: () => [],
        },
        SpeechSynthesisUtterance: class {
          rate = 1; pitch = 1; voice: unknown = null;
          onboundary?: () => void; onend?: () => void; onerror?: () => void;
          constructor(public text: string) {}
        },
      },
      document: {},
      navigator: {},
      fetch: (url: string) => { fetchCalls.push(url); return Promise.reject(new Error('unreachable')); },
      Uint8Array, Blob, FormData, setTimeout, clearTimeout, setInterval, clearInterval,
    };
    vm.runInNewContext(AUDIO_SRC, ctx);
    const win = ctx.window as { PumpkinAudio: new (base: string) => Record<string, never> };
    return { audio: new win.PumpkinAudio('') as never as {
      speak: (t: string, v: unknown, cb: Record<string, unknown>) => Promise<void>;
      forceStop: () => void;
      speaking: boolean;
      contextState: () => string;
    }, spoken, fetchCalls };
  }

  it('a suspended AudioContext routes to speechSynthesis and always settles the turn', async () => {
    const { audio, spoken, fetchCalls } = bootAudio('suspended');
    let ends = 0;
    await audio.speak('Boo', { rate: 1 }, { onEnd: () => { ends += 1; } });

    // The old path started a BufferSource into a suspended context: silent, onended never arrived,
    // _playing stayed true forever — which pinned the mouth open AND permanently blocked listening.
    expect(fetchCalls).toEqual([]);
    expect(spoken).toHaveLength(1);

    spoken[0].onend?.();
    expect(ends).toBe(1);
    expect(audio.speaking).toBe(false);
  });

  it('onEnd fires exactly ONCE however the utterance settles', async () => {
    const { audio, spoken } = bootAudio('suspended');
    let ends = 0;
    await audio.speak('Boo', {}, { onEnd: () => { ends += 1; } });
    spoken[0].onend?.();
    spoken[0].onend?.();
    spoken[0].onerror?.();
    audio.forceStop();
    expect(ends).toBe(1); // twice double-advances the caller's turn machine; zero freezes the prop
    expect(audio.speaking).toBe(false);
  });

  it('forceStop un-wedges a line that never called back', async () => {
    const { audio } = bootAudio('suspended');
    let ends = 0;
    await audio.speak('a line that hangs', {}, { onEnd: () => { ends += 1; } });
    expect(audio.speaking).toBe(true);
    audio.forceStop();
    expect(ends).toBe(1);
    expect(audio.speaking).toBe(false);
  });
});
