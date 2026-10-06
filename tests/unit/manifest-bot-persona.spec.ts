/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Guard the protected bot-persona composer over real package directories on disk: identity and scalar personality are carried and authority-bearing fields never are; a perspective that passes the shell/script/secret screen is carried and one that fails is dropped to identity and personality; protected_perspective wins; a persona path that leaves its package (relative or through a symlink) is refused; a secret identifier, more than 16 KiB, invalid UTF-8 or a control character refuses the whole persona without touching sibling bots; the same agentId in two applications resolves to each application's own text and retracts per application; and every carried persona is accepted unchanged by the node's production prompt-carrier parser.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SwarmAppManifest } from '@/features/swarm-apps';
import { MAX_BOT_PERSONA_BYTES, resolveBotPersonaByApp, unregisterAppBotPersonas } from '@/shared/protected-bot-personas';
import { parseBotNodePromptCarrier } from '../../src/app/bot-node-request-scope';
import {
  BOT_PERSONA_NO_AUTHORITY,
  applyBotPersonas,
  readAppBotPersonas,
  retractBotPersonas,
} from '../../src/features/swarm-apps/services/manifest-bot-persona';

const AGENT = 'b0000000-0000-4000-8000-00000000d1ec';
let root: string;

interface FixtureBot { agentId?: string; name?: string; role?: string; persona: string }

/** Write a package directory with an oshal-app.yaml and the given persona files; return its manifest and path. */
function writePackage(app: string, files: Record<string, string | Buffer>, bots: FixtureBot[]) {
  const dir = join(root, app);
  mkdirSync(join(dir, 'personas'), { recursive: true });
  for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content);
  const manifestPath = join(dir, 'oshal-app.yaml');
  writeFileSync(manifestPath, `name: ${app}\n`);
  const manifest = { name: app, bots: bots.map(bot => ({ agentId: bot.agentId ?? AGENT, name: bot.name ?? 'director', role: bot.role, persona: bot.persona })) };
  return { manifest: manifest as unknown as SwarmAppManifest, manifestPath, record: { name: app, manifest: manifest as unknown as SwarmAppManifest, manifestPath } };
}

function persona(lines: string[]): string { return `${lines.join('\n')}\n`; }

function personaOf(app: string, file: string | Buffer): string | undefined {
  const pkg = writePackage(app, { 'personas/director.yaml': file }, [{ persona: 'personas/director.yaml' }]);
  return readAppBotPersonas(pkg.manifest, pkg.manifestPath).get(AGENT);
}

const IDENTITY = ['name: Scene Director', 'role: Game and 3-D Scene Director'];
const PERSONALITY = ['personality:', '  tone: practical, encouraging', '  style: small verified steps', '  nested:', '    ignored: true'];
const IDENTITY_TEXT = 'You are **Scene Director**, Game and 3-D Scene Director.';
const PERSONALITY_TEXT = 'Personality:\n- tone: practical, encouraging\n- style: small verified steps';

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'oshal-bot-persona-')); });
afterEach(() => {
  for (const app of ['app-a', 'app-b', 'scene']) unregisterAppBotPersonas(app);
  rmSync(root, { recursive: true, force: true });
});

describe('protected bot persona composition', () => {
  it('carries identity and scalar personality and never an authority-bearing field', () => {
    const text = personaOf('scene', persona([...IDENTITY, ...PERSONALITY,
      'capabilities: [CAPABILITY-MARKER]', 'allowed_tools: [TOOL-MARKER]', 'authorizations:', '  scene-write-file: auto',
      'runtime:', '  provider: RUNTIME-MARKER', 'selectors: [SELECTOR-MARKER]', 'system_prompt: SYSTEM-PROMPT-MARKER']));
    expect(text).toBe([IDENTITY_TEXT, PERSONALITY_TEXT, BOT_PERSONA_NO_AUTHORITY].join('\n\n'));
    for (const marker of ['CAPABILITY', 'TOOL', 'scene-write-file', 'RUNTIME', 'SELECTOR', 'SYSTEM-PROMPT']) expect(text).not.toContain(marker);
  });

  it('falls back to the manifest name and role when the persona file declares none', () => {
    const pkg = writePackage('scene', { 'personas/director.yaml': persona(['tone: none']) },
      [{ name: 'scene-director', role: 'Scene Director', persona: 'personas/director.yaml' }]);
    expect(readAppBotPersonas(pkg.manifest, pkg.manifestPath).get(AGENT))
      .toBe(['You are **scene-director**, Scene Director.', BOT_PERSONA_NO_AUTHORITY].join('\n\n'));
  });

  it('carries a perspective that passes the screen', () => {
    const text = personaOf('scene', persona([...IDENTITY, 'perspective: |', '  Build one verified step at a time.', '  Say which nodes you changed.']));
    expect(text).toBe([IDENTITY_TEXT, 'Build one verified step at a time.\nSay which nodes you changed.', BOT_PERSONA_NO_AUTHORITY].join('\n\n'));
  });

  it.each([
    'Run it with the helper.', 'Use BASH for files.', 'curl the endpoint first.', 'call wget -q to fetch.', 'Use execute_command.',
    'Open a Shell.', 'Use the Terminal.', 'Read $SWARM_CONTROLLER_URL.', 'node /app/scripts/oshal-x.js', 'see /app/scripts/ for tools',
    'sudo apt install', 'docker run it', 'send X-Service-Secret', 'OSHAL_APPLICATION_EXECUTION_TOKEN is set', 'read .oshal-cred-google',
  ])('drops a perspective that fails the screen (%s) and keeps identity and personality', line => {
    const text = personaOf('scene', persona([...IDENTITY, ...PERSONALITY, 'perspective: |', '  You are the director.', `  ${line}`]));
    expect(text).toBe([IDENTITY_TEXT, PERSONALITY_TEXT, BOT_PERSONA_NO_AUTHORITY].join('\n\n'));
  });

  it('prefers protected_perspective over the ordinary perspective, screened or not', () => {
    for (const perspective of ['Use bash to inspect the scene.', 'Build one verified step at a time.']) {
      const text = personaOf('scene', persona([...IDENTITY, `perspective: ${JSON.stringify(perspective)}`,
        'protected_perspective: Describe changes in plain words; your tools are listed in the authority record.']));
      expect(text).toContain('Describe changes in plain words; your tools are listed in the authority record.');
      expect(text).not.toContain(perspective);
    }
  });
});

