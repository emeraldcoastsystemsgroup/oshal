/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Guard for the free ComfyUI storyboard image provider. The boundary this feature lives on is the ComfyUI HTTP protocol, so the transport is REAL: every case runs against a local http.createServer on an ephemeral loopback port that speaks /system_stats, /prompt, /history, /view and /upload/image, and nothing here mocks fetch. Pins: (1) the submit -> poll -> fetch round trip returns the exact bytes the box served; (2) the pinned workflow's %PROMPT% slot actually receives the frame prompt, and a workflow carrying no slot is refused before anything is submitted; (3) the anchor frame is uploaded and injected into %ANCHOR%, and a workflow without that slot uploads nothing; (4) availability states WHICH of url / workflow / reachability is missing and never throws; (5) a job that never completes hits the bounded poll window and fails visibly instead of hanging; (6) a /prompt rejection, a box-side execution error and a non-PNG result each surface as a clear message; (7) selection still fails closed - comfyui unconfigured refuses even while a funded paid sibling is available and resolvable; (8) the AI Test Lab card is registered and its read-only step runs green against the same fake box.
 */

import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const logSpies = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('@/shared/logger', () => ({ createChildLogger: () => logSpies }));

import {
  createComfyUiImageProvider,
  resolveStoryboardImageProvider,
} from '../../src/features/video-generation/services/storyboard-image-providers';
import { SCENARIOS } from '../../src/app/routes/test-lab-scenarios';

/** A real PNG signature plus filler — the provider validates the magic, nothing decodes it here. */
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('a-real-png-signature-over-fake-pixel-data'),
]);
const ANCHOR_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('the-scene-one-anchor-frame'),
]);

/** An API-format workflow with the prompt slot the provider requires. */
const WORKFLOW_WITH_PROMPT = {
  '3': { class_type: 'KSampler', inputs: { seed: 42, steps: 20 } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, %PROMPT%', clip: ['4', 1] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'oshal-storyboard', images: ['8', 0] } },
};

/** The same graph plus a LoadImage reference slot, which is what makes it image-to-image. */
const WORKFLOW_WITH_ANCHOR = {
  ...WORKFLOW_WITH_PROMPT,
  '10': { class_type: 'LoadImage', inputs: { image: '%ANCHOR%', upload: 'image' } },
};

/** A graph the operator exported without putting the placeholder in — every frame would be identical. */
const WORKFLOW_WITHOUT_PROMPT = {
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a fixed prompt baked into the template' } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'oshal-storyboard' } },
};

/** Everything the fake box can be told to do, so each case shapes one protocol answer. */
interface FakeBehaviour {
  systemStatsStatus: number;
  promptStatus: number;
  promptBody: unknown;
  /** How many /history polls before the job reports outputs. A big number never completes in time. */
  completeAfterPolls: number;
  /** When set, the job reports status_str 'error' carrying this exception message. */
  historyError: string | null;
  /** When true the finished job reports a node with an empty images array. */
  finishWithNoImage: boolean;
  viewBytes: Buffer;
}

/** What the fake box recorded, so a case can assert what the provider actually sent it. */
interface FakeRecord {
  submissions: Array<{ prompt?: Record<string, { inputs?: Record<string, unknown> }>; client_id?: string }>;
  uploadedBytes: Buffer[];
  historyPolls: number;
  viewQueries: string[];
}

const behaviour: FakeBehaviour = {
  systemStatsStatus: 200,
  promptStatus: 200,
  promptBody: { prompt_id: 'sb-prompt-1' },
  completeAfterPolls: 1,
  historyError: null,
  finishWithNoImage: false,
  viewBytes: PNG_BYTES,
};
const recorded: FakeRecord = { submissions: [], uploadedBytes: [], historyPolls: 0, viewQueries: [] };

/** Drain a request body to a Buffer — the provider posts real JSON and real multipart. */
function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Send a JSON body with the given status. */
function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(payload.length) });
  res.end(payload);
}

/** The finished-job history shape ComfyUI returns once a graph has executed. */
function finishedHistory(promptId: string): Record<string, unknown> {
  const images = behaviour.finishWithNoImage ? [] : [{ filename: 'oshal-storyboard_00001_.png', subfolder: 'series', type: 'output' }];
  return { [promptId]: { status: { status_str: 'success', completed: true }, outputs: { '9': { images } } } };
}

/**
 * @description Handle one request the way ComfyUI's own HTTP API would.
 * @param {http.IncomingMessage} req the inbound request
 * @param {http.ServerResponse} res the response to write
 * @returns {Promise<void>} resolves once the response is written
 */
