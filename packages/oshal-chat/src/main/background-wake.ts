/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added local-only Windows wake-word detector and fail-closed background listening lifecycle
 */

import { spawn, type ChildProcess } from 'child_process';

export type BackgroundWakeState =
  | 'off'
  | 'starting'
  | 'listening'
  | 'paused'
  | 'triggered'
  | 'unavailable'
  | 'error';

export interface BackgroundWakeStatus {
  state: BackgroundWakeState;
  enabled: boolean;
  phrase: string;
  detail: string;
  updatedAt: string;
}

export interface WakeDetection {
  phrase: string;
  confidence: number;
  detectedAt: string;
}

export interface WakeDetectorStartOptions {
  phrase: string;
  locale: string;
  onWake: (detection: WakeDetection) => void;
  onError: (error: Error) => void;
}

export interface WakeDetector {
  readonly supported: boolean;
  readonly unsupportedReason?: string;
  start(options: WakeDetectorStartOptions): Promise<void>;
  stop(): Promise<void>;
}

export interface BackgroundWakeServiceOptions {
  detector: WakeDetector;
  onWake: (detection: WakeDetection) => Promise<void> | void;
  onStatus?: (status: BackgroundWakeStatus) => void;
}

export interface BackgroundWakeConfig {
  enabled: boolean;
  assistantName: string;
  identityReady: boolean;
  locale?: string;
}

/**
 * @description Keeps the native listener's lifecycle deterministic. It never owns
 * a network client and never receives command audio: its only output is a bounded
 * wake event that the existing authenticated Jarvis surface consumes.
 */
export class BackgroundWakeService {
  private config: BackgroundWakeConfig = {
    enabled: false,
    assistantName: 'Jarvis',
    identityReady: false,
    locale: 'en-US',
  };
  private detectorRunning = false;
  private userPaused = false;
  private surfaceOwnsMicrophone = false;
  private captureOwnsMicrophone = false;
  private generation = 0;
  private status: BackgroundWakeStatus = this.buildStatus('off', 'Background wake word is off.');

  constructor(private readonly options: BackgroundWakeServiceOptions) {}

