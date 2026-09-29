/**
 * The GA4 Admin checklist (config/analytics/ga4-admin-checklist.v1.json):
 * decision-grade, event-scoped custom dimensions and key events only.
 *
 * Every dimension must be a parameter the event contract actually sends on
 * every listed source event, closed-vocabulary and marked decision-grade
 * there — never an identifier, amount or free-form value. Only the
 * webhook-authoritative purchase may be a key event; every other
 * decision-grade event carries an explicit "not a key event" decision, so no
 * funnel step is marked. Items stay `owner_action_pending`: nothing offline
 * can prove an Admin change happened, so nothing here may claim it did.
 *
 * The readback plan is a list of read-only Admin/Data API requests built
 * deterministically from the checklist; the evaluators turn their responses
 * into a bounded verdict. This module makes no request and reads no
 * credential.
 */
import {
  ANALYTICS_EVENT_CONTRACT_VERSION,
  GA4_DECISION_GRADE_EVENTS,
  GA4_KEY_EVENT_POLICY,
  GA4_PURCHASE_CONTRACT,
  browserEventSpec,
  ga4DimensionEligibility,
  ga4DimensionValueAllowed,
} from './analytics-event-contract.ts';
import {
  IssueCollector,
  checkClosedObject,
  hasOwn,
  isCalendarDate,
  isPlainRecord,
} from './campaign-governance.ts';
import { HSB_GA4_MEASUREMENT_ID } from './ga-cookie-identity.ts';
import { readGa4RunReport } from './ga4-run-report.ts';

export const GA4_ADMIN_CHECKLIST_SCHEMA = 'hsb.ga4_admin_checklist';
export const GA4_ADMIN_CHECKLIST_VERSION = 1;
export const GA4_READONLY_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

const PENDING = 'owner_action_pending';
const MAX_CUSTOM_DIMENSIONS = 50;
const PARAM_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const RESERVED_PARAM_PREFIX_RE = /^(?:google_|ga_|firebase_)/i;
const DISPLAY_NAME_RE = /^[A-Za-z][A-Za-z0-9_ ]{0,81}$/;
const PROPERTY_ID_RE = /^[1-9]\d{5,14}$/;
const PROBE_ROW_LIMIT = 1000;

const CHECKLIST_KEYS = [
  'schema', 'schema_version', 'event_contract_version', 'measurement_id', 'custom_dimensions', 'key_events', 'not_key_events',
] as const;
const DIMENSION_KEYS = ['parameter_name', 'display_name', 'scope', 'source_events', 'rationale', 'status'] as const;
const KEY_EVENT_KEYS = ['event_name', 'counting_method', 'rationale', 'status'] as const;
const NOT_KEY_EVENT_KEYS = ['event_name', 'rationale'] as const;

interface ChecklistDimension {
  parameter_name: string;
  display_name: string;
  scope: string;
  source_events: string[];
}

function isContractEvent(name: unknown): name is string {
  return typeof name === 'string' && (name === GA4_PURCHASE_CONTRACT.event || browserEventSpec(name) !== null);
}

/** Prose rationale for a human reviewer: one bounded line, no address or URL. */
function rationaleValid(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 280
    && !/[\r\n]/.test(value) && !value.includes('@') && !value.includes('://');
}

function checkStatus(value: unknown, path: string, out: IssueCollector): void {
  if (value !== PENDING) out.add('STATUS_NOT_PENDING', path);
}

