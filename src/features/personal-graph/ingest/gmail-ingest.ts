/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                  | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Gmail message -> graph fragment mapper (ADR-066)
 */

/**
 * @module features/personal-graph/ingest/gmail-ingest
 * @description Pure mapper: one Gmail message (the raw item from the ADR-065 `gmail-get-message`
 * resource, format=metadata or full) -> graph nodes + edges.
 *
 * Projection:
 *  - the message -> a Message node (message:gmail:<id>)
 *  - the From person -> a Person node, with `authored` Person -> Message
 *  - each To/Cc person -> a Person node, with `mentions` Message -> Person
 *  - all people deduped by email, so the SAME person discovered in calendar resolves to one node.
 *
 * Header parsing handles "Display Name <email@host>" and bare "email@host", comma-separated lists.
 */

import { edgeId } from '../graph-types';
import type { GraphFragment, GraphNode, GraphEdge, SourceRef } from '../graph-types';
import { buildPerson } from './ingest-helpers';

/** Minimal shape of a Gmail message (subset we use). */
export interface GmailHeader {
  name: string;
  value: string;
}
export interface GmailMessage {
  id: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string; // epoch ms as a string
  payload?: { headers?: GmailHeader[] };
}

const PROVIDER = 'gmail';

interface ParsedAddr {
  email: string;
  name?: string;
}

/** Parse a single address token: "Name <a@b>" or "a@b". */
function parseAddr(token: string): ParsedAddr | undefined {
  const t = token.trim();
  if (!t) return undefined;
  const m = t.match(/^(.*?)<([^>]+)>$/);
  if (m) {
    const name = m[1].replace(/(^["']|["']$)/g, '').trim();
    const email = m[2].trim();
    if (!email) return undefined;
    return { email, name: name || undefined };
  }
  if (t.includes('@')) return { email: t };
  return undefined;
}

/** Parse a comma-separated address header into addresses. */
function parseAddrList(value: string | undefined): ParsedAddr[] {
  if (!value) return [];
  return value
    .split(',')
    .map(parseAddr)
    .filter((x): x is ParsedAddr => Boolean(x));
}

function header(headers: GmailHeader[] | undefined, name: string): string | undefined {
  const h = (headers ?? []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value;
}

export function ingestGmailMessage(msg: GmailMessage, observedAt?: string): GraphFragment {
  const source: SourceRef = { provider: PROVIDER, externalId: msg.id, observedAt };
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const headers = msg.payload?.headers;
  const subject = header(headers, 'Subject');
  const sentAt =
    header(headers, 'Date') ??
    (msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : undefined);

  const messageNodeId = `message:${PROVIDER}:${msg.id}`;
  nodes.push({
    id: messageNodeId,
    type: 'Message',
    label: subject?.trim() || `Message ${msg.id}`,
    sources: [source],
    props: {
      subject,
      snippet: msg.snippet,
      sentAt,
      threadId: msg.threadId,
    },
  });

  // From -> authored.
  for (const from of parseAddrList(header(headers, 'From'))) {
    const person = buildPerson({ email: from.email, name: from.name, source });
    nodes.push(person);
    edges.push({
      id: edgeId('authored', person.id, messageNodeId),
      type: 'authored',
      from: person.id,
      to: messageNodeId,
      sources: [source],
    });
  }

  // To + Cc -> mentions (Message -> Person).
  const recipients = [
    ...parseAddrList(header(headers, 'To')),
    ...parseAddrList(header(headers, 'Cc')),
  ];
  for (const rcpt of recipients) {
    const person = buildPerson({ email: rcpt.email, name: rcpt.name, source });
    nodes.push(person);
    edges.push({
      id: edgeId('mentions', messageNodeId, person.id),
      type: 'mentions',
      from: messageNodeId,
      to: person.id,
      sources: [source],
    });
  }

  return { nodes, edges };
}