  getStatus(): BackgroundWakeStatus {
    return { ...this.status };
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  /** Applies persisted settings and reconciles the native listener. */
  async configure(config: BackgroundWakeConfig): Promise<BackgroundWakeStatus> {
    const nextConfig = {
      enabled: Boolean(config.enabled),
      assistantName: sanitizeAssistantName(config.assistantName),
      identityReady: Boolean(config.identityReady),
      locale: sanitizeLocale(config.locale),
    };
    const phraseChanged = buildWakePhrase(nextConfig.assistantName) !== buildWakePhrase(this.config.assistantName)
      || nextConfig.locale !== this.config.locale;
    this.config = nextConfig;
    if (phraseChanged && this.detectorRunning) await this.stopDetector();
    if (!this.config.enabled) this.userPaused = false;
    await this.reconcile();
    return this.getStatus();
  }

  /** Explicit user pause/resume. Pause is runtime-only; turning off is persisted separately. */
  async setUserPaused(paused: boolean): Promise<BackgroundWakeStatus> {
    this.userPaused = Boolean(paused);
    await this.reconcile();
    return this.getStatus();
  }

  /** The hosted Jarvis page owns the mic while it is visible. */
  async setSurfaceOwnsMicrophone(active: boolean): Promise<BackgroundWakeStatus> {
    this.surfaceOwnsMicrophone = Boolean(active);
    await this.reconcile();
    return this.getStatus();
  }

  /** Push-to-talk temporarily takes mic ownership without changing user settings. */
  async setCaptureOwnsMicrophone(active: boolean): Promise<BackgroundWakeStatus> {
    this.captureOwnsMicrophone = Boolean(active);
    await this.reconcile();
    return this.getStatus();
  }

  async shutdown(): Promise<void> {
    this.generation += 1;
    await this.stopDetector();
    this.publish('off', 'Background wake word stopped.');
  }

  private async reconcile(): Promise<void> {
    const generation = ++this.generation;

    if (!this.config.enabled) {
      await this.stopDetector();
      this.publish('off', 'Background wake word is off.');
      return;
    }
    if (!this.config.identityReady) {
      await this.stopDetector();
      this.publish('error', 'Sign in to the swarm before enabling background wake word.');
      return;
    }
    if (!this.options.detector.supported) {
      await this.stopDetector();
      this.publish('unavailable', this.options.detector.unsupportedReason || 'No local wake-word engine is available on this platform.');
      return;
    }
    if (this.userPaused) {
      await this.stopDetector();
      this.publish('paused', 'Paused by you. Resume from OSHAL Node or its tray menu.');
      return;
    }
    if (this.surfaceOwnsMicrophone) {
      await this.stopDetector();
      this.publish('paused', 'Jarvis is open; its visible microphone owns listening.');
      return;
    }
    if (this.captureOwnsMicrophone) {
      await this.stopDetector();
      this.publish('paused', 'Push-to-talk owns the microphone.');
      return;
    }
    if (this.detectorRunning) {
      this.publish('listening', 'Local wake-word detection is active. Raw audio is not stored.');
      return;
    }

    const phrase = buildWakePhrase(this.config.assistantName);
    this.publish('starting', 'Starting the local wake-word engine.');
    try {
      await this.options.detector.start({
        phrase,
        locale: this.config.locale || 'en-US',
        onWake: (detection) => void this.handleWake(detection, generation),
        onError: (error) => void this.handleDetectorError(error, generation),
      });
      if (generation !== this.generation) {
        await this.options.detector.stop();
        return;
      }
      this.detectorRunning = true;
      this.publish('listening', 'Local wake-word detection is active. Raw audio is not stored.');
    } catch (error) {
      this.detectorRunning = false;
      await this.options.detector.stop().catch(() => undefined);
      if (generation !== this.generation) return;
      this.publish('error', error instanceof Error ? error.message : 'The local wake-word engine failed to start.');
    }
  }

  private async handleWake(detection: WakeDetection, generation: number): Promise<void> {
    if (generation !== this.generation || !this.detectorRunning) return;
    this.generation += 1;
    await this.stopDetector();
    this.surfaceOwnsMicrophone = true;
    this.publish('triggered', `${this.config.assistantName} heard the wake phrase and is opening.`);
    try {
      await this.options.onWake({
        phrase: buildWakePhrase(this.config.assistantName),
        confidence: clampConfidence(detection.confidence),
        detectedAt: detection.detectedAt,
      });
    } catch (error) {
      this.surfaceOwnsMicrophone = false;
      this.publish('error', error instanceof Error ? error.message : 'Jarvis could not open after the wake phrase.');
    }
  }

  private async handleDetectorError(error: Error, generation: number): Promise<void> {
    if (generation !== this.generation) return;
    this.generation += 1;
    await this.stopDetector();
    this.publish('error', error.message || 'The local wake-word engine stopped unexpectedly.');
  }

  private async stopDetector(): Promise<void> {
    if (!this.detectorRunning && this.status.state !== 'starting') return;
    this.detectorRunning = false;
    await this.options.detector.stop().catch(() => undefined);
  }

  private publish(state: BackgroundWakeState, detail: string): void {
    this.status = this.buildStatus(state, detail);
    this.options.onStatus?.(this.getStatus());
  }

  private buildStatus(state: BackgroundWakeState, detail: string): BackgroundWakeStatus {
    return {
      state,
      enabled: this.config.enabled,
      phrase: buildWakePhrase(this.config.assistantName),
      detail,
      updatedAt: new Date().toISOString(),
    };
  }
}

/**
 * @description Windows-only detector using the installed System.Speech recognizer.
 * The PowerShell child receives a one-phrase grammar, reads the default microphone
 * in memory, and writes only `ready`, `wake`, or `error` JSON events to stdout.
 */
export class WindowsSystemSpeechWakeDetector implements WakeDetector {
  readonly supported: boolean;
  readonly unsupportedReason?: string;
  private child: ChildProcess | null = null;
  private readonly expectedStops = new WeakSet<ChildProcess>();

  constructor(platform: NodeJS.Platform = process.platform) {
    this.supported = platform === 'win32';
    this.unsupportedReason = this.supported
      ? undefined
      : 'Background wake word currently requires the Windows offline speech engine. This platform needs a signed native helper and microphone entitlement.';
  }