function validateDimension(item: unknown, path: string, out: IssueCollector): ChecklistDimension | null {
  if (!checkClosedObject(item, DIMENSION_KEYS, path, out)) return null;
  const at = (field: string) => `${path}.${field}`;
  const before = out.count;
  const name = item.parameter_name;
  const nameValid = typeof name === 'string' && PARAM_NAME_RE.test(name) && !RESERVED_PARAM_PREFIX_RE.test(name);
  if (!nameValid) out.add('DIMENSION_PARAM_NAME_INVALID', at('parameter_name'));
  if (typeof item.display_name !== 'string' || !DISPLAY_NAME_RE.test(item.display_name)) {
    out.add('DIMENSION_DISPLAY_NAME_INVALID', at('display_name'));
  }
  if (item.scope !== 'EVENT') out.add('DIMENSION_SCOPE_NOT_EVENT', at('scope'));
  const events = item.source_events;
  const eventsValid = Array.isArray(events) && events.length > 0
    && events.every(isContractEvent) && new Set(events).size === events.length;
  if (!eventsValid) out.add('DIMENSION_SOURCE_EVENTS_INVALID', at('source_events'));
  if (!rationaleValid(item.rationale)) out.add('RATIONALE_INVALID', at('rationale'));
  checkStatus(item.status, at('status'), out);
  if (nameValid && eventsValid) {
    const eligibility = (events as string[]).map((event) => ga4DimensionEligibility(event, name as string));
    if (eligibility.includes('undeclared')) out.add('DIMENSION_PARAM_UNDECLARED', at('parameter_name'));
    else if (eligibility.includes('not_eligible')) out.add('DIMENSION_PARAM_NOT_ELIGIBLE', at('parameter_name'));
  }
  if (out.count !== before) return null;
  return {
    parameter_name: name as string,
    display_name: item.display_name as string,
    scope: item.scope as string,
    source_events: [...(events as string[])],
  };
}

/** Value-free `CODE@$.path` issues; an empty array means the checklist is governed. */
export function validateGa4AdminChecklist(doc: unknown): string[] {
  const out = new IssueCollector();
  if (!isPlainRecord(doc)) {
    out.add('DOCUMENT_NOT_OBJECT', '$');
    return out.issues;
  }
  if (doc.schema !== GA4_ADMIN_CHECKLIST_SCHEMA) {
    out.add('SCHEMA_INVALID', '$.schema');
    return out.issues;
  }
  if (doc.schema_version !== GA4_ADMIN_CHECKLIST_VERSION) {
    out.add('SCHEMA_VERSION_UNSUPPORTED', '$.schema_version');
    return out.issues;
  }
  checkClosedObject(doc, CHECKLIST_KEYS, '$', out);
  if (doc.event_contract_version !== ANALYTICS_EVENT_CONTRACT_VERSION) {
    out.add('EVENT_CONTRACT_VERSION_MISMATCH', '$.event_contract_version');
  }
  if (doc.measurement_id !== HSB_GA4_MEASUREMENT_ID) out.add('MEASUREMENT_ID_MISMATCH', '$.measurement_id');

  if (!Array.isArray(doc.custom_dimensions)) {
    out.add('TYPE_ARRAY', '$.custom_dimensions');
  } else {
    if (doc.custom_dimensions.length > MAX_CUSTOM_DIMENSIONS) out.add('DIMENSION_LIMIT_EXCEEDED', '$.custom_dimensions');
    const names = new Set<string>();
    const displayNames = new Set<string>();
    doc.custom_dimensions.forEach((item, index) => {
      const path = `$.custom_dimensions[${index}]`;
      const dimension = validateDimension(item, path, out);
      if (!dimension) return;
      if (names.has(dimension.parameter_name)) out.add('DIMENSION_DUPLICATE', `${path}.parameter_name`);
      else if (displayNames.has(dimension.display_name)) out.add('DIMENSION_DUPLICATE', `${path}.display_name`);
      names.add(dimension.parameter_name);
      displayNames.add(dimension.display_name);
    });
  }

  const notKey = new Set<string>();
  if (!Array.isArray(doc.not_key_events)) {
    out.add('TYPE_ARRAY', '$.not_key_events');
  } else {
    doc.not_key_events.forEach((item, index) => {
      const path = `$.not_key_events[${index}]`;
      if (!checkClosedObject(item, NOT_KEY_EVENT_KEYS, path, out)) return;
      if (!isContractEvent(item.event_name)) out.add('KEY_EVENT_DECISION_UNKNOWN_EVENT', `${path}.event_name`);
      else if (notKey.has(item.event_name)) out.add('KEY_EVENT_DUPLICATE', `${path}.event_name`);
      else notKey.add(item.event_name);
      if (!rationaleValid(item.rationale)) out.add('RATIONALE_INVALID', `${path}.rationale`);
    });
  }

  const keyEvents = new Set<string>();
  if (!Array.isArray(doc.key_events)) {
    out.add('TYPE_ARRAY', '$.key_events');
  } else {
    doc.key_events.forEach((item, index) => {
      const path = `$.key_events[${index}]`;
      if (!checkClosedObject(item, KEY_EVENT_KEYS, path, out)) return;
      const name = item.event_name;
      const eligible = typeof name === 'string' && hasOwn(GA4_KEY_EVENT_POLICY, name);
      if (!eligible) out.add('KEY_EVENT_NOT_ELIGIBLE', `${path}.event_name`);
      else if (item.counting_method !== GA4_KEY_EVENT_POLICY[name]) out.add('KEY_EVENT_COUNTING_METHOD_INVALID', `${path}.counting_method`);
      if (typeof name === 'string') {
        if (notKey.has(name)) out.add('KEY_EVENT_DECISION_CONFLICT', `${path}.event_name`);
        if (keyEvents.has(name)) out.add('KEY_EVENT_DUPLICATE', `${path}.event_name`);
        keyEvents.add(name);
      }
      if (!rationaleValid(item.rationale)) out.add('RATIONALE_INVALID', `${path}.rationale`);
      checkStatus(item.status, `${path}.status`, out);
    });
  }
  if (Array.isArray(doc.key_events) && Array.isArray(doc.not_key_events)
    && GA4_DECISION_GRADE_EVENTS.some((event) => !keyEvents.has(event) && !notKey.has(event))) {
    out.add('KEY_EVENT_DECISION_MISSING', '$.not_key_events');
  }
  return out.issues;
}

