import { describe, expect, it } from 'vitest';
import {
  VideoProviderRegistry,
  runFreeFirstLoop,
  type GenResult,
  type VideoGenProvider,
  type VideoJobSpec,
  type VideoJudge,
} from '../../src/features/video-generation';

const spec: VideoJobSpec = { jobType: 'generative', userSub: 'sub-1', prompt: 'a cat waves' };

/** Build a fake provider with controllable behavior. */
function fakeProvider(opts: Partial<VideoGenProvider> & { id: string; costClass: 'free' | 'paid'; available?: boolean; cost?: number; fail?: boolean }): VideoGenProvider {
  return {
    id: opts.id,
    costClass: opts.costClass,
    jobTypes: ['generative'],
    probe: async () => ({ available: opts.available ?? true, providerId: opts.id }),
    estimateCost: () => opts.cost ?? 0,
    generate: async (): Promise<GenResult> => {
      if (opts.fail) throw new Error('boom');
      return { providerId: opts.id, costClass: opts.costClass, mp4: Buffer.from('x'), durationSec: 8, costUsd: opts.cost ?? 0 };
    },
  };
}

const passJudge: VideoJudge = async () => ({ pass: true, score: 1 });
const failJudge: VideoJudge = async () => ({ pass: false });

describe('free-first generation loop', () => {
  it('returns done at $0 when a free provider passes the judge', async () => {
    const reg = new VideoProviderRegistry();
    reg.register(fakeProvider({ id: 'free-a', costClass: 'free' }));
    reg.register(fakeProvider({ id: 'veo', costClass: 'paid', cost: 3.2 }));
    const out = await runFreeFirstLoop(spec, reg, passJudge);
    expect(out.status).toBe('done');
    expect(out.result?.providerId).toBe('free-a');
    expect(out.result?.costUsd).toBe(0);
  });

  it('escalates with a cost estimate (without running the paid provider) when free fails', async () => {
    const reg = new VideoProviderRegistry();
    let paidRan = false;
    reg.register(fakeProvider({ id: 'free-a', costClass: 'free' }));
    const veo = fakeProvider({ id: 'veo', costClass: 'paid', cost: 3.2 });
    veo.generate = async () => { paidRan = true; return { providerId: 'veo', costClass: 'paid', costUsd: 3.2 }; };
    reg.register(veo);
    const out = await runFreeFirstLoop(spec, reg, failJudge);
    expect(out.status).toBe('needs-approval');
    expect(out.escalation).toEqual({ providerId: 'veo', estimatedCostUsd: 3.2 });
    expect(paidRan).toBe(false); // paid provider must NOT run speculatively
  });

  it('picks the cheapest paid provider for the escalation estimate', async () => {
    const reg = new VideoProviderRegistry();
    reg.register(fakeProvider({ id: 'free-a', costClass: 'free' }));
    reg.register(fakeProvider({ id: 'expensive', costClass: 'paid', cost: 9 }));
    reg.register(fakeProvider({ id: 'cheap', costClass: 'paid', cost: 3 }));
    const out = await runFreeFirstLoop(spec, reg, failJudge);
    expect(out.escalation?.providerId).toBe('cheap');
    expect(out.escalation?.estimatedCostUsd).toBe(3);
  });

  it('treats a thrown free provider as a failed attempt and still escalates', async () => {
    const reg = new VideoProviderRegistry();
    reg.register(fakeProvider({ id: 'free-broken', costClass: 'free', fail: true }));
    reg.register(fakeProvider({ id: 'veo', costClass: 'paid', cost: 3.2 }));
    const out = await runFreeFirstLoop(spec, reg, passJudge);
    expect(out.status).toBe('needs-approval');
    expect(out.attempts.find((a) => a.providerId === 'free-broken')?.error).toBe('boom');
  });

  it('fails when nothing free passes and no paid provider exists', async () => {
    const reg = new VideoProviderRegistry();
    reg.register(fakeProvider({ id: 'free-a', costClass: 'free' }));
    const out = await runFreeFirstLoop(spec, reg, failJudge);
    expect(out.status).toBe('failed');
  });

  it('routes free providers before paid in candidatesFor', () => {
    const reg = new VideoProviderRegistry();
    reg.register(fakeProvider({ id: 'veo', costClass: 'paid' }));
    reg.register(fakeProvider({ id: 'free-a', costClass: 'free' }));
    expect(reg.candidatesFor('generative').map((p) => p.id)).toEqual(['free-a', 'veo']);
  });
});
