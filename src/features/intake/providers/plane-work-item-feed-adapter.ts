/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Plane intake adapter scaffold with normalized work-item mapping
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Aligned Plane intake normalization to canonical OSHAL ticket states and root-only subticket visibility
 */

import {
  ExternalWorkItemSchema,
  buildExternalTicketHierarchy,
  buildExternalTicketWorkflow,
  normalizeOshalTicketState,
  shouldDisplayTicketAtRoot,
  type ExternalWorkItem,
} from '@/entities/ticket';
import { createChildLogger } from '@/shared/logger';
import {
  type IntakeProvider,
} from '@/shared/types';
import type {
  PullWorkItemsInput,
  PullWorkItemsResult,
  WorkItemFeedAdapter,
} from '../services/work-item-feed-adapter';

const logger = createChildLogger({ module: 'plane-work-item-feed-adapter' });

/**
 * @description Plane provider adapter that pulls issues and maps them to normalized intake items.
 */
export class PlaneWorkItemFeedAdapter implements WorkItemFeedAdapter {
  readonly provider: IntakeProvider = 'plane';

  private readonly planeApiUrl = process.env.PLANE_API_URL?.trim();
  private readonly planeApiToken = process.env.PLANE_API_TOKEN?.trim();
  private readonly planeWorkspaceSlug = process.env.PLANE_WORKSPACE_SLUG?.trim();
  private readonly planeProjectId = process.env.PLANE_PROJECT_ID?.trim();
  private readonly planeIntakeUrl = process.env.PLANE_INTAKE_URL?.trim();

  async pullWorkItems(input: PullWorkItemsInput): Promise<PullWorkItemsResult> {
    const requestUrl = this.resolveRequestUrl(input);
    if (!requestUrl || !this.planeApiToken) {
      logger.warn(
        {
          hasRequestUrl: Boolean(requestUrl),
          hasPlaneApiToken: Boolean(this.planeApiToken),
          hasPlaneApiUrl: Boolean(this.planeApiUrl),
          hasPlaneWorkspaceSlug: Boolean(this.planeWorkspaceSlug),
          hasPlaneProjectId: Boolean(this.planeProjectId),
          hasPlaneIntakeUrl: Boolean(this.planeIntakeUrl),
        },
        'Skipping Plane intake pull because required configuration is missing',
      );

      return {
        items: [],
        source: 'plane-config-missing',
      };
    }

    logger.info(
      {
        provider: this.provider,
        requestUrl: requestUrl.toString(),
        limit: input.limit,
        cursor: input.cursor,
      },
      'Pulling work items from Plane',
    );

    const response = await fetch(requestUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.planeApiToken}`,
        'X-API-Key': this.planeApiToken,
      },
    });

    if (!response.ok) {
      const responseBody = await response.text();
      logger.error(
        {
          provider: this.provider,
          status: response.status,
          responseBody,
        },
        'Plane intake pull failed',
      );
      throw new Error(`Plane intake pull failed with status ${response.status}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const rawItems = readRawItems(payload);
    const items = rawItems
      .map((rawItem) => normalizePlaneItem(rawItem))
      .filter((value): value is ExternalWorkItem => value !== null)
      .filter((value) => input.includeSubtickets ? true : shouldDisplayTicketAtRoot(value));

    const nextCursor = readNextCursor(payload);

    logger.info(
      {
        provider: this.provider,
        pulledCount: items.length,
        nextCursor,
        includeSubtickets: input.includeSubtickets ?? false,
      },
      'Plane intake pull complete',
    );

    return {
      items,
      nextCursor,
      source: requestUrl.toString(),
    };
  }

  /**
   * @description Resolves the effective Plane intake URL from env configuration.
   */
  private resolveRequestUrl(input: PullWorkItemsInput): URL | null {
    const candidate = this.planeIntakeUrl || this.buildDerivedPlaneUrl();
    if (!candidate) {
      return null;
    }

    const requestUrl = new URL(candidate);
    requestUrl.searchParams.set('limit', String(input.limit));

    if (input.cursor) {
      requestUrl.searchParams.set('cursor', input.cursor);
    }

    if (input.since) {
      requestUrl.searchParams.set('since', input.since);
    }

    requestUrl.searchParams.set('order_by', '-updated_at');
    return requestUrl;
  }

  /**
   * @description Builds a default Plane issues URL when PLANE_INTAKE_URL is not provided.
   */
  private buildDerivedPlaneUrl(): string | null {
    if (!this.planeApiUrl || !this.planeWorkspaceSlug || !this.planeProjectId) {
      return null;
    }

    return `${this.planeApiUrl}/api/v1/workspaces/${this.planeWorkspaceSlug}/projects/${this.planeProjectId}/issues/`;
  }
}

/**
 * @description Reads the provider result array from known Plane response envelopes.
 */