  async start(options: WakeDetectorStartOptions): Promise<void> {
    if (!this.supported) throw new Error(this.unsupportedReason);
    await this.stop();

    const script = buildWindowsWakeScript(options.phrase, options.locale);
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded,
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    this.child = child;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let stdout = '';
      let stderr = '';
      const readyTimer = setTimeout(() => finish(new Error('The Windows wake-word engine did not become ready within 10 seconds.')), 10_000);
      readyTimer.unref?.();

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(readyTimer);
        if (error) reject(error); else resolve();
      };

      const acceptLine = (line: string): void => {
        if (!line.trim()) return;
        let event: { type?: string; confidence?: number; message?: string };
        try {
          event = JSON.parse(line) as { type?: string; confidence?: number; message?: string };
        } catch {
          return;
        }
        if (event.type === 'ready') {
          finish();
        } else if (event.type === 'wake') {
          options.onWake({
            phrase: options.phrase,
            confidence: clampConfidence(Number(event.confidence)),
            detectedAt: new Date().toISOString(),
          });
        } else if (event.type === 'error') {
          const error = new Error(event.message || 'The Windows wake-word engine reported an error.');
          if (!settled) finish(error); else options.onError(error);
        }
      };

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout = (stdout + chunk).slice(-8192);
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() || '';
        for (const line of lines) acceptLine(line);
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2048); });
      child.once('error', (error) => {
        if (!settled) finish(error);
        else if (!this.expectedStops.has(child)) options.onError(error);
      });
      child.once('exit', (code) => {
        if (this.child === child) this.child = null;
        if (this.expectedStops.has(child)) {
          if (!settled) finish(new Error('The Windows wake-word engine start was cancelled.'));
          return;
        }
        const message = `The Windows wake-word engine exited${code == null ? '' : ` with code ${code}`}${stderr.trim() ? `: ${stderr.trim()}` : '.'}`;
        if (!settled) finish(new Error(message));
        else options.onError(new Error(message));
      });
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child) return;
    this.expectedStops.add(child);
    if (child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* process already exited */ }
        finish();
      }, 2_000);
      timeout.unref?.();
      child.once('exit', finish);
      try {
        if (!child.killed) child.kill();
      } catch {
        finish();
      }
    });
  }
}

export function sanitizeAssistantName(value: string): string {
  const normalized = String(value || '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} '-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32);
  return normalized || 'Jarvis';
}

export function buildWakePhrase(assistantName: string): string {
  return `Hey ${sanitizeAssistantName(assistantName)}`;
}

function sanitizeLocale(value: string | undefined): string {
  const locale = String(value || 'en-US').replace(/[^A-Za-z0-9-]/g, '').slice(0, 24);
  return locale || 'en-US';
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** Exported for a static safety test; no audio bytes or filesystem/network calls exist in this helper. */
export function buildWindowsWakeScript(phrase: string, locale: string): string {
  const psPhrase = buildWakePhrase(String(phrase).replace(/^hey\s+/i, '')).replace(/'/g, "''");
  const psLocale = sanitizeLocale(locale).replace(/'/g, "''");
  return `$ErrorActionPreference = 'Stop'
$engine = $null
try {
  Add-Type -AssemblyName System.Speech
  $culture = [System.Globalization.CultureInfo]::GetCultureInfo('${psLocale}')
  $engine = [System.Speech.Recognition.SpeechRecognitionEngine]::new($culture)
  $choices = [System.Speech.Recognition.Choices]::new([string[]]@('${psPhrase}'))
  $builder = [System.Speech.Recognition.GrammarBuilder]::new()
  $builder.Culture = $culture
  $builder.Append($choices)
  $grammar = [System.Speech.Recognition.Grammar]::new($builder)
  $engine.LoadGrammar($grammar)
  $engine.SetInputToDefaultAudioDevice()
  [Console]::Out.WriteLine((@{ type = 'ready' } | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  while ($true) {
    $result = $engine.Recognize([TimeSpan]::FromMilliseconds(750))
    if ($null -ne $result -and $result.Confidence -ge 0.70) {
      [Console]::Out.WriteLine((@{ type = 'wake'; confidence = $result.Confidence } | ConvertTo-Json -Compress))
      [Console]::Out.Flush()
    }
  }
} catch {
  [Console]::Out.WriteLine((@{ type = 'error'; message = $_.Exception.Message } | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
  exit 2
} finally {
  if ($null -ne $engine) { $engine.Dispose() }
}`;
}
