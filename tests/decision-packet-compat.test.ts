/**
 * The decision-packet handoff, proven against the pinned packet itself.
 *
 * `exportDecisionPacketGa4Behavior` turns an HSB export into the packet's own
 * `decision_packet.ga4_behavior` v1 document through a mapping that must be
 * the one-to-one semantic counterpart of the HSB vocabulary inside the pinned
 * packet vocabulary. The packet's validator — the exact files of the pinned
 * commit, vendored under tests/fixtures/decision-packet-d64d095/ and bound by
 * SHA-256 — accepts every success output. A value the packet cannot represent
 * refuses the whole export before success: nothing is collapsed into `other`
 * and no row is dropped. Synthetic data only.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildGa4BehaviorExportRequest,
  exportDecisionPacketGa4Behavior,
  generateSyntheticGa4BehaviorExport,
  projectGa4BehaviorReport,
  serializeDecisionPacketDocument,
  validateDecisionPacketMapping,
} from '../src/lib/analytics-decision-export.ts';
import {
  DECISION_PACKET_GA4_BEHAVIOR,
  DECISION_PACKET_PIN,
  validateDecisionPacketGa4Behavior,
} from '../src/lib/decision-packet-contract.ts';

const VENDORED = fileURLToPath(new URL('./fixtures/decision-packet-d64d095/', import.meta.url));
const readText = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');
const mapping = () => JSON.parse(readText('../config/analytics/decision-packet-mapping.v1.json'));
const PACKET_FIXTURE = '../config/analytics/fixtures/decision-packet-ga4-behavior.synthetic.v1.json';
const HSB_FIXTURE = '../config/analytics/fixtures/hsb-ga4-behavior-export.synthetic.v1.json';
const LEAK = /jane|example\.com|2026-09-gifts|birthdays|telegram|video-c|pricing/i;

type HsbExport = ReturnType<typeof generateSyntheticGa4BehaviorExport>;
const representable = (days = 2): HsbExport =>
  generateSyntheticGa4BehaviorExport({ startDate: '2026-09-01', days, profile: 'packet_representable' });
function changed(change: (doc: HsbExport) => void, days = 2): HsbExport {
  const doc = structuredClone(representable(days));
  change(doc);
  return doc;
}

// ── The pinned packet, run for real ─────────────────────────────────────────

// Mirrors the packet CLI's `validate` for an evidence document: strict JSON,
// closed schema, then the evidence rules; reports its manifest or its codes.
const PACKET_VALIDATE = `
import json, sys
sys.path.insert(0, sys.argv[1])
from decision_packet.errors import InputRejected
from decision_packet.evidence import load_document, load_evidence
out = []
for text in json.loads(sys.stdin.buffer.read().decode("utf-8")):
    data = text.encode("utf-8")
    try:
        kind = load_document(data).kind
        m = load_evidence(data).manifest()
        out.append({"accepted": True, "kind": kind, "schema": m["schema"], "business": m["business"],
                    "rows": m["rows_in_file"], "gap_days": m["gap_days"], "quality_flags": m["quality_flags"],
                    "completeness": m["completeness"]})
    except InputRejected as exc:
        out.append({"accepted": False, "issues": [issue.code + "@" + issue.path for issue in exc.issues]})
sys.stdout.write(json.dumps(out))
`;

// Reads the pinned closed keys (from the validator's own MISSING_KEY codes), vocabularies and limits.
const PACKET_CONTRACT = `
import json, sys
sys.path.insert(0, sys.argv[1])
from decision_packet import evidence, jsonio, naming, schemas, vocab
base = {"schema": vocab.SCHEMA_PREFIX + vocab.GA4_BEHAVIOR, "schema_version": vocab.SUPPORTED_SCHEMA_VERSION}
def missing(doc, path):
    return [i.code.split(":", 1)[1] for i in schemas.validate_document(doc)[1] if i.code.startswith("MISSING_KEY:") and i.path == path]
sys.stdout.write(json.dumps({
    "schema": base["schema"], "schemaVersion": base["schema_version"],
    "headerKeys": ["schema", "schema_version"] + missing(dict(base), "$"),
    "rowKeys": missing(dict(base, rows=[{}]), "$.rows[0]"),
    "qualityKeys": missing(dict(base, quality={}), "$.quality"),
    "rangeKeys": missing(dict(base, coverage={}), "$.coverage"),
    "businesses": list(vocab.BUSINESSES), "dataOrigins": list(vocab.DATA_ORIGINS), "timezones": list(vocab.TIMEZONES),
    "sources": list(vocab.SOURCES), "mediums": list(vocab.MEDIUMS),
    "campaignSentinels": list(vocab.CAMPAIGN_SENTINELS), "contentSentinels": list(vocab.CONTENT_SENTINELS),
    "landingPathSentinels": list(vocab.LANDING_PATH_SENTINELS),
    "campaignMonthPattern": naming._YYYYMM.pattern, "campaignObjectives": list(vocab.CAMPAIGN_OBJECTIVES),
    "campaignSlugs": list(vocab.CAMPAIGN_SLUGS), "contentFormats": list(vocab.CONTENT_FORMATS),
    "contentVariants": list(vocab.CONTENT_VARIANTS), "landingPaths": list(vocab.LANDING_PATHS),
    "maxRows": schemas.MAX_ROWS, "maxRanges": schemas.MAX_RANGES, "maxCount": schemas.MAX_COUNT,
    "maxCoverageDays": evidence.MAX_COVERAGE_DAYS, "maxInputBytes": jsonio.MAX_INPUT_BYTES,
    "settleHours": evidence.SETTLE_HOURS[vocab.GA4_BEHAVIOR],
}))
`;

// Like PACKET_VALIDATE, but a crash inside the pinned validator is reported as such instead of failing the harness.
const PACKET_VALIDATE_OR_CRASH = `
import json, sys
sys.path.insert(0, sys.argv[1])
from decision_packet.errors import InputRejected
from decision_packet.evidence import load_evidence
out = []
for text in json.loads(sys.stdin.buffer.read().decode("utf-8")):
    try:
        m = load_evidence(text.encode("utf-8")).manifest()
        out.append({"accepted": True, "completeness": m["completeness"], "unsettled_days": m["unsettled_days"]})
    except InputRejected as exc:
        out.append({"accepted": False, "issues": [issue.code + "@" + issue.path for issue in exc.issues]})
    except Exception as exc:
        out.append({"accepted": False, "crash": type(exc).__name__})
sys.stdout.write(json.dumps(out))
`;

function python(script: string, input: string): unknown {
  // Isolated (-I: no env, no user site, no cwd on the path) and never writes bytecode (-B).
  const env = {} as NodeJS.ProcessEnv; // nothing inherited
  const run = spawnSync('python3', ['-I', '-B', '-c', script, VENDORED], { input, env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(run.status, 0, `pinned packet harness failed: ${run.error?.message ?? ''} ${run.stderr}`);
  return JSON.parse(run.stdout);
}

type PacketVerdict = { accepted: true; completeness: string; rows: number; [key: string]: unknown } | { accepted: false; issues: string[] };
const packetValidate = (texts: string[]) => python(PACKET_VALIDATE, JSON.stringify(texts)) as PacketVerdict[];

test('the vendored packet validator is byte-identical to the pinned commit', () => {
  const pinned: Record<string, string> = {
    'decision_packet/__init__.py': 'bcbb5de1e2ef5451ee9ac259de2ccdd6fae08a186304d9ec4e09535396f45e4a',
    'decision_packet/errors.py': '7f3a71ba1b050c5f98ab869bf68b02d88992d44e06f336f9cbc7af674ea0f10b',
    'decision_packet/evidence.py': 'b29f45bba500aa1e0ed6086dd2bb4ef41f93ef11e29a44b5e04e4bc06309a705',
    'decision_packet/identifiers.py': 'aab0dc55ab110b11f97db0a02b033b434bd119639f9333651d7afee5ccff4f58',
    'decision_packet/jsonio.py': '111a5acf0933637f6afe86407a4752ce902cca628ba71131358809bc46a56128',
    'decision_packet/naming.py': 'f0bdaae63568ecf23ad159aed7cf6370b1e70ea8bc6b8655aad409d2cbf5d684',
    'decision_packet/schemas.py': 'f787163c48b13394425511d51ba60d58ce18974cee2f19b44acad2190d58309a',
    'decision_packet/vocab.py': 'fc82cc4405b4aa818e108c5016f52cc57750eb9e43719a198467a382b1ffa05f',
  };
  assert.equal(DECISION_PACKET_PIN.commit, 'd64d095f361dc10b939289a8787f25dc6d5d925c');
  assert.deepEqual({ ...DECISION_PACKET_PIN.sources }, pinned);
  assert.deepEqual(readdirSync(path.join(VENDORED, 'decision_packet')).sort(), Object.keys(pinned).map((file) => path.basename(file)).sort());
  for (const [file, sha256] of Object.entries(pinned)) {
    assert.equal(createHash('sha256').update(readFileSync(path.join(VENDORED, file))).digest('hex'), sha256, file);
  }
});

test('the TS packet contract is the pinned packet contract, value for value', () => {
  assert.deepEqual(python(PACKET_CONTRACT, ''), JSON.parse(JSON.stringify(DECISION_PACKET_GA4_BEHAVIOR)));
});

// ── Mapping: semantic, one-to-one, closed over both vocabularies ────────────

test('the checked-in mapping is the one-to-one semantic counterpart of the HSB vocabulary', () => {
  assert.deepEqual(validateDecisionPacketMapping(mapping()), []);
});

test('mapping defects — foreign, duplicate, lossy, mislabelled or unrepresentable targets — are rejected at their path', () => {
  const mutate = (change: (doc: Record<string, any>) => void) => { const doc = mapping(); change(doc); return doc; };
  const cases: Array<[string, unknown, string[]]> = [
    ['facebook -> JaneDoe', mutate((d) => { d.value_maps.source.facebook = { to: 'JaneDoe' }; }),
      ['MAPPING_TARGET_NOT_IN_PACKET_VOCABULARY@$.value_maps.source.facebook']],
    ['sessions -> purchase_events', mutate((d) => { d.row_fields.sessions = 'purchase_events'; }),
      ['MAPPING_FIELD_CORRESPONDENCE@$.row_fields.sessions']],
    ['field outside the packet schema', mutate((d) => { d.row_fields.sessions = 'visits'; }),
      ['MAPPING_TARGET_NOT_IN_PACKET_SCHEMA@$.row_fields.sessions']],
    ['header field swap', mutate((d) => { d.header_fields.coverage = 'attested_complete_ranges'; }),
      ['MAPPING_FIELD_CORRESPONDENCE@$.header_fields.coverage']],
    ['unknown content target', mutate((d) => { d.value_maps.content['video-a'] = { to: 'vid_z' }; }),
      ['MAPPING_TARGET_NOT_IN_PACKET_VOCABULARY@$.value_maps.content.video-a']],
    ['duplicate content target', mutate((d) => { d.value_maps.content['video-b'] = { to: 'vid_a' }; }),
      ['MAPPING_TARGET_DUPLICATE@$.value_maps.content.video-b']],
    ['swapped sources', mutate((d) => { d.value_maps.source.facebook = { to: 'instagram' }; d.value_maps.source.instagram = { to: 'facebook' }; }),
      ['MAPPING_SEMANTIC_MISMATCH@$.value_maps.source.facebook', 'MAPPING_SEMANTIC_MISMATCH@$.value_maps.source.instagram']],
    ['video variant mislabelled as image', mutate((d) => { d.value_maps.content['video-a'] = { to: 'img_b2' }; }),
      ['MAPPING_SEMANTIC_MISMATCH@$.value_maps.content.video-a']],
    ['sentinel remapped', mutate((d) => { d.value_maps.campaign.none = { to: 'not_set' }; }),
      ['MAPPING_SEMANTIC_MISMATCH@$.value_maps.campaign.none']],
    ['two sentinels on one target', mutate((d) => { d.value_maps.source.other = { to: 'not_set' }; }),
      ['MAPPING_TARGET_DUPLICATE@$.value_maps.source.other']],
    ['lossy other campaign', mutate((d) => { d.value_maps.campaign.governed = { to: 'other' }; }),
      ['MAPPING_LOSSY@$.value_maps.campaign.governed', 'MAPPING_EXTENSION_UNUSED@$.extensions_required']],
    ['lossy fallback entry', mutate((d) => { d.value_maps.campaign.governed = { blocked: 'PACKET_CAMPAIGN_VOCABULARY_MISSING', fallback: 'other' }; }),
      ['MAPPING_ENTRY_INVALID@$.value_maps.campaign.governed', 'MAPPING_EXTENSION_UNUSED@$.extensions_required']],
    ['lossy source', mutate((d) => { d.value_maps.source.telegram = { to: 'referral_other' }; }),
      ['MAPPING_LOSSY@$.value_maps.source.telegram', 'MAPPING_EXTENSION_UNUSED@$.extensions_required']],
    ['lossy landing route', mutate((d) => { d.value_maps.landing_path['/gifts'] = { to: 'other' }; }),
      ['MAPPING_LOSSY@$.value_maps.landing_path./gifts']],
    ['unmappable approved route', mutate((d) => { d.value_maps.landing_path['/gifts'] = { to: '/gifts' }; }),
      ['MAPPING_TARGET_NOT_IN_PACKET_VOCABULARY@$.value_maps.landing_path./gifts']],
    ['approved route mislabelled as a packet route', mutate((d) => { d.value_maps.landing_path['/gifts'] = { to: '/fall-books' }; }),
      ['MAPPING_NO_PACKET_COUNTERPART@$.value_maps.landing_path./gifts']],
    ['unmappable approved campaign', mutate((d) => { d.value_maps.campaign.governed = { to: 'hsb_202609_acq_fallbooks' }; }),
      ['MAPPING_NO_PACKET_COUNTERPART@$.value_maps.campaign.governed', 'MAPPING_EXTENSION_UNUSED@$.extensions_required']],
    ['representable value blocked', mutate((d) => { d.value_maps.source.facebook = { blocked: 'PACKET_SOURCE_VOCABULARY_MISSING' }; }),
      ['MAPPING_BLOCK_UNNECESSARY@$.value_maps.source.facebook']],
    ['undeclared extension', mutate((d) => { d.value_maps.content['video-c'] = { blocked: 'PACKET_NEW_GAP' }; }),
      ['MAPPING_EXTENSION_UNDECLARED@$.value_maps.content.video-c']],
    ['invalid mapping schema', mutate((d) => { d.schema = 'hsb.decision_packet_mapping.v2'; }), ['SCHEMA_INVALID@$.schema']],
    ['invalid target schema', mutate((d) => { d.target.schema = 'decision_packet.ga4_behaviour'; }), ['MAPPING_TARGET_SCHEMA@$.target.schema']],
    ['unpinned packet commit', mutate((d) => { d.target.reference_commit = 'd64d095'; }), ['MAPPING_TARGET_SCHEMA@$.target.reference_commit']],
    ['invalid source schema', mutate((d) => { d.source.schema = 'decision_packet.ga4_behavior'; }), ['MAPPING_SOURCE_SCHEMA@$.source']],
    ['free-text key', mutate((d) => { d.notes = 'ask Jane'; }), ['FORBIDDEN_KEY@$']],
  ];
  for (const [label, doc, expected] of cases) {
    const issues = validateDecisionPacketMapping(doc);
    assert.deepEqual(issues, expected, label);
    assert.doesNotMatch(JSON.stringify(issues), /jane/i, label);
  }
});

// ── The compatibility export ────────────────────────────────────────────────

test('the representable synthetic profile is deterministic and literal', () => {
  const doc = representable(1);
  const row = (source: string, medium: string, campaign: string, content: string, landing_path: string, counts: number[]) =>
    ({ date: '2026-09-01', source, medium, campaign, content, landing_path, sessions: counts[0], checkout_starts: counts[1], purchase_events: counts[2] });
  assert.deepEqual(doc.rows, [
    row('direct', 'none', 'none', 'not_set', '/', [30, 2, 1]),
    row('google', 'organic', 'none', 'not_set', '/', [22, 2, 1]),
    row('facebook', 'social', 'not_set', 'video-a', '/', [14, 1, 0]),
    row('newsletter', 'email', 'not_set', 'text-b', 'other', [9, 1, 0]),
  ]);
  assert.equal(doc.data_origin, 'synthetic_fixture');
});

test('the compat export is the exact packet document, and the checked-in fixture is that output byte for byte', () => {
  const result = exportDecisionPacketGa4Behavior(representable(1), mapping());
  assert.deepEqual(result, {
    ok: true,
    document: {
      schema: 'decision_packet.ga4_behavior',
      schema_version: 1,
      data_origin: 'synthetic_fixture',
      business: 'hsb',
      timezone: 'America/Chicago',
      generated_at: '2026-09-04T12:00:00Z',
      coverage: { start: '2026-09-01', end: '2026-09-01' },
      attested_complete_ranges: [{ start: '2026-09-01', end: '2026-09-01' }],
      quality: { sampled: false, thresholded: false, other_row: false },
      rows: [
        { date: '2026-09-01', source: 'direct', medium: 'none', campaign: 'none', content: 'not_set', landing_path: '/', sessions: 30, checkout_starts: 2, purchase_events: 1 },
        { date: '2026-09-01', source: 'google', medium: 'organic', campaign: 'none', content: 'not_set', landing_path: '/', sessions: 22, checkout_starts: 2, purchase_events: 1 },
        { date: '2026-09-01', source: 'facebook', medium: 'social', campaign: 'not_set', content: 'vid_a', landing_path: '/', sessions: 14, checkout_starts: 1, purchase_events: 0 },
        { date: '2026-09-01', source: 'newsletter', medium: 'email', campaign: 'not_set', content: 'txt_b', landing_path: 'other', sessions: 9, checkout_starts: 1, purchase_events: 0 },
      ],
    },
  });
  const fixture = exportDecisionPacketGa4Behavior(representable(7), mapping());
  assert.equal(fixture.ok, true);
  if (fixture.ok) assert.equal(readText(PACKET_FIXTURE), serializeDecisionPacketDocument(fixture.document));
});

test('every checked-in synthetic success fixture is accepted by the pinned packet validator', () => {
  const text = readText(PACKET_FIXTURE);
  const [verdict] = packetValidate([text]);
  assert.deepEqual(verdict, {
    accepted: true, kind: 'ga4_behavior', schema: 'decision_packet.ga4_behavior', business: 'hsb',
    rows: 28, gap_days: 0, quality_flags: [], completeness: 'complete',
  });
  assert.deepEqual(validateDecisionPacketGa4Behavior(JSON.parse(text)), []);
});

test('identity survives the export: every packet row maps back to exactly its HSB row', () => {
  const source = representable(7);
  const result = exportDecisionPacketGa4Behavior(source, mapping());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const inverse: Record<string, Record<string, string>> = {};
  for (const [field, entries] of Object.entries(mapping().value_maps as Record<string, Record<string, { to?: string }>>)) {
    inverse[field] = {};
    for (const [value, entry] of Object.entries(entries)) {
      if (entry.to === undefined) continue;
      assert.equal(Object.hasOwn(inverse[field], entry.to), false, `${field}: two HSB values share ${entry.to}`);
      inverse[field][entry.to] = value;
    }
  }
  const back = result.document.rows.map((row) => ({
    ...row,
    source: inverse.source[row.source],
    medium: inverse.medium[row.medium],
    campaign: inverse.campaign[row.campaign],
    content: inverse.content[row.content],
    landing_path: inverse.landing_path[row.landing_path],
  }));
  assert.deepEqual(back, source.rows);
});

test('the governed HSB fixture is refused before success, naming each packet gap without a value', () => {
  const governed = generateSyntheticGa4BehaviorExport({ startDate: '2026-09-01', days: 1 });
  assert.deepEqual(exportDecisionPacketGa4Behavior(governed, mapping()), {
    ok: false,
    issues: [
      'PACKET_CAMPAIGN_VOCABULARY_MISSING@$.rows[1].campaign',
      'PACKET_LANDING_PATH_VOCABULARY_MISSING@$.rows[1].landing_path',
      'PACKET_CAMPAIGN_VOCABULARY_MISSING@$.rows[2].campaign',
    ],
  });
  const checkedIn = exportDecisionPacketGa4Behavior(JSON.parse(readText(HSB_FIXTURE)), mapping());
  assert.equal(checkedIn.ok, false);
  assert.doesNotMatch(JSON.stringify(checkedIn), LEAK);
});

test('unrepresentable values and packet evidence violations fail before export success', () => {
  const invalidMapping = mapping();
  invalidMapping.value_maps.campaign.governed = { to: 'other' };
  const cases: Array<[string, unknown, unknown, string[]]> = [
    ['telegram source', changed((d) => { d.rows[2].source = 'telegram'; }), mapping(), ['PACKET_SOURCE_VOCABULARY_MISSING@$.rows[2].source']],
    ['content variant c', changed((d) => { d.rows[2].content = 'video-c'; }), mapping(), ['PACKET_CONTENT_VARIANT_MISSING@$.rows[2].content']],
    ['approved route', changed((d) => { d.rows[0].landing_path = '/pricing'; }), mapping(), ['PACKET_LANDING_PATH_VOCABULARY_MISSING@$.rows[0].landing_path']],
    ['governed campaign', changed((d) => { d.rows[2].campaign = '2026-09-gifts'; }), mapping(), ['PACKET_CAMPAIGN_VOCABULARY_MISSING@$.rows[2].campaign']],
    ['checkout starts above sessions', changed((d) => { d.rows[3].checkout_starts = 99; }), mapping(), ['METRIC_INVARIANT@$.rows[3]']],
    ['purchases above sessions', changed((d) => { d.rows[3].purchase_events = 99; }), mapping(), ['METRIC_INVARIANT@$.rows[3]']],
    ['overlapping attested ranges', changed((d) => {
      d.attested_complete_ranges = [{ start: '2026-09-01', end: '2026-09-02' }, { start: '2026-09-02', end: '2026-09-02' }];
    }), mapping(), ['ATTESTED_RANGE_INVALID@$.attested_complete_ranges[1]']],
    ['coverage longer than the packet window', changed((d) => {
      d.coverage = { start: '2025-07-01', end: '2026-09-02' };
      d.attested_complete_ranges = [];
    }), mapping(), ['COVERAGE_TOO_LONG@$.coverage']],
    ['invalid HSB export', changed((d) => { d.rows[0].campaign = 'jane@example.com'; }), mapping(), ['FORBIDDEN_VALUE:EMAIL@$.rows[0].campaign']],
    ['lossy mapping', representable(), invalidMapping, ['MAPPING_INVALID@$']],
    ['not a mapping', representable(), null, ['MAPPING_INVALID@$']],
  ];
  for (const [label, doc, map, issues] of cases) {
    const result = exportDecisionPacketGa4Behavior(doc, map);
    assert.deepEqual(result, { ok: false, issues }, label);
    assert.doesNotMatch(JSON.stringify(result), LEAK, label);
  }
});

test('the packet itself shows why: raw HSB values are rejected, but an `other` collapse would pass silently', () => {
  const governed = generateSyntheticGa4BehaviorExport({ startDate: '2026-09-01', days: 1 });
  const verbatim = { ...governed, schema: 'decision_packet.ga4_behavior' };
  const collapsed = {
    ...verbatim,
    rows: governed.rows.map((row) => ({
      ...row,
      campaign: ['none', 'not_set', 'other'].includes(row.campaign) ? row.campaign : 'other',
      content: row.content === 'not_set' ? 'not_set' : 'other',
      landing_path: row.landing_path === '/' ? '/' : 'other',
    })),
  };
  const [raw, lossy] = packetValidate([JSON.stringify(verbatim), JSON.stringify(collapsed)]);
  assert.equal(raw.accepted, false);
  assert.equal(lossy.accepted, true, 'the packet cannot detect a lossy collapse, so the export must refuse it');
  assert.equal(exportDecisionPacketGa4Behavior(governed, mapping()).ok, false);
});

test('a truncated report never becomes an export; a GA4-flagged one reaches the packet only as incomplete', () => {
  const report = (metadata: Record<string, unknown>, rowCount: number) => ({
    dimensionHeaders: ['date', 'sessionSource', 'sessionMedium', 'sessionCampaignName', 'sessionManualAdContent', 'landingPage'].map((name) => ({ name })),
    metricHeaders: ['sessions', 'checkouts', 'ecommercePurchases'].map((name) => ({ name, type: 'TYPE_INTEGER' })),
    rows: [{
      dimensionValues: ['20260901', '(direct)', '(none)', '(direct)', '(not set)', '/'].map((value) => ({ value })),
      metricValues: ['10', '1', '0'].map((value) => ({ value })),
    }],
    rowCount,
    metadata: { currencyCode: 'USD', timeZone: 'America/Chicago', ...metadata },
  });
  const header = {
    dataOrigin: 'synthetic_fixture',
    generatedAt: '2026-09-04T12:00:00Z',
    coverage: { start: '2026-09-01', end: '2026-09-01' },
    attestedCompleteRanges: [{ start: '2026-09-01', end: '2026-09-01' }],
  };
  const built = buildGa4BehaviorExportRequest({ propertyId: '123456789', startDate: '2026-09-01', endDate: '2026-09-01' });
  assert.ok(built.ok);
  const request = built.request;
  assert.deepEqual(projectGa4BehaviorReport(request, report({}, 250_001), header), { ok: false, issues: ['REPORT_TRUNCATED@$.rowCount'] });

  const clean = projectGa4BehaviorReport(request, report({}, 1), header);
  const flagged = projectGa4BehaviorReport(request, report({ dataLossFromOtherRow: true }, 1), header);
  const emptyForReason = projectGa4BehaviorReport(request, { ...report({ emptyReason: 'x' }, 0), rows: [] }, header);
  assert.ok(emptyForReason.ok && emptyForReason.completeness === 'INSUFFICIENT_EVIDENCE');
  const emptyPacket = exportDecisionPacketGa4Behavior(emptyForReason.ok && emptyForReason.document, mapping());
  assert.ok(emptyPacket.ok);
  const [emptyVerdict] = packetValidate([serializeDecisionPacketDocument(emptyPacket.document)]);
  assert.deepEqual(emptyVerdict.accepted && [emptyVerdict.completeness, emptyVerdict.gap_days], ['empty', 1], 'an emptyReason export reaches the packet with no attested day');
  assert.ok(clean.ok && flagged.ok);
  const [cleanPacket, flaggedPacket] = [clean.document, flagged.document].map((doc) => exportDecisionPacketGa4Behavior(doc, mapping()));
  assert.ok(cleanPacket.ok && flaggedPacket.ok);
  const [complete, incomplete] = packetValidate([cleanPacket.document, flaggedPacket.document].map(serializeDecisionPacketDocument));
  assert.equal(complete.accepted && complete.completeness, 'complete');
  assert.deepEqual(incomplete.accepted && [incomplete.completeness, incomplete.gap_days, incomplete.quality_flags], ['partial', 1, ['GA4_OTHER_ROW']]);
});

test('the TS contract gate never accepts a document the pinned packet rejects', () => {
  const good = JSON.parse(readText(PACKET_FIXTURE));
  const mutate = (change: (doc: Record<string, any>) => void) => { const doc = structuredClone(good); change(doc); return doc; };
  const docs: Array<[string, Record<string, unknown>]> = [
    ['fixture', good],
    ['packet-valid campaign', mutate((d) => { d.rows[0].campaign = 'hsb_202609_acq_fallbooks'; })],
    ['packet-valid content', mutate((d) => { d.rows[0].content = 'eml_b2'; })],
    ['unknown source', mutate((d) => { d.rows[0].source = 'twitter'; })],
    ['campaign slug outside the packet', mutate((d) => { d.rows[0].campaign = 'hsb_202609_acq_gifts'; })],
    ['campaign of the other business', mutate((d) => { d.rows[0].campaign = 'ot_202609_acq_fallbooks'; })],
    ['content variant outside the packet', mutate((d) => { d.rows[0].content = 'vid_c'; })],
    ['landing route outside the packet', mutate((d) => { d.rows[0].landing_path = '/gifts'; })],
    ['checkout starts above sessions', mutate((d) => { d.rows[0].checkout_starts = d.rows[0].sessions + 1; })],
    ['row outside coverage', mutate((d) => { d.rows[0].date = '2026-08-31'; })],
    ['generated before the last day starts', mutate((d) => { d.generated_at = '2026-09-07T04:00:00Z'; })],
    ['overlapping attested ranges', mutate((d) => { d.attested_complete_ranges = [{ start: '2026-09-01', end: '2026-09-03' }, { start: '2026-09-03', end: '2026-09-07' }]; })],
    ['conflicting duplicate row', mutate((d) => { d.rows[1] = { ...d.rows[0], sessions: d.rows[0].sessions + 1 }; })],
    ['undeclared key', mutate((d) => { d.rows[0].client_id = '123.456'; })],
    ['fractional count', mutate((d) => { d.rows[0].sessions = 1.5; })],
    ['unsupported schema version', mutate((d) => { d.schema_version = 2; })],
    ['year-zero coverage start', mutate((d) => { d.coverage = { start: '0000-12-31', end: '0001-01-01' }; d.attested_complete_ranges = []; d.rows = []; d.generated_at = '0001-01-05T00:00:00Z'; })],
    ['year-zero row date', mutate((d) => { d.coverage = { start: '0000-12-31', end: '0001-01-01' }; d.attested_complete_ranges = []; d.generated_at = '0001-01-05T00:00:00Z'; d.rows = [{ ...d.rows[0], date: '0000-12-31' }]; })],
    ['earliest packet dates', mutate((d) => { d.coverage = { start: '0001-01-01', end: '0001-01-02' }; d.attested_complete_ranges = [{ start: '0001-01-01', end: '0001-01-02' }]; d.generated_at = '0001-01-05T00:00:00Z'; d.rows = [{ ...d.rows[0], date: '0001-01-01' }]; })],
    ['latest packet dates', mutate((d) => { d.coverage = { start: '9999-12-26', end: '9999-12-27' }; d.attested_complete_ranges = [{ start: '9999-12-26', end: '9999-12-27' }]; d.generated_at = '9999-12-31T00:00:00Z'; d.rows = [{ ...d.rows[0], date: '9999-12-27' }]; })],
  ];
  // Deliberately stricter than the packet: generation inside the last covered day (the packet accepts it as unsettled).
  const stricter = mutate((d) => { d.generated_at = '2026-09-07T12:00:00Z'; });
  const verdicts = packetValidate([...docs.map(([, doc]) => JSON.stringify(doc)), JSON.stringify(stricter)]);
  docs.forEach(([label, doc], index) => {
    const tsAccepts = validateDecisionPacketGa4Behavior(doc).length === 0;
    if (tsAccepts) assert.equal(verdicts[index].accepted, true, `${label}: TS accepted what the packet rejects`);
  });
  const accepted = new Set(['fixture', 'packet-valid campaign', 'packet-valid content', 'earliest packet dates', 'latest packet dates']);
  assert.deepEqual(docs.map(([label, doc]) => [label, validateDecisionPacketGa4Behavior(doc).length === 0]), docs.map(([label]) => [label, accepted.has(label)]));
  assert.deepEqual(verdicts.slice(0, docs.length).map((verdict) => verdict.accepted), docs.map(([label]) => accepted.has(label)));
  assert.deepEqual([validateDecisionPacketGa4Behavior(stricter), verdicts[docs.length].accepted],
    [['COVERAGE_AFTER_GENERATED_AT@$.coverage.end'], true]);
});

test('the upper calendar boundary: whatever the TS gate accepts, the pinned packet accepts without crashing', () => {
  // The packet settles an attested day 48 h after the next day starts in the
  // declared zone; past 9999-12-28 that arithmetic overflows Python's datetime
  // and the validator crashes instead of rejecting. HSB must therefore refuse
  // such an attestation before any packet document exists.
  const good = JSON.parse(readText(PACKET_FIXTURE));
  const days = ['9999-12-24', '9999-12-25', '9999-12-26', '9999-12-27', '9999-12-28', '9999-12-29', '9999-12-30', '9999-12-31'];
  const docs: Array<[string, Record<string, unknown>]> = [];
  for (const timezone of DECISION_PACKET_GA4_BEHAVIOR.timezones) {
    for (const end of days) {
      for (const attested of [true, false]) {
        const doc = structuredClone(good);
        doc.timezone = timezone;
        doc.coverage = { start: '9999-12-24', end };
        doc.generated_at = '9999-12-31T23:59:59Z';
        doc.attested_complete_ranges = attested ? [{ start: '9999-12-24', end }] : [];
        doc.rows = [{ ...doc.rows[0], date: end }];
        docs.push([`${timezone} end=${end} attested=${attested}`, doc]);
      }
    }
  }
  const run = spawnSync('python3', ['-I', '-B', '-c', PACKET_VALIDATE_OR_CRASH, VENDORED], { input: JSON.stringify(docs.map(([, doc]) => JSON.stringify(doc))), env: {} as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 120_000 });
  assert.equal(run.status, 0, run.stderr);
  const verdicts = JSON.parse(run.stdout) as Array<{ accepted: boolean; completeness?: string; crash?: string; issues?: string[] }>;
  const gaps: string[] = [];
  const crashes: string[] = [];
  docs.forEach(([label, doc], index) => {
    const tsIssues = validateDecisionPacketGa4Behavior(doc);
    const verdict = verdicts[index];
    if (verdict.crash) crashes.push(label);
    if (tsIssues.length === 0 && !verdict.accepted) gaps.push(`${label}: packet=${verdict.crash ?? verdict.issues?.join('|')}`);
    if (label.endsWith('end=9999-12-28 attested=true')) {
      assert.deepEqual(tsIssues, [], label);
      assert.deepEqual([verdict.accepted, verdict.completeness], [true, 'complete'], label);
    }
    if (/end=9999-12-(29|30) attested=true/.test(label)) {
      assert.deepEqual(tsIssues, ['ATTESTED_RANGE_UNSETTLEABLE@$.attested_complete_ranges[0]'], label);
    }
  });
  assert.deepEqual(gaps, [], 'the TS gate accepted a document the pinned packet rejects or crashes on');
  // The crash is the packet's, classified separately: it only ever happens on documents the TS gate refuses.
  assert.ok(crashes.length > 0 && crashes.every((label) => /end=9999-12-(29|30|31) attested=true/.test(label)), crashes.join(', '));
});

// ── The executable handoff ──────────────────────────────────────────────────

const CLI = ['--experimental-strip-types', 'scripts/analytics-governance.ts'];
const runCli = (args: string[]) => spawnSync(process.execPath, [...CLI, ...args], { encoding: 'utf8', env: { NODE_ENV: 'test' } });

test('the governance CLI runs the compat export deterministically and fails closed without echoing values', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hsb-packet-export-'));
  try {
    const input = path.join(dir, 'hsb-export.json');
    writeFileSync(input, JSON.stringify(representable(7)));
    const exported = runCli(['packet-export', input]);
    assert.equal(exported.status, 0, exported.stderr);
    assert.equal(exported.stdout, readText(PACKET_FIXTURE));
    assert.equal(runCli(['packet-export', input]).stdout, exported.stdout);

    const fixture = runCli(['packet-fixture']);
    assert.equal(fixture.status, 0);
    assert.equal(fixture.stdout, readText(PACKET_FIXTURE));

    const refused = runCli(['packet-export', fileURLToPath(new URL(HSB_FIXTURE, import.meta.url))]);
    assert.equal(refused.status, 3);
    assert.match(refused.stdout, /^REJECTED decision_packet_export PACKET_CAMPAIGN_VOCABULARY_MISSING@\$\.rows\[1\]\.campaign$/m);
    assert.doesNotMatch(refused.stdout + refused.stderr, LEAK);

    const hostile = path.join(dir, 'hostile.json');
    writeFileSync(hostile, JSON.stringify(changed((d) => { d.rows[0].campaign = 'jane@example.com'; })));
    const rejected = runCli(['packet-export', hostile]);
    assert.equal(rejected.status, 3);
    assert.doesNotMatch(rejected.stdout + rejected.stderr, /jane/);

    const malformed = path.join(dir, 'malformed.json');
    writeFileSync(malformed, '{"schema": jane@example.com');
    const unparsed = runCli(['packet-export', malformed]);
    assert.equal(unparsed.status, 3);
    assert.doesNotMatch(unparsed.stdout + unparsed.stderr, /jane/);

    assert.equal(runCli(['packet-export']).status, 2);
    assert.equal(runCli(['packet-export', path.join(dir, 'absent.json')]).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
