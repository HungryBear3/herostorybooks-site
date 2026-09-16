-- HSB Phase B control-plane foundation — schema, roles, enums, bound contract metadata.
--
-- Contract: docs/architecture/hsb-control-plane-v5/hsb-checkout-control-v4.json
--   contract_id            hsb-checkout-control-v4
--   canonical registry SHA 964695a89f250b07ef0bcb0a6b15deee9e33af6036c1a0bc0650d2d5bd014fa0
--   source manifest SHA    de6e3f9d654309a648d1932eacae98c058d9f905121ac9aaf1d576514ddc1015
--   verdict                PASS_FINAL_OFFLINE
--
-- This substrate is default-off and unreachable from application code. It stores no
-- personal data: every identity column holds an opaque provider key or a hex digest.
--
-- Apply order is the file ordinal. Files 0002+ re-enter `SET ROLE hsb_owner` because
-- each is applied in its own session.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- Roles (registries.roles_and_function_grants.roles, exact set of seven)
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY[
    'hsb_owner',
    'hsb_app',
    'hsb_webhook',
    'hsb_worker',
    'hsb_backfill',
    'hsb_stage_admin',
    'hsb_auditor'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_role) THEN
      -- NOLOGIN: these are privilege boundaries reached through SET ROLE or
      -- membership, never credentials. No password is ever set here.
      EXECUTE pg_catalog.format('CREATE ROLE %I NOLOGIN', v_role);
    END IF;
  END LOOP;
END
$do$;

CREATE SCHEMA IF NOT EXISTS hsb_control AUTHORIZATION hsb_owner;

REVOKE ALL ON SCHEMA hsb_control FROM PUBLIC;

SET ROLE hsb_owner;

-- ---------------------------------------------------------------------------
-- Contract domains. Every enum below is the exact registry value list.
-- ---------------------------------------------------------------------------

-- registries.stages.values
CREATE TYPE hsb_control.stage AS ENUM ('off', 'shadow', 'backfill', 'verified', 'activated', 'hold');

-- registries.order_states.values
CREATE TYPE hsb_control.order_state AS ENUM (
  'draft', 'provisioning', 'payable', 'ambiguous', 'blocked', 'abandoned', 'paid', 'reversed'
);

-- registries.exposed_order_classes.values
CREATE TYPE hsb_control.exposed_order_class AS ENUM (
  'marker', 'candidate', 'session', 'payment_intent', 'unknown_provider_outcome',
  'payable', 'ambiguous', 'paid', 'reversed_financial_evidence'
);

-- registries.containment_projection.mapping values. This projection vocabulary
-- is intentionally separate from exposed_order_classes: the two registries have
-- different closed domains in the accepted contract.
CREATE TYPE hsb_control.containment_class AS ENUM (
  'draft', 'ambiguous', 'blocked', 'abandoned', 'paid', 'reversed'
);

-- registries.provider_phases.values
CREATE TYPE hsb_control.provider_phase AS ENUM (
  'absent', 'marker', 'candidate', 'bound', 'settled', 'superseded', 'ambiguous'
);

-- registries.event_processing_states.values
CREATE TYPE hsb_control.event_processing_state AS ENUM (
  'received', 'leased', 'retryable_failure', 'applied', 'quarantined'
);

-- registries.evidence_classes.values
CREATE TYPE hsb_control.evidence_class AS ENUM (
  'S+', 'S0', 'CF', 'FP', 'RP', 'RF', 'DC', 'DU', 'DW', 'DL', 'X'
);

-- registries.event_families.values
CREATE TYPE hsb_control.event_family AS ENUM (
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'charge_or_refund_update',
  'dispute_created',
  'dispute_updated',
  'dispute_won',
  'dispute_lost_or_closed',
  'unsupported_authenticated'
);

-- registries.dispute_states.values
CREATE TYPE hsb_control.dispute_state AS ENUM ('none', 'open', 'won', 'lost', 'conflict');

-- registries.legacy_source_facts.enums.source_era
CREATE TYPE hsb_control.source_era AS ENUM ('parent', 'current');

-- registries.legacy_source_facts.enums.canonical_adoption / legacy_source_classes.canonical_adoption_domain
CREATE TYPE hsb_control.canonical_adoption AS ENUM ('none');

-- registries.backfill_revision_protocol.result_domain
CREATE TYPE hsb_control.revision_result AS ENUM ('append', 'noop', 'reject');

-- registries.legacy_source_facts.enums.reversal (terminal reversal evidence kinds)
CREATE TYPE hsb_control.reversal_kind AS ENUM ('partial', 'full', 'dispute_lost');

