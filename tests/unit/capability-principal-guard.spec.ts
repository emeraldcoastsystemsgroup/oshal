/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-173 D8 guard: "a guard fails when a core call site calls the resolver without a principal". Scans every TypeScript source under src/ (comments stripped, string-aware, multi-line calls extracted by balanced parentheses) for the capability entry points and requires each core call to say whose it is: resolveCapabilityProvider(...) must carry `principal:` (or spread a CapabilityCaller), VoiceService's transcribeAudio/synthesizeSpeech calls must pass `caller`, and resolveStoryboardImageProvider(...) must pass `userSub`, the image principal. A second census pins the registry bypasses — direct resolveForApp(...) calls, which resolve with no principal at all — to exactly the two S4 moves (video and deck narration) plus the voice service's own listing fallbacks, so a new bypass fails here instead of shipping. Each scanner proves it can go red on a synthetic call site first.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Replace comments with spaces (string-aware), keeping offsets. */
function stripComments(src: string): string {
  const out: string[] = [];
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    const pair = c + (src[i + 1] ?? '');
    if (state === 'code') {
      if (pair === '//') { state = 'line'; out.push(' '); continue; }
      if (pair === '/*') { state = 'block'; out.push(' '); continue; }
      if (c === "'") state = 'single'; else if (c === '"') state = 'double'; else if (c === '`') state = 'template';
      out.push(c);
    } else if (state === 'line') {
      if (c === '\n') { state = 'code'; out.push(c); } else out.push(' ');
    } else if (state === 'block') {
      if (pair === '*/') { state = 'code'; out.push('  '); i += 1; } else out.push(c === '\n' ? c : ' ');
    } else {
      if (c === '\\') { out.push(c, src[i + 1] ?? ''); i += 1; continue; }
      if ((state === 'single' && c === "'") || (state === 'double' && c === '"') || (state === 'template' && c === '`')) state = 'code';
      out.push(c);
    }
  }
  return out.join('');
}