async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://fake.local');
  if (url.pathname === '/system_stats') {
    return sendJson(res, behaviour.systemStatsStatus, { system: { os: 'fake' }, devices: [] });
  }
  if (url.pathname === '/prompt' && req.method === 'POST') {
    recorded.submissions.push(JSON.parse((await readBody(req)).toString('utf8')));
    return sendJson(res, behaviour.promptStatus, behaviour.promptBody);
  }
  if (url.pathname === '/upload/image' && req.method === 'POST') {
    recorded.uploadedBytes.push(await readBody(req));
    return sendJson(res, 200, { name: 'oshal-anchor.png', subfolder: 'input-refs', type: 'input' });
  }
  if (url.pathname.startsWith('/history/')) {
    recorded.historyPolls += 1;
    const promptId = url.pathname.slice('/history/'.length);
    if (behaviour.historyError) {
      return sendJson(res, 200, {
        [promptId]: { status: { status_str: 'error', messages: [['execution_error', { exception_message: behaviour.historyError, node_type: 'CheckpointLoaderSimple' }]] } },
      });
    }
    return sendJson(res, 200, recorded.historyPolls >= behaviour.completeAfterPolls ? finishedHistory(promptId) : {});
  }
  if (url.pathname === '/view') {
    recorded.viewQueries.push(url.search);
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(behaviour.viewBytes.length) });
    return res.end(behaviour.viewBytes);
  }
  return sendJson(res, 404, { error: 'not a ComfyUI route' });
}

let server: http.Server;
let boxUrl: string;
let tempDir: string;
let promptWorkflowPath: string;
let anchorWorkflowPath: string;
let plainWorkflowPath: string;

const ENV_KEYS = [
  'COMFYUI_URL',
  'COMFYUI_STORYBOARD_WORKFLOW',
  'COMFYUI_STORYBOARD_TIMEOUT_MS',
  'STORYBOARD_IMAGE_PROVIDER',
  'DEMO_MODE',
  'OPENROUTER_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_AUTH_SOURCE_PATH',
  'OSHAL_SEED_SECRETS_PATH',
  'OSHAL_GLOBAL_CONFIG_PATH',
] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-comfy-'));
  promptWorkflowPath = path.join(tempDir, 'storyboard.api.json');
  anchorWorkflowPath = path.join(tempDir, 'storyboard-anchored.api.json');
  plainWorkflowPath = path.join(tempDir, 'storyboard-no-slot.api.json');
  fs.writeFileSync(promptWorkflowPath, JSON.stringify(WORKFLOW_WITH_PROMPT));
  fs.writeFileSync(anchorWorkflowPath, JSON.stringify(WORKFLOW_WITH_ANCHOR));
  fs.writeFileSync(plainWorkflowPath, JSON.stringify(WORKFLOW_WITHOUT_PROMPT));

  server = http.createServer((req, res) => {
    handle(req, res).catch(() => { try { res.writeHead(500); res.end(); } catch { /* already gone */ } });
  });
  // 127.0.0.1 and port 0: a loopback-only ephemeral port. Nothing here can reach a real GPU box.
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  boxUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.COMFYUI_URL = boxUrl;
  process.env.COMFYUI_STORYBOARD_WORKFLOW = promptWorkflowPath;
  process.env.COMFYUI_STORYBOARD_TIMEOUT_MS = '8000';
  delete process.env.STORYBOARD_IMAGE_PROVIDER;
  delete process.env.DEMO_MODE;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENAI_API_KEY;
  // Keep the credential-reading siblings deterministic: no ambient seed/config on this machine.
  process.env.CODEX_AUTH_SOURCE_PATH = path.join(tempDir, 'absent-auth.json');
  process.env.OSHAL_SEED_SECRETS_PATH = path.join(tempDir, 'absent-secrets.json');
  process.env.OSHAL_GLOBAL_CONFIG_PATH = path.join(tempDir, 'absent-config.json');

  behaviour.systemStatsStatus = 200;
  behaviour.promptStatus = 200;
  behaviour.promptBody = { prompt_id: 'sb-prompt-1' };
  behaviour.completeAfterPolls = 1;
  behaviour.historyError = null;
  behaviour.finishWithNoImage = false;
  behaviour.viewBytes = PNG_BYTES;
  recorded.submissions = [];
  recorded.uploadedBytes = [];
  recorded.historyPolls = 0;
  recorded.viewQueries = [];
  logSpies.warn.mockClear();
  logSpies.error.mockClear();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('comfyui storyboard provider — availability states a reason and never throws', () => {
  it('is unavailable, and says so, when COMFYUI_URL is unset', async () => {
    delete process.env.COMFYUI_URL;
    const provider = createComfyUiImageProvider();
    await expect(provider.available()).resolves.toBe(false);
    const health = await provider.healthCheck!();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain('COMFYUI_URL is not set');
  });

  it('is unavailable, and says so, when COMFYUI_STORYBOARD_WORKFLOW is unset or points nowhere', async () => {
    delete process.env.COMFYUI_STORYBOARD_WORKFLOW;
    const provider = createComfyUiImageProvider();
    await expect(provider.available()).resolves.toBe(false);
    expect((await provider.healthCheck!()).detail).toContain('COMFYUI_STORYBOARD_WORKFLOW is not set');

    process.env.COMFYUI_STORYBOARD_WORKFLOW = path.join(tempDir, 'never-exported.api.json');
    const missing = await createComfyUiImageProvider().healthCheck!();
    expect(missing.ok).toBe(false);
    expect(missing.detail).toContain('points at a file that does not exist');
  });

  it('is unavailable, and says so, when /system_stats does not answer', async () => {
    behaviour.systemStatsStatus = 500;
    const provider = createComfyUiImageProvider();
    await expect(provider.available()).resolves.toBe(false);
    expect((await provider.healthCheck!()).detail).toContain('answered /system_stats with HTTP 500');
  });

  it('is unavailable, and says so, when nothing is listening on the box at all', async () => {
    // A port with no listener is the "GPU box asleep" shape: it must read unavailable, not crash.
    process.env.COMFYUI_URL = 'http://127.0.0.1:1';
    const provider = createComfyUiImageProvider();
    await expect(provider.available()).resolves.toBe(false);
    expect((await provider.healthCheck!()).detail).toContain('unreachable');
    expect(logSpies.error).toHaveBeenCalled();
  });

  it('is available, free, and names its configuration once the box answers', async () => {
    const provider = createComfyUiImageProvider();
    expect(provider.id).toBe('comfyui');
    expect(provider.costClass).toBe('free');
    await expect(provider.available()).resolves.toBe(true);
    const health = await provider.healthCheck!();
    expect(health.ok).toBe(true);
    expect(health.detail).toContain('storyboard.api.json');
  });
});