function readRawItems(payload: Record<string, unknown>): unknown[] {
  if (Array.isArray(payload.results)) {
    return payload.results;
  }

  if (Array.isArray(payload.issues)) {
    return payload.issues;
  }

  if (Array.isArray(payload.data)) {
    return payload.data;
  }

  return [];
}

/**
 * @description Reads the next cursor from known Plane response envelopes.
 */
function readNextCursor(payload: Record<string, unknown>): string | undefined {
  const directCursor = readString(payload.next_cursor) || readString(payload.nextCursor);
  if (directCursor) {
    return directCursor;
  }

  const pagination = asObject(payload.pagination);
  if (!pagination) {
    return undefined;
  }

  return readString(pagination.next_cursor) || readString(pagination.nextCursor) || undefined;
}

/**
 * @description Maps one raw Plane issue into the normalized external work-item contract.
 */
function normalizePlaneItem(rawItem: unknown): ExternalWorkItem | null {
  const item = asObject(rawItem);
  if (!item) {
    return null;
  }

  const externalId =
    readString(item.id) ||
    readString(item.uuid) ||
    readString(item.issue_id) ||
    readString(item.key);

  const title = readString(item.name) || readString(item.title);

  if (!externalId || !title) {
    return null;
  }

  const labels = readLabels(item.labels);
  const status = readString(asObject(item.state)?.name) || readString(item.status) || undefined;
  const priority = readString(item.priority) || undefined;
  const stateKey = normalizeOshalTicketState(status);
  const childExternalIds = readChildExternalIds(item);
  const parentExternalId = readParentExternalId(item);

  const normalized = {
    provider: 'plane' as const,
    externalId,
    title,
    body: readString(item.description_html) || readString(item.description) || '',
    labels,
    priority,
    status,
    actor: {
      id: readString(asObject(item.created_by)?.id) || undefined,
      name: readString(asObject(item.created_by)?.display_name) || readString(asObject(item.created_by)?.name) || undefined,
      email: readString(asObject(item.created_by)?.email) || undefined,
    },
    timestamps: {
      createdAt: readString(item.created_at) || undefined,
      updatedAt: readString(item.updated_at) || undefined,
    },
    workflow: buildExternalTicketWorkflow(stateKey),
    hierarchy: buildExternalTicketHierarchy(externalId, {
      parentExternalId,
      childExternalIds,
      childCount: readChildCount(item, childExternalIds.length),
    }),
    rawPayload: rawItem,
  };

  return ExternalWorkItemSchema.parse(normalized);
}

/**
 * @description Reads label names from Plane issue label payloads.
 */
function readLabels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const labels: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim().length > 0) {
      labels.push(entry.trim());
      continue;
    }

    const labelObject = asObject(entry);
    const labelName = labelObject ? readString(labelObject.name) : null;
    if (labelName) {
      labels.push(labelName);
    }
  }

  return labels;
}

/**
 * @description Reads the provider parent issue identifier when the current issue is a subticket.
 */
function readParentExternalId(item: Record<string, unknown>): string | undefined {
  const directParent = readString(item.parent_id) || readString(item.parentId);
  if (directParent) {
    return directParent;
  }

  const parentObject = asObject(item.parent) || asObject(item.parent_issue) || asObject(item.parentIssue);
  if (!parentObject) {
    return undefined;
  }

  return toOptionalString(
    readString(parentObject.id) || readString(parentObject.uuid) || readString(parentObject.issue_id),
  );
}

/**
 * @description Normalizes nullable string-like values into optional strings.
 */
function toOptionalString(value: string | null): string | undefined {
  return value ?? undefined;
}

/**
 * @description Reads child issue identifiers from known Plane child collections.
 */
function readChildExternalIds(item: Record<string, unknown>): string[] {
  const sources = [
    item.children,
    item.child_issues,
    item.childIssues,
    item.sub_issues,
    item.subIssues,
  ];

  for (const source of sources) {
    if (!Array.isArray(source)) {
      continue;
    }

    return source
      .map((entry) => {
        if (typeof entry === 'string') {
          return readString(entry);
        }

        const childObject = asObject(entry);
        if (!childObject) {
          return null;
        }

        return readString(childObject.id) || readString(childObject.uuid) || readString(childObject.issue_id);
      })
      .filter((value): value is string => Boolean(value));
  }

  return [];
}

/**
 * @description Reads child count from known Plane count fields, falling back to enumerated child ids.
 */
function readChildCount(item: Record<string, unknown>, fallbackCount: number): number {
  const countCandidates = [
    item.child_count,
    item.childCount,
    item.sub_issue_count,
    item.subIssueCount,
  ];

  for (const value of countCandidates) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }

  return fallbackCount;
}

/**
 * @description Reads a string value from unknown payloads.
 */
function readString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * @description Casts unknown payloads into plain objects when possible.
 */
function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}