/** The argument text of the call whose `(` is at openIdx, up to the matching `)`. */
function callArgs(text: string, openIdx: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIdx; i < text.length; i += 1) {
    const c = text[i];
    if (quote) { if (c === '\\') { i += 1; continue; } if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(') depth += 1;
    else if (c === ')') { depth -= 1; if (depth === 0) return text.slice(openIdx + 1, i); }
  }
  return text.slice(openIdx + 1);
}

/** One call of a guarded entry point. */
interface CallSite { file: string; line: number; entry: string; args: string }

/** Every CALL (not the definition) of `entry` in one source. */
function callSites(file: string, src: string, entry: RegExp): CallSite[] {
  const text = stripComments(src);
  const sites: CallSite[] = [];
  for (const match of text.matchAll(entry)) {
    const start = match.index ?? 0;
    const before = text.slice(Math.max(0, start - 30), start);
    if (/(?:function|async)\s+$/.test(before)) continue; // the definition, not a call
    const open = start + match[0].length - 1;
    sites.push({ file, line: text.slice(0, start).split('\n').length, entry: match[0].replace(/\($/, ''), args: callArgs(text, open) });
  }
  return sites;
}

/** The guarded entry points and what each call must carry. */
const ENTRIES: ReadonlyArray<{ entry: RegExp; carries: RegExp; why: string }> = [
  { entry: /\bresolveCapabilityProvider\s*\(/g, carries: /\bprincipal\b|\.\.\.\s*caller\b/, why: 'the resolver requires the principal (ADR-173 D8)' },
  { entry: /\.transcribeAudio\s*\(/g, carries: /\bcaller\b/, why: 'a speech-to-text call says whose it is (ADR-173 D8)' },
  { entry: /\.synthesizeSpeech\s*\(/g, carries: /\bcaller\b/, why: 'a text-to-speech call says whose it is (ADR-173 D8)' },
  { entry: /\bresolveStoryboardImageProvider\s*\(/g, carries: /\buserSub\b/, why: 'an image call passes the caller\'s subject, its principal (ADR-173 D8)' },
];

/** Every TypeScript source under src/, repo-relative. */
function sourceFiles(dir = path.join(REPO_ROOT, 'src')): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.ts$/.test(entry.name) && !/\.(spec|test)\.ts$/.test(entry.name)) out.push(path.relative(REPO_ROOT, full).replace(/\\/g, '/'));
  }
  return out;
}

/** Every guarded call in `sources` that does not carry what its entry requires. */
function callsWithoutPrincipal(sources: Array<{ file: string; src: string }>): string[] {
  const offenders: string[] = [];
  for (const { file, src } of sources) {
    for (const rule of ENTRIES) {
      for (const site of callSites(file, src, rule.entry)) {
        if (!rule.carries.test(site.args)) offenders.push(`${site.file}:${site.line} ${site.entry}(...) — ${rule.why}`);
      }
    }
  }
  return offenders;
}

/** The files that call a registry's resolveForApp directly (no principal at all). */
function registryBypassFiles(sources: Array<{ file: string; src: string }>): string[] {
  return sources.filter(({ file, src }) => callSites(file, src, /\bresolveForApp\s*\(/g).length > 0)
    .map(({ file }) => file)
    .filter((file) => !/voice-providers\/services\/(tts|stt)-provider-registry\.ts$/.test(file))
    .sort();
}

/**
 * The registry bypasses that remain, each with the slice that removes it. Video and deck narration
 * resolve the server-side TTS default with no caller; ADR-173 S4 moves both onto the resolver. The
 * voice service uses resolveForApp only to NAME a provider for its listings, never to call one.
 */
const KNOWN_BYPASSES: Readonly<Record<string, string>> = Object.freeze({
  'src/features/video-generation/services/providers/deck-to-video-provider.ts': 'S4: deck narration passes its caller',
  'src/features/video-generation/services/video-render-service.ts': 'S4: video narration passes its caller',
  'src/features/voice/services/voice-service.ts': 'listing fallback only: getAvailableVoices / listTtsProviders name the registry default when nothing else names one',
});

const SOURCES = sourceFiles().map((file) => ({ file, src: fs.readFileSync(path.join(REPO_ROOT, file), 'utf8') }));

describe('ADR-173 D8: every core capability call carries its principal', () => {
  it('the scanner goes red on a call site without a principal, and green with one (proof it can fail)', () => {
    const bad = callsWithoutPrincipal([{ file: 'synthetic.ts', src: [
      'await resolveCapabilityProvider(adapter, { capability: "stt", appId: null, agentId: null });',
      'await voice.transcribeAudio(buf, "audio/wav", { providerId: "local-stt" });',
      'await service.synthesizeSpeech(text, voice, providerId);',
      'await resolveStoryboardImageProvider({ vertexToken });',
      '// await resolveCapabilityProvider(a, {}) inside a comment is not a call',
    ].join('\n') }]);
    expect(bad).toHaveLength(4);
    expect(callsWithoutPrincipal([{ file: 'synthetic.ts', src: [
      'await resolveCapabilityProvider(adapter, { capability: "stt", principal, appId: null, agentId: null });',
      'await resolveCapabilityProvider(adapter, {\n  capability: "tts", ...caller,\n});',
      'await voice.transcribeAudio(buf, "audio/wav", { providerId: "local-stt", caller: { principal, appId: null, agentId: null } });',
      'await service.synthesizeSpeech(text, voice, providerId, { caller, userDefault });',
      'await resolveStoryboardImageProvider({ vertexToken, userSub: ctx.userSub });',
      'export async function resolveCapabilityProvider(adapter, request) {}',
    ].join('\n') }])).toEqual([]);
  });

  it('every guarded call in src/ says whose call it is', () => {
    const offenders = callsWithoutPrincipal(SOURCES);
    expect(offenders, `capability calls without a principal:\n${offenders.join('\n')}`).toEqual([]);
    // Not vacuous: the scan really found the call sites this slice wired.
    const found = SOURCES.flatMap(({ file, src }) => ENTRIES.flatMap((rule) => callSites(file, src, rule.entry).map((s) => `${s.file} ${s.entry}`)));
    expect(found).toEqual(expect.arrayContaining([
      'src/features/voice/services/voice-service.ts resolveCapabilityProvider',
      'src/features/voice/controllers/voice-controller.ts .transcribeAudio',
      'src/features/voice/controllers/voice-controller.ts .synthesizeSpeech',
      'src/app/routes/ambient-speaker-routes.ts .transcribeAudio',
      'src/app/routes/capability-provider-routes.ts .transcribeAudio',
      'src/features/video-generation/services/storyboard-image-providers.ts resolveCapabilityProvider',
      'src/features/video-generation/services/storyboard-frames.ts resolveStoryboardImageProvider',
    ]));
  });

  it('the registry bypass census goes red on a new resolveForApp call', () => {
    expect(registryBypassFiles([{ file: 'src/app/routes/new-voice-thing.ts', src: 'getTTSProviderRegistry().resolveForApp().synthesize({ text });' }]))
      .toEqual(['src/app/routes/new-voice-thing.ts']);
  });

  it('the only registry bypasses left are the named S4 moves and the voice listing fallback', () => {
    expect(registryBypassFiles(SOURCES)).toEqual(Object.keys(KNOWN_BYPASSES).sort());
  });
});