function dimensionsOf(checklist: Record<string, unknown>): ChecklistDimension[] {
  return (checklist.custom_dimensions as ChecklistDimension[]).map((item) => ({
    parameter_name: item.parameter_name,
    display_name: item.display_name,
    scope: item.scope,
    source_events: [...item.source_events],
  }));
}

// ── Read-only readback plan ─────────────────────────────────────────────────

export interface ReadonlyRequest {
  id: string;
  method: 'GET' | 'POST';
  url: string;
  oauthScope: typeof GA4_READONLY_SCOPE;
  body: Record<string, unknown> | null;
}

export type ReadbackPlan =
  | { ok: true; requests: ReadonlyRequest[] }
  | { ok: false; reason: 'CHECKLIST_INVALID' | 'PROPERTY_ID_INVALID' | 'DATE_INVALID' | 'DATE_RANGE_INVALID' };

/**
 * Admin API list reads for custom dimensions and key events, plus one Data
 * API probe per dimension confirming it carries only contract vocabulary.
 * Absolute dates only: a relative range would make the plan depend on when
 * it runs.
 */
export function buildGa4AdminReadbackPlan(
  checklist: unknown,
  input: { propertyId: string; startDate: string; endDate: string },
): ReadbackPlan {
  if (validateGa4AdminChecklist(checklist).length > 0) return { ok: false, reason: 'CHECKLIST_INVALID' };
  if (typeof input?.propertyId !== 'string' || !PROPERTY_ID_RE.test(input.propertyId)) return { ok: false, reason: 'PROPERTY_ID_INVALID' };
  if (!isCalendarDate(input.startDate) || !isCalendarDate(input.endDate)) return { ok: false, reason: 'DATE_INVALID' };
  if (input.startDate > input.endDate) return { ok: false, reason: 'DATE_RANGE_INVALID' };
  const admin = `https://analyticsadmin.googleapis.com/v1beta/properties/${input.propertyId}`;
  const runReport = `https://analyticsdata.googleapis.com/v1beta/properties/${input.propertyId}:runReport`;
  const requests: ReadonlyRequest[] = [
    { id: 'custom_dimensions', method: 'GET', url: `${admin}/customDimensions?pageSize=200`, oauthScope: GA4_READONLY_SCOPE, body: null },
    { id: 'key_events', method: 'GET', url: `${admin}/keyEvents?pageSize=200`, oauthScope: GA4_READONLY_SCOPE, body: null },
  ];
  for (const dimension of dimensionsOf(checklist as Record<string, unknown>)) {
    requests.push({
      id: `dimension_probe:${dimension.parameter_name}`,
      method: 'POST',
      url: runReport,
      oauthScope: GA4_READONLY_SCOPE,
      body: {
        dateRanges: [{ startDate: input.startDate, endDate: input.endDate }],
        dimensions: [{ name: 'eventName' }, { name: `customEvent:${dimension.parameter_name}` }],
        metrics: [{ name: 'eventCount' }],
        dimensionFilter: {
          filter: { fieldName: 'eventName', inListFilter: { values: dimension.source_events, caseSensitive: true } },
        },
        limit: String(PROBE_ROW_LIMIT),
      },
    });
  }
  return { ok: true, requests };
}

