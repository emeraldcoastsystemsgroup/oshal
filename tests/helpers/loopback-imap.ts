/**
 * A loopback IMAP4rev1 responder for specs whose boundary is the IMAP protocol.
 *
 * It speaks the real wire protocol over a real TCP socket on 127.0.0.1 — greeting, CAPABILITY,
 * LOGIN, LIST, EXAMINE/SELECT, FETCH (UID FLAGS INTERNALDATE ENVELOPE) and LOGOUT, with
 * synchronizing literals — so a client library is exercised end to end rather than mocked.
 * Every command is recorded (LOGIN arguments redacted) and every accepted connection counted, so
 * a spec can assert what a reader sent and that a refused input never opened a socket. Plain TCP
 * only: the production endpoint's TLS is pinned by the reader's own constant, not by this fixture.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial: per-account inboxes, LOGIN NO [AUTHENTICATIONFAILED] for a wrong password, READ-ONLY EXAMINE vs READ-WRITE SELECT, sequence-range FETCH with envelopes, command and connection recording.
 */
import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

/** One stored message. */
export interface LoopbackImapMessage {
  uid: number;
  flags: string[];
  /** ISO time; rendered as the IMAP INTERNALDATE. */
  receivedAt: string;
  subject: string;
  fromName: string;
  fromAddress: string;
}

/** One mailbox account the responder accepts. */
export interface LoopbackImapAccount {
  password: string;
  inbox: LoopbackImapMessage[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** IMAP quoted string. */
function q(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** ISO → `27-Sep-2026 14:05:00 +0000`. */
function internalDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
}

/** The ENVELOPE structure for one message. */
function envelope(m: LoopbackImapMessage): string {
  const [mailbox, host] = m.fromAddress.split('@');
  const from = `((${q(m.fromName)} NIL ${q(mailbox)} ${q(host)}))`;
  return `(${q(new Date(m.receivedAt).toUTCString())} ${q(m.subject)} ${from} ${from} ${from} ((NIL NIL "me" "mail.example.com")) NIL NIL NIL ${q(`<${m.uid}@mail.example.com>`)})`;
}

/** Split command arguments: quoted strings, parenthesized groups and atoms. */
function tokens(text: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\([^)]*\))|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : (m[2] ?? m[3]));
  return out;
}

/** A loopback IMAP server with recorded commands. */
export class LoopbackImap {
  /** Every command received, `LOGIN` arguments redacted, in order. */
  readonly commands: string[] = [];
  /** Connections accepted since start. */
  connections = 0;
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();

  /**
   * @description Build a responder over fixed accounts.
   * @param accounts - address → password + inbox.
   * @returns The responder (call start()).
   */
  constructor(private readonly accounts: Record<string, LoopbackImapAccount>) {}

  /**
   * @description Listen on an ephemeral 127.0.0.1 port.
   * @returns The port.
   */
  async start(): Promise<number> {
    this.server = createServer((socket) => this.accept(socket));
    await new Promise<void>((done) => this.server!.listen(0, '127.0.0.1', () => done()));
    return (this.server.address() as AddressInfo).port;
  }