-- registries.payment_identity_lock_protocol.identity_order[0]
CREATE TYPE hsb_control.identity_kind AS ENUM ('marker', 'candidate', 'session', 'payment_intent', 'charge');

-- ---------------------------------------------------------------------------
-- Bound contract identity. Immutable singleton; the accepted hashes are the
-- authoritative metadata this foundation is built against.
-- ---------------------------------------------------------------------------
CREATE TABLE hsb_control.contract_binding (
  binding_id                text PRIMARY KEY DEFAULT 'singleton'
                              CHECK (binding_id = 'singleton'),
  contract_id               text NOT NULL CHECK (contract_id = 'hsb-checkout-control-v4'),
  contract_version          integer NOT NULL CHECK (contract_version = 4),
  canonical_registry_sha256 text NOT NULL CHECK (canonical_registry_sha256 ~ '^[0-9a-f]{64}$'),
  source_manifest_sha256    text NOT NULL CHECK (source_manifest_sha256 ~ '^[0-9a-f]{64}$'),
  source_manifest_entries   integer NOT NULL CHECK (source_manifest_entries > 0),
  application_base_commit   text NOT NULL CHECK (application_base_commit ~ '^[0-9a-f]{40}$'),
  application_base_tree     text NOT NULL CHECK (application_base_tree ~ '^[0-9a-f]{40}$'),
  offline_verdict           text NOT NULL CHECK (offline_verdict = 'PASS_FINAL_OFFLINE'),
  provider_qualification    text NOT NULL CHECK (provider_qualification = 'HOLD_UNQUALIFIED'),
  bound_at                  timestamptz NOT NULL DEFAULT pg_catalog.now()
);

COMMENT ON TABLE hsb_control.contract_binding IS
  'Immutable binding to the accepted offline contract. Not runtime authorization.';

INSERT INTO hsb_control.contract_binding (
  contract_id,
  contract_version,
  canonical_registry_sha256,
  source_manifest_sha256,
  source_manifest_entries,
  application_base_commit,
  application_base_tree,
  offline_verdict,
  provider_qualification
) VALUES (
  'hsb-checkout-control-v4',
  4,
  '964695a89f250b07ef0bcb0a6b15deee9e33af6036c1a0bc0650d2d5bd014fa0',
  'de6e3f9d654309a648d1932eacae98c058d9f905121ac9aaf1d576514ddc1015',
  27,
  '957a720a0635e2d875d6ecfb989b6bc5c1092c88',
  '087d10b03ebf5918dc9d767232dc998722ce4fcd',
  'PASS_FINAL_OFFLINE',
  'HOLD_UNQUALIFIED'
);

-- ---------------------------------------------------------------------------
-- Append-only control audit. Every accepted control mutation lands here.
-- ---------------------------------------------------------------------------
CREATE TABLE hsb_control.control_audit (
  audit_seq     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  audit_kind    text NOT NULL CHECK (pg_catalog.length(audit_kind) BETWEEN 1 AND 64),
  subject_key   text NOT NULL CHECK (pg_catalog.length(subject_key) BETWEEN 1 AND 256),
  detail        text NOT NULL DEFAULT '' CHECK (pg_catalog.length(detail) <= 2048),
  actor_label   text NOT NULL CHECK (pg_catalog.length(actor_label) BETWEEN 1 AND 128),
  actor_session name NOT NULL,
  stage_at      hsb_control.stage NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT pg_catalog.now()
);

CREATE INDEX control_audit_kind_seq_idx ON hsb_control.control_audit (audit_kind, audit_seq);
CREATE INDEX control_audit_subject_idx ON hsb_control.control_audit (subject_key, audit_seq);

COMMENT ON TABLE hsb_control.control_audit IS
  'Append-only. No personal data: subject_key holds opaque control keys only.';

-- ---------------------------------------------------------------------------
-- Shared guards
-- ---------------------------------------------------------------------------

-- Blocks UPDATE and DELETE outright. Used for every immutable/append-only table.
CREATE FUNCTION hsb_control.forbid_row_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hsb_control, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION
    USING ERRCODE = 'ZH007',
          MESSAGE = 'HSB_CONTROL_IMMUTABLE_ROW: ' || TG_TABLE_NAME || ' is append-only; '
                    || TG_OP || ' is rejected';
END
$$;

CREATE TRIGGER contract_binding_immutable
  BEFORE UPDATE OR DELETE ON hsb_control.contract_binding
  FOR EACH ROW EXECUTE FUNCTION hsb_control.forbid_row_mutation();

CREATE TRIGGER control_audit_immutable
  BEFORE UPDATE OR DELETE ON hsb_control.control_audit
  FOR EACH ROW EXECUTE FUNCTION hsb_control.forbid_row_mutation();

RESET ROLE;