// ── Evaluators ──────────────────────────────────────────────────────────────

export interface ReadbackVerdict {
  verdict: 'MATCH' | 'MISMATCH' | 'INCONCLUSIVE' | 'INVALID_RESPONSE' | 'INVALID_REQUEST' | 'NO_DATA';
  issues: string[];
}

/** One page of an Admin API list: only the list and a string page token, which must be empty. */
function listFrom(response: unknown, key: string): Array<Record<string, unknown>> | ReadbackVerdict {
  const invalid: ReadbackVerdict = { verdict: 'INVALID_RESPONSE', issues: ['RESPONSE_SHAPE'] };
  if (!isPlainRecord(response) || Object.keys(response).some((field) => field !== key && field !== 'nextPageToken')) return invalid;
  const list = hasOwn(response, key) ? response[key] : [];
  if (!Array.isArray(list) || !list.every(isPlainRecord)) return invalid;
  if (hasOwn(response, 'nextPageToken') && typeof response.nextPageToken !== 'string') return invalid;
  if (response.nextPageToken) return { verdict: 'INCONCLUSIVE', issues: ['RESPONSE_PAGINATED'] };
  return list;
}

function verdictOf(issues: string[]): ReadbackVerdict {
  return { verdict: issues.length === 0 ? 'MATCH' : 'MISMATCH', issues };
}

/** The property's custom dimensions must be exactly the checklist's. */
export function evaluateCustomDimensionsReadback(checklist: unknown, response: unknown): ReadbackVerdict {
  if (validateGa4AdminChecklist(checklist).length > 0) return { verdict: 'INVALID_REQUEST', issues: ['CHECKLIST_INVALID'] };
  const list = listFrom(response, 'customDimensions');
  if (!Array.isArray(list)) return list;
  if (!list.every((item) => typeof item.parameterName === 'string' && typeof item.scope === 'string')) {
    return { verdict: 'INVALID_RESPONSE', issues: ['RESPONSE_SHAPE'] };
  }
  const expected = new Map(dimensionsOf(checklist as Record<string, unknown>).map((item) => [item.parameter_name, item]));
  const issues: string[] = [];
  if (list.some((item) => !expected.has(item.parameterName as string))) issues.push('UNEXPECTED_DIMENSION');
  for (const [name, item] of expected) {
    const matches = list.filter((entry) => entry.parameterName === name);
    const actual = matches[0];
    if (!actual) issues.push(`MISSING_DIMENSION:${name}`);
    else if (matches.length > 1) issues.push(`DUPLICATE_DIMENSION:${name}`);
    else if (actual.scope !== item.scope) issues.push(`SCOPE_MISMATCH:${name}`);
    else if (actual.displayName !== item.display_name) issues.push(`DISPLAY_NAME_MISMATCH:${name}`);
  }
  return verdictOf(issues);
}