  /**
   * @description Close every socket and the listener.
   * @returns Resolves when closed.
   */
  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    if (this.server) await new Promise<void>((done) => this.server!.close(() => done()));
    this.server = null;
  }

  private accept(socket: Socket): void {
    this.connections += 1;
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => this.sockets.delete(socket));
    const session = { user: '' as string, buffer: '', literal: 0, pending: '' };
    socket.write('* OK [CAPABILITY IMAP4rev1] loopback IMAP ready\r\n');
    socket.on('data', (chunk) => {
      session.buffer += chunk.toString('utf8');
      this.drain(socket, session);
    });
  }

  /** Consume complete command lines (honoring synchronizing literals) from the buffer. */
  private drain(socket: Socket, s: { user: string; buffer: string; literal: number; pending: string }): void {
    for (;;) {
      if (s.literal > 0) {
        if (s.buffer.length < s.literal) return;
        s.pending += `"${s.buffer.slice(0, s.literal).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
        s.buffer = s.buffer.slice(s.literal);
        s.literal = 0;
      }
      const end = s.buffer.indexOf('\r\n');
      if (end < 0) return;
      const line = s.buffer.slice(0, end);
      s.buffer = s.buffer.slice(end + 2);
      const literal = /\{(\d+)(\+?)\}$/.exec(line);
      if (literal) {
        s.pending += line.slice(0, literal.index);
        s.literal = Number(literal[1]);
        if (!literal[2]) socket.write('+ go ahead\r\n');
        continue;
      }
      const command = s.pending + line;
      s.pending = '';
      this.respond(socket, s, command);
    }
  }

  private respond(socket: Socket, s: { user: string }, line: string): void {
    const [tag, rawName = '', ...rest] = line.split(' ');
    const name = rawName.toUpperCase();
    const args = tokens(rest.join(' '));
    const sub = name === 'UID' ? `${name} ${String(args[0] || '').toUpperCase()}` : name;
    this.commands.push(name === 'LOGIN' ? 'LOGIN <redacted>' : `${sub} ${args.join(' ')}`.trim());
    const ok = (text: string) => socket.write(`${tag} OK ${text}\r\n`);
    if (name === 'CAPABILITY') { socket.write('* CAPABILITY IMAP4rev1\r\n'); ok('CAPABILITY completed'); return; }
    if (name === 'LOGIN') { this.login(socket, s, tag, args); return; }
    if (name === 'LOGOUT') { socket.write('* BYE logging out\r\n'); ok('LOGOUT completed'); socket.end(); return; }
    if (name === 'LIST') { socket.write('* LIST (\\HasNoChildren) "/" INBOX\r\n'); ok('LIST completed'); return; }
    if (name === 'EXAMINE' || name === 'SELECT') { this.open(socket, s, tag, name); return; }
    if (name === 'FETCH') { this.fetch(socket, s, tag, String(args[0] || '')); return; }
    ok(`${name} completed`);
  }

  private login(socket: Socket, s: { user: string }, tag: string, args: string[]): void {
    const account = this.accounts[String(args[0] || '').toLowerCase()];
    if (!account || account.password !== args[1]) {
      socket.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
      return;
    }
    s.user = String(args[0]).toLowerCase();
    socket.write(`${tag} OK [CAPABILITY IMAP4rev1] LOGIN completed\r\n`);
  }

  private open(socket: Socket, s: { user: string }, tag: string, name: string): void {
    const inbox = this.accounts[s.user]?.inbox ?? [];
    const next = inbox.reduce((max, m) => Math.max(max, m.uid), 0) + 1;
    socket.write('* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n');
    socket.write(`* ${inbox.length} EXISTS\r\n* 0 RECENT\r\n`);
    socket.write(`* OK [UIDVALIDITY 7] UIDs valid\r\n* OK [UIDNEXT ${next}] Predicted next UID\r\n`);
    socket.write(`${tag} OK [${name === 'EXAMINE' ? 'READ-ONLY' : 'READ-WRITE'}] ${name} completed\r\n`);
  }

  private fetch(socket: Socket, s: { user: string }, tag: string, range: string): void {
    const inbox = this.accounts[s.user]?.inbox ?? [];
    const [a, b] = range.split(':');
    const from = Number(a);
    const to = b === undefined ? from : b === '*' ? inbox.length : Number(b);
    for (let seq = from; seq <= Math.min(to, inbox.length); seq++) {
      const m = inbox[seq - 1];
      socket.write(`* ${seq} FETCH (UID ${m.uid} FLAGS (${m.flags.join(' ')}) INTERNALDATE ${q(internalDate(m.receivedAt))} ENVELOPE ${envelope(m)})\r\n`);
    }
    socket.write(`${tag} OK FETCH completed\r\n`);
  }
}