describe('comfyui storyboard provider — submit, poll, fetch', () => {
  it('queues the workflow, polls to completion and returns the bytes the box served', async () => {
    behaviour.completeAfterPolls = 2; // prove the poll loop actually waits for a pending job
    const image = await createComfyUiImageProvider().generate('a lighthouse at dusk, wide shot', null);

    expect(image.equals(PNG_BYTES)).toBe(true);
    expect(recorded.submissions).toHaveLength(1);
    expect(recorded.historyPolls).toBeGreaterThanOrEqual(2);
    expect(recorded.viewQueries[0]).toContain('filename=oshal-storyboard_00001_.png');
    expect(recorded.viewQueries[0]).toContain('subfolder=series');
  });

  it('puts the frame prompt into the workflow\'s %PROMPT% slot', async () => {
    await createComfyUiImageProvider().generate('a lighthouse at dusk, wide shot', null);

    const submitted = recorded.submissions[0];
    expect(submitted.prompt!['6'].inputs!.text).toBe('masterpiece, a lighthouse at dusk, wide shot');
    // Nothing anywhere in the submitted graph still carries the placeholder.
    expect(JSON.stringify(submitted)).not.toContain('%PROMPT%');
    expect(submitted.client_id).toMatch(/^oshal-storyboard-/);
  });

  it('refuses a pinned workflow with no %PROMPT% slot before submitting anything', async () => {
    process.env.COMFYUI_STORYBOARD_WORKFLOW = plainWorkflowPath;
    await expect(createComfyUiImageProvider().generate('a lighthouse at dusk', null))
      .rejects.toThrow(/carries no %PROMPT% placeholder/);
    expect(recorded.submissions).toHaveLength(0);
  });

  it('uploads the anchor frame and injects the uploaded name into %ANCHOR%', async () => {
    process.env.COMFYUI_STORYBOARD_WORKFLOW = anchorWorkflowPath;
    await createComfyUiImageProvider().generate('scene two, same cast', ANCHOR_BYTES);

    expect(recorded.uploadedBytes).toHaveLength(1);
    expect(recorded.uploadedBytes[0].includes(ANCHOR_BYTES)).toBe(true); // the real bytes, over real multipart
    expect(recorded.submissions[0].prompt!['10'].inputs!.image).toBe('input-refs/oshal-anchor.png');
  });

  it('uploads nothing, and says the reference was dropped, when the workflow has no %ANCHOR% slot', async () => {
    const image = await createComfyUiImageProvider().generate('scene two, same cast', ANCHOR_BYTES);

    expect(image.equals(PNG_BYTES)).toBe(true);
    expect(recorded.uploadedBytes).toHaveLength(0);
    expect(logSpies.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('%ANCHOR%'));
  });
});

