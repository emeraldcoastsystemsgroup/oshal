/**
 * Connector write-action declarations + parameter validation (connector-writes tier).
 *
 * The 306-connector catalog is deliberately GET-only at the resource level. This module defines
 * the OPT-IN `actions` block a connector.yaml may declare (schema: swarm-apps/connector.schema.json)
 * for real, documented write endpoints — each with an explicit JSON-Schema params contract and a
 * declared risk level. Validation runs BEFORE any credential resolution or HTTP work so a malformed
 * request never touches the provider (mirrors the fail-closed risky-write guard doctrine).
 *
 * The validator is a deliberate draft-07 SUBSET (type/required/properties/enum/const/pattern/
 * min-max/items/additionalProperties) implemented locally: the repo has no ajv dependency and the
 * action contracts we author stay inside this subset by construction.
 *
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — write-capable connector action tier: SpecAction type, spec-level validation, approval gating decision, and the params JSON-Schema-subset validator.
 *
 * @module connectors/runtime/action-params
 */

/** @description Risk tiers for a connector write action. medium/high can never skip the confirm gate. */
export type SpecActionRiskLevel = 'low' | 'medium' | 'high';

/** @description Mutating HTTP methods an action may declare (GET stays on the resources tier). */
export type SpecActionMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * @description One declared write action on a connector: a real, documented provider mutation with
 * an explicit params contract. `urlTemplate` is a path template relative to the spec baseUrl whose
 * `{placeholders}` bind to validated params (URL-encoded); remaining params become the JSON body
 * (POST/PUT/PATCH) or query string (DELETE).
 */
export interface SpecAction {
  /** Action slug — the `:action` segment of POST /api/connectors/:id/actions/:action. */
  name: string;
  method: SpecActionMethod;
  /** Path template relative to baseUrl, e.g. `/repos/{owner}/{repo}/issues`. */
  urlTemplate: string;
  /** JSON Schema (draft-07 subset) that the request params must satisfy before any HTTP call. */
  paramsSchema: Record<string, unknown>;
  riskLevel: SpecActionRiskLevel;
  /** Force the confirm gate even at riskLevel low. `false` can NOT relax the medium/high gate. */
  approvalRequired?: boolean;
  description: string;
}

const ACTION_SLUG = /^[a-z0-9][a-z0-9-]*$/;
const ACTION_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ACTION_RISKS: ReadonlySet<string> = new Set(['low', 'medium', 'high']);

/**
 * @description Validates a spec's optional `actions` block at load time, throwing a clear error on
 * the first malformed entry so a broken connector.yaml fails loudly instead of shipping an
 * unguardable write. Absent/empty blocks are valid — the catalog stays GET-only by default.
 * @param provider Connector slug, used only in error messages.
 * @param actions The raw `actions` value parsed from connector.yaml (may be undefined).
 * @returns The validated actions array (empty when the block is absent).
 */
export function validateSpecActions(provider: string, actions: unknown): SpecAction[] {
  if (actions === undefined || actions === null) return [];
  const fail = (m: string): never => { throw new Error(`invalid connector spec (${provider}): ${m}`); };
  if (!Array.isArray(actions)) fail('actions must be an array');
  const seen = new Set<string>();
  for (const a of actions as SpecAction[]) {
    if (!a || typeof a !== 'object') fail('action must be an object');
    if (!a.name || !ACTION_SLUG.test(a.name)) fail(`action name must be a lowercase slug, got '${a.name}'`);
    if (seen.has(a.name)) fail(`duplicate action name '${a.name}'`);
    seen.add(a.name);
    if (!ACTION_METHODS.has(a.method)) fail(`action ${a.name}: method must be POST|PUT|PATCH|DELETE, got '${a.method}'`);
    if (!a.urlTemplate || typeof a.urlTemplate !== 'string') fail(`action ${a.name}: urlTemplate required`);
    if (!a.paramsSchema || typeof a.paramsSchema !== 'object') fail(`action ${a.name}: paramsSchema required`);
    if (!ACTION_RISKS.has(a.riskLevel)) fail(`action ${a.name}: riskLevel must be low|medium|high, got '${a.riskLevel}'`);
    if (a.approvalRequired !== undefined && typeof a.approvalRequired !== 'boolean') fail(`action ${a.name}: approvalRequired must be boolean`);
    if (!a.description || typeof a.description !== 'string') fail(`action ${a.name}: description required`);
  }
  return actions as SpecAction[];
}

/**
 * @description The single gating decision for a connector write action: riskLevel medium/high OR an
 * explicit approvalRequired=true routes through the risky-write confirm rail (HTTP 428 +
 * confirmation_required until the caller sends confirm:true). Fail-closed by construction:
 * `approvalRequired: false` only matters at riskLevel low — it can never relax medium/high.
 * @param action The declared action.
 * @returns true when the action must carry an explicit confirmation to execute.
 */