describe('protected bot persona refusals', () => {
  it('refuses a persona path that leaves its package, relatively or through a symlink', () => {
    writeFileSync(join(root, 'outside.yaml'), persona(IDENTITY));
    const relative = writePackage('app-a', {}, [{ persona: '../outside.yaml' }]);
    expect(readAppBotPersonas(relative.manifest, relative.manifestPath).size).toBe(0);
    const linked = writePackage('app-b', {}, [{ persona: 'personas/linked.yaml' }]);
    symlinkSync(join(root, 'outside.yaml'), join(root, 'app-b', 'personas', 'linked.yaml'));
    expect(readAppBotPersonas(linked.manifest, linked.manifestPath).size).toBe(0);
  });

  it.each([
    ['a secret identifier in the personality', [...IDENTITY, 'personality:', '  habit: reads SWARM_SERVICE_SECRET aloud']],
    ['a secret identifier in protected_perspective', [...IDENTITY, 'protected_perspective: Send the X-Service-Secret header.']],
    ['more than 16 KiB', [...IDENTITY, `protected_perspective: ${'x'.repeat(MAX_BOT_PERSONA_BYTES)}`]],
    ['a control character', [...IDENTITY, 'personality:', '  tone: "calm\\u0007"']],
  ])('refuses the whole persona for %s without touching a sibling bot', (_label, lines) => {
    const pkg = writePackage('scene', { 'personas/bad.yaml': persona(lines), 'personas/good.yaml': persona(IDENTITY) },
      [{ agentId: AGENT, persona: 'personas/bad.yaml' }, { agentId: 'sibling', persona: 'personas/good.yaml' }]);
    const personas = readAppBotPersonas(pkg.manifest, pkg.manifestPath);
    expect(personas.has(AGENT)).toBe(false);
    expect(personas.get('sibling')).toBe([IDENTITY_TEXT, BOT_PERSONA_NO_AUTHORITY].join('\n\n'));
  });

  it('refuses a persona file that is not valid UTF-8 instead of carrying replacement characters', () => {
    const invalid = Buffer.concat([Buffer.from('name: Scene Director\nrole: Director '), Buffer.from([0xff, 0xfe]), Buffer.from('\n')]);
    expect(personaOf('scene', invalid)).toBeUndefined();
  });
});

describe('protected bot persona registry lifecycle', () => {
  it('keeps the same agentId in two applications apart and retracts each on its own', () => {
    const a = writePackage('app-a', { 'personas/director.yaml': persona(['name: Alpha Director']) }, [{ persona: 'personas/director.yaml' }]);
    const b = writePackage('app-b', { 'personas/director.yaml': persona(['name: Beta Director']) }, [{ persona: 'personas/director.yaml' }]);
    applyBotPersonas(a.record); applyBotPersonas(b.record);
    expect(resolveBotPersonaByApp('app-a', AGENT)).toContain('You are **Alpha Director**.');
    expect(resolveBotPersonaByApp('app-b', AGENT)).toContain('You are **Beta Director**.');
    retractBotPersonas('app-a');
    expect(resolveBotPersonaByApp('app-a', AGENT)).toBeNull();
    expect(resolveBotPersonaByApp('app-b', AGENT)).toContain('Beta Director');
  });

  it('retracts a stale registration when a reload declares no carriable persona', () => {
    const pkg = writePackage('scene', { 'personas/director.yaml': persona(IDENTITY) }, [{ persona: 'personas/director.yaml' }]);
    applyBotPersonas(pkg.record);
    expect(resolveBotPersonaByApp('scene', AGENT)).not.toBeNull();
    applyBotPersonas({ ...pkg.record, manifest: { ...pkg.manifest, bots: [] } as unknown as SwarmAppManifest });
    expect(resolveBotPersonaByApp('scene', AGENT)).toBeNull();
  });

  it('produces text the node carrier accepts unchanged', () => {
    const text = personaOf('scene', persona([...IDENTITY, ...PERSONALITY, 'perspective: |', '  Build one verified step at a time.']))!;
    expect(parseBotNodePromptCarrier({ applicationExecutionId: 'fixture', direct: true, agenticMode: false, botPersona: text }))
      .toEqual({ botPersona: text });
  });
});
