/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added deployment-boundary tests for the private, checksum-pinned speaker sidecar.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Covered controller admission, receipt, and Cloud STT environment passthrough.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const compose = readFileSync(resolve(root, 'docker-compose.oshal-local.yml'), 'utf8');
const dockerfile = readFileSync(resolve(root, 'services/speaker-diarization/Dockerfile'), 'utf8');
const envExample = readFileSync(resolve(root, '.env.example'), 'utf8');
const service = compose.match(/  speaker-diarization:\s*\n([\s\S]*?)\n  oshal-api:/)?.[1] || '';

describe('speaker diarization deployment boundary', () => {
  it('runs an internal-only hardened service with no durable volume or host port', () => {
    expect(service).toContain('context: ./services/speaker-diarization');
    expect(service).toContain('read_only: true');
    expect(service).toContain('no-new-privileges:true');
    expect(service).toContain('/tmp:size=64m');
    expect(service).not.toMatch(/^\s+ports:/m);
    expect(service).not.toMatch(/^\s+volumes:/m);
  });

  it('shares only the dedicated service credential with the controller', () => {
    expect(service).toContain('SPEAKER_SERVICE_KEY:');
    expect(service).toContain('SPEAKER_MAX_DURATION_SECONDS: ${SPEAKER_MAX_DURATION_SECONDS:-58}');
    expect(service).not.toContain('SPEAKER_PROFILE_SECRET');
    expect(compose).toContain('SPEAKER_DIARIZATION_URL: ${SPEAKER_DIARIZATION_URL:-http://speaker-diarization:8080}');
    expect(compose).toContain('SPEAKER_PROFILE_SECRET: ${SPEAKER_PROFILE_SECRET:-oshal-local-speaker-profile-secret-do-not-use-in-prod}');
    expect(compose).toContain('SPEAKER_PROFILE_SECRET_PREVIOUS: ${SPEAKER_PROFILE_SECRET_PREVIOUS:-}');
    expect(compose).toContain('SPEAKER_STT_TIMEOUT_MS: ${SPEAKER_STT_TIMEOUT_MS:-55000}');
    expect(compose).toContain('SPEAKER_AUDIO_LEASE_SECONDS: ${SPEAKER_AUDIO_LEASE_SECONDS:-300}');
    expect(compose).toContain('GOOGLE_CLOUD_PROJECT: ${GOOGLE_CLOUD_PROJECT:-}');
    expect(compose).toContain('GOOGLE_CLOUD_SPEECH_LOCATION: ${GOOGLE_CLOUD_SPEECH_LOCATION:-us}');
    expect(envExample).toContain('SPEAKER_SERVICE_KEY=replace-with-a-separate-random-speaker-service-key');
    expect(envExample).toContain('SPEAKER_PROFILE_SECRET=replace-with-a-separate-random-speaker-profile-secret');
    expect(envExample).toContain('SPEAKER_PROFILE_SECRET_PREVIOUS=');
    expect(envExample).toContain('SPEAKER_STT_TIMEOUT_MS=55000');
    expect(envExample).toContain('SPEAKER_AUDIO_RECEIPT_TTL_HOURS=48');
    expect(envExample).toContain('SPEAKER_AUDIO_LEASE_SECONDS=300');
  });

  it('pins and verifies both open-source model artifacts during image build', () => {
    expect(dockerfile).toContain('sherpa-onnx-pyannote-segmentation-3-0.tar.bz2');
    expect(dockerfile).toContain('24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488');
    expect(dockerfile).toContain('c59158379255ad66e161679cca6af8d52d51e389e3224ab7d7a7baae295c2db5');
    expect(dockerfile).toContain('sha256sum --check --strict');
  });
});