export function connectorActionRequiresApproval(action: SpecAction): boolean {
  if (action.approvalRequired === true) return true;
  return action.riskLevel === 'medium' || action.riskLevel === 'high';
}

// --- params validation (draft-07 subset) -------------------------------------

type JsonSchema = Record<string, unknown>;

/**
 * @description Validates action params against the action's declared paramsSchema (draft-07 subset:
 * type, required, properties, additionalProperties:false, enum, const, pattern, minLength/maxLength,
 * minimum/maximum, items, minItems/maxItems). Returns human-readable errors instead of throwing so
 * the route can 400 with the full list — the caller fixes everything in one round trip.
 * @param schema The action's paramsSchema.
 * @param value The caller-supplied params object.
 * @param path Error-message prefix for the current location (default 'params').
 * @returns An array of violation messages; empty means the params are valid.
 */
export function validateActionParams(schema: unknown, value: unknown, path = 'params'): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const s = schema as JsonSchema;
  const errors: string[] = [];
  const typeError = checkType(s, value, path);
  if (typeError) return [typeError]; // wrong type => nested checks would only cascade noise
  checkEnumConst(s, value, path, errors);
  if (typeof value === 'string') checkStringConstraints(s, value, path, errors);
  if (typeof value === 'number') checkNumberConstraints(s, value, path, errors);
  if (Array.isArray(value)) checkArrayConstraints(s, value, path, errors);
  if (value && typeof value === 'object' && !Array.isArray(value)) checkObjectConstraints(s, value as Record<string, unknown>, path, errors);
  return errors;
}

function checkType(s: JsonSchema, value: unknown, path: string): string | undefined {
  if (s.type === undefined) return undefined;
  const types = Array.isArray(s.type) ? (s.type as string[]) : [String(s.type)];
  const matches = types.some((t) => matchesType(t, value));
  return matches ? undefined : `${path}: expected ${types.join('|')}, got ${describeType(value)}`;
}

function matchesType(t: string, value: unknown): boolean {
  switch (t) {
    case 'object': return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return false;
  }
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function checkEnumConst(s: JsonSchema, value: unknown, path: string, errors: string[]): void {
  if (Array.isArray(s.enum) && !(s.enum as unknown[]).some((e) => deepEqual(e, value))) {
    errors.push(`${path}: must be one of ${JSON.stringify(s.enum)}`);
  }
  if (s.const !== undefined && !deepEqual(s.const, value)) {
    errors.push(`${path}: must equal ${JSON.stringify(s.const)}`);
  }
}

function checkStringConstraints(s: JsonSchema, value: string, path: string, errors: string[]): void {
  if (typeof s.minLength === 'number' && value.length < s.minLength) errors.push(`${path}: shorter than minLength ${s.minLength}`);
  if (typeof s.maxLength === 'number' && value.length > s.maxLength) errors.push(`${path}: longer than maxLength ${s.maxLength}`);
  if (typeof s.pattern === 'string' && !new RegExp(s.pattern).test(value)) errors.push(`${path}: does not match pattern ${s.pattern}`);
}

function checkNumberConstraints(s: JsonSchema, value: number, path: string, errors: string[]): void {
  if (typeof s.minimum === 'number' && value < s.minimum) errors.push(`${path}: below minimum ${s.minimum}`);
  if (typeof s.maximum === 'number' && value > s.maximum) errors.push(`${path}: above maximum ${s.maximum}`);
}

function checkArrayConstraints(s: JsonSchema, value: unknown[], path: string, errors: string[]): void {
  if (typeof s.minItems === 'number' && value.length < s.minItems) errors.push(`${path}: fewer than minItems ${s.minItems}`);
  if (typeof s.maxItems === 'number' && value.length > s.maxItems) errors.push(`${path}: more than maxItems ${s.maxItems}`);
  if (s.items && typeof s.items === 'object') {
    value.forEach((item, i) => errors.push(...validateActionParams(s.items, item, `${path}[${i}]`)));
  }
}

function checkObjectConstraints(s: JsonSchema, value: Record<string, unknown>, path: string, errors: string[]): void {
  const properties = (s.properties && typeof s.properties === 'object' ? s.properties : {}) as Record<string, unknown>;
  if (Array.isArray(s.required)) {
    for (const key of s.required as string[]) {
      if (value[key] === undefined) errors.push(`${path}.${key}: required`);
    }
  }
  for (const [key, sub] of Object.entries(properties)) {
    if (value[key] !== undefined) errors.push(...validateActionParams(sub, value[key], `${path}.${key}`));
  }
  if (s.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) errors.push(`${path}.${key}: unexpected property`);
    }
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