/** The property's key events must be exactly the checklist's, with its counting methods. */
export function evaluateKeyEventsReadback(checklist: unknown, response: unknown): ReadbackVerdict {
  if (validateGa4AdminChecklist(checklist).length > 0) return { verdict: 'INVALID_REQUEST', issues: ['CHECKLIST_INVALID'] };
  const list = listFrom(response, 'keyEvents');
  if (!Array.isArray(list)) return list;
  if (!list.every((item) => typeof item.eventName === 'string')) return { verdict: 'INVALID_RESPONSE', issues: ['RESPONSE_SHAPE'] };
  const expected = new Map((checklist as { key_events: Array<{ event_name: string; counting_method: string }> }).key_events
    .map((item) => [item.event_name, item.counting_method]));
  const issues: string[] = [];
  if (list.some((item) => !expected.has(item.eventName as string))) issues.push('UNEXPECTED_KEY_EVENT');
  for (const [name, countingMethod] of expected) {
    const matches = list.filter((item) => item.eventName === name);
    const actual = matches[0];
    if (!actual) issues.push(`MISSING_KEY_EVENT:${name}`);
    else if (matches.length > 1) issues.push(`DUPLICATE_KEY_EVENT:${name}`);
    else if (actual.countingMethod !== countingMethod) issues.push(`COUNTING_METHOD_MISMATCH:${name}`);
  }
  return verdictOf(issues);
}

/**
 * A dimension probe matches when the report is complete and well formed (read
 * through src/lib/ga4-run-report.ts) and every reported value of the
 * dimension is inside the contract's vocabulary (or GA4's `(not set)`) and
 * arrives only on the dimension's source events. A value outside the contract
 * is a MISMATCH even in an incomplete report; otherwise a sampled,
 * thresholded, `(other)`-folded or truncated report is INCONCLUSIVE, never
 * MATCH. Values are never echoed.
 */
export function evaluateDimensionProbe(checklist: unknown, parameterName: string, response: unknown): ReadbackVerdict {
  if (validateGa4AdminChecklist(checklist).length > 0) return { verdict: 'INVALID_REQUEST', issues: ['CHECKLIST_INVALID'] };
  const dimension = dimensionsOf(checklist as Record<string, unknown>).find((item) => item.parameter_name === parameterName);
  if (!dimension) return { verdict: 'INVALID_REQUEST', issues: ['DIMENSION_NOT_IN_CHECKLIST'] };
  const read = readGa4RunReport(response, {
    dimensions: ['eventName', `customEvent:${parameterName}`],
    metrics: ['eventCount'],
    limit: PROBE_ROW_LIMIT,
  });
  if (read.ok === false) return { verdict: 'INVALID_RESPONSE', issues: [read.defect] };
  const { rows, gaps } = read.report;
  const issues = new Set<string>();
  for (const { dimensions: [eventName, value], metrics: [count] } of rows) {
    if (!/^\d+$/.test(count)) return { verdict: 'INVALID_RESPONSE', issues: ['METRIC_INVALID'] };
    if (!dimension.source_events.includes(eventName)) issues.add('UNEXPECTED_EVENT');
    else if (value !== '(not set)' && !ga4DimensionValueAllowed(eventName, parameterName, value)) issues.add('UNEXPECTED_VALUE');
  }
  if (issues.size > 0) return verdictOf([...issues]);
  if (gaps.length > 0) return { verdict: 'INCONCLUSIVE', issues: [...gaps] };
  return rows.length === 0 ? { verdict: 'NO_DATA', issues: [] } : verdictOf([]);
}