describe('comfyui storyboard provider — failure is bounded and visible', () => {
  it('gives up on a job that never completes, inside the configured poll window', async () => {
    process.env.COMFYUI_STORYBOARD_TIMEOUT_MS = '600';
    behaviour.completeAfterPolls = Number.MAX_SAFE_INTEGER;

    const started = Date.now();
    await expect(createComfyUiImageProvider().generate('a lighthouse at dusk', null))
      .rejects.toThrow(/did not finish inside the bounded poll window/);
    expect(Date.now() - started).toBeLessThan(5_000);
    // The wording must not look transient, or the caller's retry classifier burns the whole budget.
    const message = await createComfyUiImageProvider().generate('a lighthouse at dusk', null).catch((e: Error) => e.message);
    expect(/RATE_LIMITED|EMPTY_RESPONSE|\b(429|500|502|503|504)\b/.test(message as string)).toBe(false);
  });

  it('surfaces a /prompt rejection with the box\'s own words', async () => {
    behaviour.promptStatus = 400;
    behaviour.promptBody = { error: { message: 'Prompt outputs failed validation' }, node_errors: { '3': 'bad ckpt' } };

    await expect(createComfyUiImageProvider().generate('a lighthouse at dusk', null))
      .rejects.toThrow(/\/prompt answered HTTP 400.*Prompt outputs failed validation/s);
  });

  it('surfaces an execution error the box reports in history', async () => {
    behaviour.historyError = 'CheckpointLoaderSimple: sdxl_base.safetensors not found';

    await expect(createComfyUiImageProvider().generate('a lighthouse at dusk', null))
      .rejects.toThrow(/failed on the box.*sdxl_base\.safetensors not found/s);
  });

  it('refuses a finished job that saved no image, and a result that is not a PNG', async () => {
    behaviour.finishWithNoImage = true;
    await expect(createComfyUiImageProvider().generate('a lighthouse at dusk', null))
      .rejects.toThrow(/saved no image/);

    behaviour.finishWithNoImage = false;
    behaviour.viewBytes = Buffer.from('RIFF....WEBPVP8 this is not a png at all');
    await expect(createComfyUiImageProvider().generate('a lighthouse at dusk', null))
      .rejects.toThrow(/is not a PNG/);
  });
});

describe('storyboard provider selection stays fail-closed', () => {
  it('resolves comfyui when it is configured', async () => {
    process.env.STORYBOARD_IMAGE_PROVIDER = 'comfyui';
    const provider = await resolveStoryboardImageProvider();
    expect(provider.id).toBe('comfyui');
    expect(provider.costClass).toBe('free');
  });

  it('refuses rather than substituting a funded paid sibling when comfyui is unconfigured', async () => {
    // A paid rail that IS resolvable right now — so the refusal below is a choice, not an accident.
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-fake-key-for-this-spec-only';
    process.env.STORYBOARD_IMAGE_PROVIDER = 'openrouter';
    expect((await resolveStoryboardImageProvider()).id).toBe('openrouter');

    delete process.env.COMFYUI_URL;
    process.env.STORYBOARD_IMAGE_PROVIDER = 'comfyui';
    const outcome = await resolveStoryboardImageProvider().then((p) => p.id, (e: Error) => e);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toContain("storyboard image provider 'comfyui' is not configured");
    expect((outcome as Error).message).toContain('COMFYUI_URL is not set');
    expect((outcome as Error).message).toContain('Refusing to fall back to a paid provider you did not ask for');
  });
});

describe('AI Test Lab registration', () => {
  it('registers the storyboard image-rail card with its regression guards on disk', () => {
    const scenario = SCENARIOS.find((s) => s.id === 'storyboard-image-rail');
    expect(scenario, 'the storyboard rail card must be registered in SCENARIOS').toBeTruthy();
    expect(scenario!.steps).toHaveLength(1);
    const paths = (scenario!.regressionTests ?? []).map((t) => t.path);
    expect(paths).toContain('tests/unit/storyboard-comfyui-provider.spec.ts');
    for (const p of paths) expect(fs.existsSync(path.join(process.cwd(), p)), `${p} must exist`).toBe(true);
  });

  it('runs its read-only step green against a reachable box, and amber without one', async () => {
    const scenario = SCENARIOS.find((s) => s.id === 'storyboard-image-rail')!;
    process.env.STORYBOARD_IMAGE_PROVIDER = 'comfyui';
    const ready = await scenario.steps[0].run('', {});
    expect(ready.state).toBe('pass');
    expect(ready.detail).toContain('FREE');

    delete process.env.COMFYUI_URL;
    process.env.STORYBOARD_IMAGE_PROVIDER = 'openrouter';
    const notReady = await scenario.steps[0].run('', {});
    expect(notReady.state).toBe('degraded');
    expect(notReady.detail).toContain('COMFYUI_URL is not set');
    // Read-only: the card never asked the box to render anything.
    expect(recorded.submissions).toHaveLength(0);
  });
});
