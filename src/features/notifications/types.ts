/**
 * Notifications — the pluggable outbound-transport contract.
 *
 * BACKLOG "Twilio as a pluggable notification transport" + "OSHAL Telegram notification bot": the
 * platform needs to push a message to the operator (a finished creative-studio episode, a trading
 * watchdog alert, a failed overnight job) without hardcoding one vendor — the SAME pluggable-provider
 * discipline the codebase already uses for LLM providers and TTS (per CLAUDE.md's "TTS must be a
 * pluggable harness, parallel to how LLM providers work — build siblings behind an interface"). This
 * is that interface: a `NotificationTransport` any feature calls, with sibling implementations
 * (Telegram first-party today; Twilio SMS/voice as a BYO-account sibling next) selected at runtime.
 *
 * A transport that is not configured is a NO-OP (returns `skipped`), never an error — so a
 * deployment with no channel wired simply doesn't notify, exactly like the LLM/Trivy "absent = no-op"
 * pattern. Secrets (bot tokens) never appear in a result or error.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — NotificationTransport interface + message/result/media shapes + the transport-kind union.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added the 'email' transport kind (derived TransportKind from a runtime TRANSPORT_KINDS list so the severity policy can validate names) + the injected EmailTransportRail so the email transport reuses the app-layer Gmail/connector token rail without the feature layer importing app code.
 *
 * @module features/notifications/types
 */

/**
 * Every transport kind the registry can select, as a runtime list so callers (the severity
 * policy) can validate a configured transport name. `noop` is the always-available default.
 */
export const TRANSPORT_KINDS = ['telegram', 'twilio-sms', 'twilio-voice', 'twilio-whatsapp', 'email', 'noop'] as const;

/** The transport implementations the registry can select. Derived from {@link TRANSPORT_KINDS}. */
export type TransportKind = (typeof TRANSPORT_KINDS)[number];

/** An optional media attachment. `sizeBytes` (when known) lets a transport decide inline vs a link. */
export interface NotificationMedia {
  url: string;
  kind: 'video' | 'image' | 'document';
  caption?: string;
  sizeBytes?: number;
}

/** One outbound notification. */
export interface NotificationMessage {
  /** Plain text (no markup assumed; a transport escapes/limits as its API requires). */
  text: string;
  /** Optional media; large media falls back to a link per the transport's size cap. */
  media?: NotificationMedia;
}

/** The outcome of a send. `skipped` = the transport wasn't configured (a no-op, not a failure). */
export interface NotificationResult {
  delivered: boolean;
  transport: TransportKind;
  /** Provider message id when delivered. */
  id?: string;
  /** True when media exceeded the transport's inline cap and the link was sent instead. */
  fellBackToLink?: boolean;
  /** Set when the transport isn't configured (delivered=false, not an error). */
  skipped?: boolean;
  /** Sanitized error (never contains a token/secret). */
  error?: string;
}

/**
 * A pluggable outbound channel. Implementations are siblings behind this interface — add a vendor by
 * adding a class + a registry entry, never by wiring the vendor into a caller.
 */
export interface NotificationTransport {
  /** Stable identifier used by the registry + surfaced in results. */
  readonly kind: TransportKind;
  /** True only when every credential/config this transport needs is present. */
  configured(): boolean;
  /** Deliver the message. MUST resolve (never throw) — a transport error is a result, not an exception. */
  send(message: NotificationMessage): Promise<NotificationResult>;
}

/**
 * The app-layer email delivery rail the email transport delivers over. The feature layer cannot
 * import the Gmail/connector machinery (it lives in app/), so the app injects this narrow port:
 * `getAccessToken` resolves a valid OAuth token from the connector broker (null when unavailable),
 * `sendEmail` wraps the existing Gmail send, and `to` is the operator inbox. No SMTP creds, no
 * secrets in the transport — the token stays inside this rail. Absent => the email transport no-ops.
 */
export interface EmailTransportRail {
  /** The recipient address the operator alert email goes to (e.g. NOTIFY_EMAIL_TO). */
  readonly to: string;
  /** Resolve a valid access token for the sending identity, or null when none is available. */
  getAccessToken(): Promise<string | null>;
  /** Send the email over the connector rail; resolves the provider message id. Must throw on failure. */
  sendEmail(token: string, msg: { to: string; subject: string; body: string }): Promise<{ id: string }>;
}

/** Injected dependencies (so transports are unit-testable without real network / env). */
export interface TransportDeps {
  /** fetch implementation (defaults to global fetch). */
  fetch?: typeof fetch;
  /** Env source (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** App-injected Gmail/connector rail for the email transport; absent => the email transport no-ops. */
  email?: EmailTransportRail;
}
