-- HSB Phase B control-plane foundation — inert durable substrate.
--
-- Every table here is real, constrained, indexed, and closed over its contract
-- state machine. None of it is wired to the application: no route, job, cron, or
-- library reaches any of these functions in this slice, and every mutation that
-- would create or advance runtime order/provider/payment state fails closed while
-- the stage is `off`.
--
-- Identity columns hold opaque provider or control keys and hex digests only.

\set ON_ERROR_STOP on

SET ROLE hsb_owner;

-- ===========================================================================
-- Order control records and monotonic states
-- ===========================================================================

-- registries.order_edges_with_guards, all 26 edges, all_unlisted_rejected: true
CREATE TABLE hsb_control.order_state_edge (
  from_state hsb_control.order_state NOT NULL,
  to_state   hsb_control.order_state NOT NULL,
  guard      text NOT NULL REFERENCES hsb_control.transition_guard (guard),
  PRIMARY KEY (from_state, to_state)
);

INSERT INTO hsb_control.order_state_edge (from_state, to_state, guard) VALUES
  ('draft', 'provisioning', 'tx3_first_marker'),
  ('draft', 'abandoned', 'never_entered_provider'),
  ('draft', 'blocked', 'audited_hold'),
  ('provisioning', 'payable', 'tx5_exact_bind'),
  ('provisioning', 'paid', 'tx7_exact_settlement'),
  ('provisioning', 'ambiguous', 'conflict_or_failed_pi'),
  ('provisioning', 'abandoned', 'tx13_all_generations_charge_free'),
  ('provisioning', 'blocked', 'audited_hold'),
  ('payable', 'paid', 'tx7_exact_settlement'),
  ('payable', 'provisioning', 'tx6_terminal_charge_free_rotate_fence'),
  ('payable', 'ambiguous', 'conflict'),
  ('payable', 'abandoned', 'tx13_all_generations_charge_free'),
  ('payable', 'blocked', 'audited_hold'),
  ('ambiguous', 'paid', 'tx7_exact_settlement'),
  ('ambiguous', 'provisioning', 'tx6_reconciled_rotate_fence'),
  ('ambiguous', 'abandoned', 'tx13_all_generations_charge_free'),
  ('ambiguous', 'blocked', 'audited_hold'),
  ('blocked', 'draft', 'audited_unblock_from_draft'),
  ('blocked', 'provisioning', 'audited_unblock_from_provisioning'),
  ('blocked', 'payable', 'audited_unblock_from_payable'),
  ('blocked', 'ambiguous', 'audited_unblock_from_ambiguous'),
  ('blocked', 'paid', 'tx7_exact_settlement_preserve_holds'),
  ('blocked', 'abandoned', 'tx13_plus_audited_unblock'),
  ('paid', 'reversed', 'full_refund_or_lost_dispute'),
  ('paid', 'paid', 'compatible_or_partial_or_dispute'),
  ('reversed', 'reversed', 'compatible_later_evidence');

CREATE TRIGGER order_state_edge_immutable
  BEFORE UPDATE OR DELETE ON hsb_control.order_state_edge
  FOR EACH ROW EXECUTE FUNCTION hsb_control.forbid_row_mutation();

-- registries.containment_projection.mapping
CREATE TABLE hsb_control.order_containment (
  order_state   hsb_control.order_state PRIMARY KEY,
  exposed_class hsb_control.containment_class NOT NULL
);

INSERT INTO hsb_control.order_containment (order_state, exposed_class) VALUES
  ('draft', 'draft'),
  ('provisioning', 'ambiguous'),
  ('payable', 'ambiguous'),
  ('ambiguous', 'ambiguous'),
  ('blocked', 'blocked'),
  ('abandoned', 'abandoned'),
  ('paid', 'paid'),
  ('reversed', 'reversed');

CREATE TRIGGER order_containment_immutable
  BEFORE UPDATE OR DELETE ON hsb_control.order_containment
  FOR EACH ROW EXECUTE FUNCTION hsb_control.forbid_row_mutation();

CREATE TABLE hsb_control.order_control (
  order_key     text PRIMARY KEY CHECK (order_key ~ '^[A-Za-z0-9_:-]{1,128}$'),
  order_state   hsb_control.order_state NOT NULL,
  -- registries.containment_projection: holds survive independently of the state.
  risk_hold        boolean NOT NULL DEFAULT false,
  fulfillment_hold boolean NOT NULL DEFAULT false,
  blocked_from     hsb_control.order_state,
  mutation_seq  bigint NOT NULL DEFAULT 0 CHECK (mutation_seq >= 0),
  owner_token   uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at    timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CHECK ((order_state = 'blocked') = (blocked_from IS NOT NULL))
);

CREATE INDEX order_control_state_idx ON hsb_control.order_control (order_state);

COMMENT ON TABLE hsb_control.order_control IS
  'Authoritative order control record. Opaque order keys only; never personal data.';

-- registries.containment_projection: the exposed class is derived, never stored twice.
CREATE VIEW hsb_control.order_control_exposed AS
  SELECT o.order_key,
         o.order_state,
         c.exposed_class,
         o.risk_hold,
         o.fulfillment_hold,
         o.blocked_from,
         o.mutation_seq
    FROM hsb_control.order_control o
    JOIN hsb_control.order_containment c ON c.order_state = o.order_state;

CREATE FUNCTION hsb_control.enforce_order_control_monotonicity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hsb_control, pg_temp
AS $$
BEGIN
  IF current_setting('hsb_control.order_mutation_active', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH004',
            MESSAGE = 'HSB_CONTROL_ORDER_DIRECT_DML: order_control moves only through '
                      || 'hsb_control.advance_order_state';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH004',
            MESSAGE = 'HSB_CONTROL_IMMUTABLE_ROW: order_control records are never deleted';
  END IF;

  IF NEW.order_key IS DISTINCT FROM OLD.order_key THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH004', MESSAGE = 'HSB_CONTROL_ORDER_KEY_IMMUTABLE';
  END IF;

  IF NEW.mutation_seq <> OLD.mutation_seq + 1 THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH004',
            MESSAGE = 'HSB_CONTROL_ORDER_SEQ_NOT_MONOTONIC: mutation_seq must advance by exactly one';
  END IF;

  IF NEW.order_state IS DISTINCT FROM OLD.order_state
     AND NOT EXISTS (
       SELECT 1 FROM hsb_control.order_state_edge e
        WHERE e.from_state = OLD.order_state AND e.to_state = NEW.order_state
     ) THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH004',
            MESSAGE = 'HSB_CONTROL_ORDER_EDGE_REJECTED: ' || OLD.order_state::text || ' -> '
                      || NEW.order_state::text || ' is not a contract edge';
  END IF;

  -- registries.containment_projection.preserves_independent_holds
  IF OLD.risk_hold AND NOT NEW.risk_hold THEN
    RAISE EXCEPTION USING ERRCODE = 'ZH004', MESSAGE = 'HSB_CONTROL_RISK_HOLD_PRESERVED';
  END IF;
  IF OLD.fulfillment_hold AND NOT NEW.fulfillment_hold THEN
    RAISE EXCEPTION USING ERRCODE = 'ZH004', MESSAGE = 'HSB_CONTROL_FULFILLMENT_HOLD_PRESERVED';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER order_control_monotonic
  BEFORE UPDATE OR DELETE ON hsb_control.order_control
  FOR EACH ROW EXECUTE FUNCTION hsb_control.enforce_order_control_monotonicity();

CREATE FUNCTION hsb_control.open_order_control(p_order_key text)
RETURNS hsb_control.order_state
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hsb_control, pg_temp
AS $$
BEGIN
  PERFORM hsb_control.assert_runtime_mutation_allowed('open_order_control');

  INSERT INTO hsb_control.order_control (order_key, order_state)
  VALUES (p_order_key, 'draft');

  INSERT INTO hsb_control.control_audit (audit_kind, subject_key, detail, actor_label, actor_session, stage_at)
  VALUES ('order_opened', p_order_key, 'draft', 'app', session_user, hsb_control.current_stage());

  RETURN 'draft';
END
$$;

CREATE FUNCTION hsb_control.advance_order_state(
  p_order_key text,
  p_to_state  hsb_control.order_state,
  p_guard     text
)
RETURNS hsb_control.order_state
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hsb_control, pg_temp
AS $$
DECLARE
  v_from hsb_control.order_state;
  v_seq  bigint;
  v_edge_guard text;
BEGIN
  PERFORM hsb_control.assert_runtime_mutation_allowed('advance_order_state');

  SELECT o.order_state, o.mutation_seq INTO v_from, v_seq
    FROM hsb_control.order_control o
   WHERE o.order_key = p_order_key
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'ZH008', MESSAGE = 'HSB_CONTROL_ORDER_UNKNOWN';
  END IF;

  SELECT e.guard INTO v_edge_guard
    FROM hsb_control.order_state_edge e
   WHERE e.from_state = v_from AND e.to_state = p_to_state;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH004',
            MESSAGE = 'HSB_CONTROL_ORDER_EDGE_REJECTED: ' || v_from::text || ' -> '
                      || p_to_state::text || ' is not a contract edge';
  END IF;

  IF p_guard IS DISTINCT FROM v_edge_guard THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH004',
            MESSAGE = 'HSB_CONTROL_ORDER_GUARD_REJECTED: requires guard ' || v_edge_guard;
  END IF;

  PERFORM set_config('hsb_control.order_mutation_active', 'on', true);
  UPDATE hsb_control.order_control
     SET order_state = p_to_state,
         blocked_from = CASE WHEN p_to_state = 'blocked' THEN v_from ELSE NULL END,
         mutation_seq = v_seq + 1,
         updated_at = now()
   WHERE order_key = p_order_key;
  PERFORM set_config('hsb_control.order_mutation_active', 'off', true);

  INSERT INTO hsb_control.control_audit (audit_kind, subject_key, detail, actor_label, actor_session, stage_at)
  VALUES ('order_transition', p_order_key, v_from::text || '->' || p_to_state::text,
          'app', session_user, hsb_control.current_stage());

  RETURN p_to_state;
END
$$;

-- ===========================================================================
-- Provider phase and evidence
-- ===========================================================================

-- registries.provider_phase_edges_with_guards, all 17 edges, all_unlisted_rejected: true
CREATE TABLE hsb_control.provider_phase_edge (
  from_phase hsb_control.provider_phase NOT NULL,
  to_phase   hsb_control.provider_phase NOT NULL,
  guard      text NOT NULL REFERENCES hsb_control.transition_guard (guard),
  PRIMARY KEY (from_phase, to_phase)
);

INSERT INTO hsb_control.provider_phase_edge (from_phase, to_phase, guard) VALUES
  ('absent', 'marker', 'tx3_immutable_authorization'),
  ('marker', 'candidate', 'tx4_exact_response'),
  ('marker', 'superseded', 'terminal_charge_free'),
  ('marker', 'ambiguous', 'unknown_or_conflict'),
  ('candidate', 'bound', 'tx5_exact_tuple'),
  ('candidate', 'settled', 'atomic_bind_settle'),
  ('candidate', 'superseded', 'tx6_charge_free'),
  ('candidate', 'ambiguous', 'conflict'),
  ('bound', 'settled', 'exact_settlement'),
  ('bound', 'superseded', 'tx6_charge_free'),
  ('bound', 'ambiguous', 'contradiction'),
  ('ambiguous', 'candidate', 'owned_reconciliation'),
  ('ambiguous', 'bound', 'owned_reconciliation'),
  ('ambiguous', 'settled', 'exact_authenticated_settlement'),
  ('ambiguous', 'superseded', 'authoritative_charge_free'),
  ('settled', 'settled', 'compatible_evidence'),
  ('superseded', 'superseded', 'consistent_terminal_evidence');

CREATE TRIGGER provider_phase_edge_immutable
  BEFORE UPDATE OR DELETE ON hsb_control.provider_phase_edge
  FOR EACH ROW EXECUTE FUNCTION hsb_control.forbid_row_mutation();

CREATE TABLE hsb_control.provider_phase_record (
  order_key      text NOT NULL REFERENCES hsb_control.order_control (order_key)
                   ON DELETE RESTRICT ON UPDATE RESTRICT,
  generation     integer NOT NULL CHECK (generation >= 0),
  provider_phase hsb_control.provider_phase NOT NULL,
  phase_seq      bigint NOT NULL DEFAULT 0 CHECK (phase_seq >= 0),
  updated_at     timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (order_key, generation)
);

CREATE INDEX provider_phase_record_phase_idx ON hsb_control.provider_phase_record (provider_phase);

CREATE FUNCTION hsb_control.enforce_provider_phase_monotonicity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hsb_control, pg_temp
AS $$
BEGIN
  IF current_setting('hsb_control.phase_mutation_active', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH005',
            MESSAGE = 'HSB_CONTROL_PHASE_DIRECT_DML: provider_phase_record moves only through '
                      || 'hsb_control.advance_provider_phase';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH005',
            MESSAGE = 'HSB_CONTROL_IMMUTABLE_ROW: provider phase records are never deleted';
  END IF;

  IF NEW.phase_seq <> OLD.phase_seq + 1 THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH005', MESSAGE = 'HSB_CONTROL_PHASE_SEQ_NOT_MONOTONIC';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM hsb_control.provider_phase_edge e
     WHERE e.from_phase = OLD.provider_phase AND e.to_phase = NEW.provider_phase
  ) THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH005',
            MESSAGE = 'HSB_CONTROL_PHASE_EDGE_REJECTED: ' || OLD.provider_phase::text || ' -> '
                      || NEW.provider_phase::text || ' is not a contract edge';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER provider_phase_record_monotonic
  BEFORE UPDATE OR DELETE ON hsb_control.provider_phase_record
  FOR EACH ROW EXECUTE FUNCTION hsb_control.enforce_provider_phase_monotonicity();

CREATE TABLE hsb_control.provider_evidence (
  evidence_seq   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_key      text NOT NULL,
  generation     integer NOT NULL,
  evidence_class hsb_control.evidence_class NOT NULL,
  event_family   hsb_control.event_family NOT NULL,
  event_digest   text NOT NULL CHECK (event_digest ~ '^[0-9a-f]{64}$'),
  observed_at    timestamptz NOT NULL DEFAULT pg_catalog.now(),
  -- Exact-fact identity. Evidence stays append-only for every distinct observation;
  -- this constraint only collapses the byte-identical fact a crash between the
  -- append and event settlement replays, and it is the concurrency-safe backstop
  -- that record_provider_evidence infers on.
  CONSTRAINT provider_evidence_exact_fact_key
    UNIQUE (order_key, generation, evidence_class, event_family, event_digest),
  FOREIGN KEY (order_key, generation)
    REFERENCES hsb_control.provider_phase_record (order_key, generation)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX provider_evidence_order_idx
  ON hsb_control.provider_evidence (order_key, generation, evidence_seq);

CREATE TRIGGER provider_evidence_immutable
  BEFORE UPDATE OR DELETE ON hsb_control.provider_evidence
  FOR EACH ROW EXECUTE FUNCTION hsb_control.forbid_row_mutation();

CREATE FUNCTION hsb_control.open_provider_phase(p_order_key text, p_generation integer)
RETURNS hsb_control.provider_phase
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hsb_control, pg_temp
AS $$
BEGIN
  PERFORM hsb_control.assert_runtime_mutation_allowed('open_provider_phase');

  INSERT INTO hsb_control.provider_phase_record (order_key, generation, provider_phase)
  VALUES (p_order_key, p_generation, 'absent');

  RETURN 'absent';
END
$$;

CREATE FUNCTION hsb_control.advance_provider_phase(
  p_order_key  text,
  p_generation integer,
  p_to_phase   hsb_control.provider_phase,
  p_guard      text
)
RETURNS hsb_control.provider_phase
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hsb_control, pg_temp
AS $$
DECLARE
  v_from hsb_control.provider_phase;
  v_seq  bigint;
  v_edge_guard text;
BEGIN
  PERFORM hsb_control.assert_runtime_mutation_allowed('advance_provider_phase');

  SELECT r.provider_phase, r.phase_seq INTO v_from, v_seq
    FROM hsb_control.provider_phase_record r
   WHERE r.order_key = p_order_key AND r.generation = p_generation
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'ZH008', MESSAGE = 'HSB_CONTROL_PHASE_UNKNOWN';
  END IF;

  SELECT e.guard INTO v_edge_guard
    FROM hsb_control.provider_phase_edge e
   WHERE e.from_phase = v_from AND e.to_phase = p_to_phase;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH005',
            MESSAGE = 'HSB_CONTROL_PHASE_EDGE_REJECTED: ' || v_from::text || ' -> '
                      || p_to_phase::text || ' is not a contract edge';
  END IF;

  IF p_guard IS DISTINCT FROM v_edge_guard THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH005',
            MESSAGE = 'HSB_CONTROL_PHASE_GUARD_REJECTED: requires guard ' || v_edge_guard;
  END IF;

  PERFORM set_config('hsb_control.phase_mutation_active', 'on', true);
  UPDATE hsb_control.provider_phase_record
     SET provider_phase = p_to_phase,
         phase_seq = v_seq + 1,
         updated_at = now()
   WHERE order_key = p_order_key AND generation = p_generation;
  PERFORM set_config('hsb_control.phase_mutation_active', 'off', true);

  RETURN p_to_phase;
END
$$;

CREATE FUNCTION hsb_control.record_provider_evidence(
  p_order_key      text,
  p_generation     integer,
  p_evidence_class hsb_control.evidence_class,
  p_event_family   hsb_control.event_family,
  p_event_digest   text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hsb_control, pg_temp
AS $$
DECLARE
  v_seq bigint;
BEGIN
  PERFORM hsb_control.assert_runtime_mutation_allowed('record_provider_evidence');

  -- A concurrent identical append blocks here on the exact-fact index and then
  -- takes the DO NOTHING path once the winner commits, so no caller ever sees a
  -- raw unique violation. Anything that differs in any identity column has a
  -- different key and still appends.
  INSERT INTO hsb_control.provider_evidence
    (order_key, generation, evidence_class, event_family, event_digest)
  VALUES (p_order_key, p_generation, p_evidence_class, p_event_family, p_event_digest)
  ON CONFLICT ON CONSTRAINT provider_evidence_exact_fact_key DO NOTHING
  RETURNING evidence_seq INTO v_seq;

  IF v_seq IS NULL THEN
    -- Exact replay: converge on the durable row this fact already produced.
    SELECT e.evidence_seq INTO v_seq
      FROM hsb_control.provider_evidence e
     WHERE e.order_key = p_order_key
       AND e.generation = p_generation
       AND e.evidence_class = p_evidence_class
       AND e.event_family = p_event_family
       AND e.event_digest = p_event_digest;
    IF v_seq IS NULL THEN
      RAISE EXCEPTION
        USING ERRCODE = 'ZH005',
              MESSAGE = 'HSB_CONTROL_EVIDENCE_NOT_DURABLE: exact-fact convergence found no durable row';
    END IF;
  END IF;

  RETURN v_seq;
END
$$;

-- ===========================================================================
-- Durable event receipt and application status
-- ===========================================================================

-- registries.event_processing_states: applied and quarantined are terminal;
-- owner_token_fencing: true.
CREATE TABLE hsb_control.event_receipt (
  event_id         text PRIMARY KEY CHECK (event_id ~ '^[A-Za-z0-9_:-]{1,128}$'),
  event_family     hsb_control.event_family NOT NULL,
  payload_digest   text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  processing_state hsb_control.event_processing_state NOT NULL,
  owner_token      uuid,
  lease_expires_at timestamptz,
  received_at      timestamptz NOT NULL DEFAULT pg_catalog.now(),
  updated_at       timestamptz NOT NULL DEFAULT pg_catalog.now(),
  CHECK ((processing_state = 'leased') = (owner_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);

CREATE INDEX event_receipt_state_idx ON hsb_control.event_receipt (processing_state, received_at);

CREATE FUNCTION hsb_control.enforce_event_receipt_terminality()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hsb_control, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH007',
            MESSAGE = 'HSB_CONTROL_IMMUTABLE_ROW: durable event receipts are never deleted';
  END IF;

  IF NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.payload_digest IS DISTINCT FROM OLD.payload_digest
     OR NEW.event_family IS DISTINCT FROM OLD.event_family THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH007',
            MESSAGE = 'HSB_CONTROL_IMMUTABLE_ROW: event identity and digest are immutable';
  END IF;

  IF OLD.processing_state IN ('applied', 'quarantined')
     AND NEW.processing_state IS DISTINCT FROM OLD.processing_state THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH007',
            MESSAGE = 'HSB_CONTROL_EVENT_TERMINAL: ' || OLD.processing_state::text
                      || ' is terminal and never re-opens';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER event_receipt_terminal
  BEFORE UPDATE OR DELETE ON hsb_control.event_receipt
  FOR EACH ROW EXECUTE FUNCTION hsb_control.enforce_event_receipt_terminality();

CREATE FUNCTION hsb_control.record_event_receipt(
  p_event_id       text,
  p_event_family   hsb_control.event_family,
  p_payload_digest text
)
RETURNS hsb_control.event_processing_state
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hsb_control, pg_temp
AS $$
DECLARE
  v_state   hsb_control.event_processing_state;
  v_family  hsb_control.event_family;
  v_digest  text;
BEGIN
  PERFORM hsb_control.assert_runtime_mutation_allowed('record_event_receipt');

  SELECT r.processing_state, r.event_family, r.payload_digest INTO v_state, v_family, v_digest
    FROM hsb_control.event_receipt r
   WHERE r.event_id = p_event_id
     FOR UPDATE;

  IF FOUND THEN
    IF v_family IS DISTINCT FROM p_event_family THEN
      RAISE EXCEPTION
        USING ERRCODE = 'ZH007',
              MESSAGE = 'HSB_CONTROL_EVENT_IDENTITY_CONFLICT: exact replay requires an identical event family';
    END IF;
    -- registries.event_processing_states.different_digest:
    -- a changed digest for a known event id is a durable hold case, never a replay.
    IF v_digest IS DISTINCT FROM p_payload_digest THEN
      RAISE EXCEPTION
        USING ERRCODE = 'ZH007',
              MESSAGE = 'HSB_CONTROL_EVENT_DIGEST_CONFLICT: exact replay requires an identical digest';
    END IF;
    RETURN v_state;  -- exact replay
  END IF;

  INSERT INTO hsb_control.event_receipt (event_id, event_family, payload_digest, processing_state)
  VALUES (p_event_id, p_event_family, p_payload_digest, 'received');

  RETURN 'received';
END
$$;

CREATE FUNCTION hsb_control.claim_event_lease(
  p_event_id    text,
  p_owner_token uuid,
  p_lease_seconds integer DEFAULT 60
)
RETURNS hsb_control.event_processing_state
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hsb_control, pg_temp
AS $$
DECLARE
  v_state   hsb_control.event_processing_state;
  v_expires timestamptz;
  v_now     timestamptz;
BEGIN
  PERFORM hsb_control.assert_runtime_mutation_allowed('claim_event_lease');

  IF p_owner_token IS NULL OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 1 AND 3600 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZH008', MESSAGE = 'HSB_CONTROL_LEASE_INPUT_REJECTED';
  END IF;

  SELECT r.processing_state, r.lease_expires_at INTO v_state, v_expires
    FROM hsb_control.event_receipt r
   WHERE r.event_id = p_event_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'ZH008', MESSAGE = 'HSB_CONTROL_EVENT_UNKNOWN';
  END IF;

  IF v_state IN ('applied', 'quarantined') THEN
    RETURN v_state;  -- exact replay of a terminal event is a no-op
  END IF;

  v_now := pg_catalog.clock_timestamp();

  IF v_state = 'leased' AND v_expires > v_now THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH007',
            MESSAGE = 'HSB_CONTROL_EVENT_LEASE_LIVE: a live lease is held by another owner';
  END IF;

  UPDATE hsb_control.event_receipt
     SET processing_state = 'leased',
         owner_token = p_owner_token,
         lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
         updated_at = v_now
   WHERE event_id = p_event_id;

  RETURN 'leased';
END
$$;

CREATE FUNCTION hsb_control.settle_event_lease(
  p_event_id    text,
  p_owner_token uuid,
  p_outcome     hsb_control.event_processing_state
)
RETURNS hsb_control.event_processing_state
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hsb_control, pg_temp
AS $$
DECLARE
  v_owner   uuid;
  v_state   hsb_control.event_processing_state;
  v_expires timestamptz;
BEGIN
  PERFORM hsb_control.assert_runtime_mutation_allowed('settle_event_lease');

  IF p_outcome NOT IN ('applied', 'quarantined', 'retryable_failure') THEN
    RAISE EXCEPTION USING ERRCODE = 'ZH008', MESSAGE = 'HSB_CONTROL_EVENT_OUTCOME_REJECTED';
  END IF;

  SELECT r.owner_token, r.processing_state, r.lease_expires_at INTO v_owner, v_state, v_expires
    FROM hsb_control.event_receipt r
   WHERE r.event_id = p_event_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'ZH008', MESSAGE = 'HSB_CONTROL_EVENT_UNKNOWN';
  END IF;

  IF v_state IN ('applied', 'quarantined') THEN
    RETURN v_state;
  END IF;

  -- registries.event_processing_states.owner_token_fencing
  IF p_owner_token IS NULL
     OR v_state IS DISTINCT FROM 'leased'
     OR v_owner IS DISTINCT FROM p_owner_token
     OR v_expires IS NULL
     OR v_expires <= pg_catalog.clock_timestamp() THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH007',
            MESSAGE = 'HSB_CONTROL_EVENT_FENCED: the presented owner token does not hold the lease';
  END IF;

  UPDATE hsb_control.event_receipt
     SET processing_state = p_outcome,
         owner_token = NULL,
         lease_expires_at = NULL,
         updated_at = now()
   WHERE event_id = p_event_id;

  RETURN p_outcome;
END
$$;

-- ===========================================================================
-- PaymentIntent-keyed reversal inbox
-- registries.payment_identity_lock_protocol.evidence_rule:
--   append_only_with_separate_unique_consumption
-- ===========================================================================

CREATE TABLE hsb_control.reversal_evidence (
  payment_intent_id text NOT NULL CHECK (payment_intent_id ~ '^[A-Za-z0-9_-]{1,255}$'),
  reversal_key      text NOT NULL CHECK (reversal_key ~ '^[A-Za-z0-9_:-]{1,128}$'),
  reversal_kind     hsb_control.reversal_kind NOT NULL,
  amount_minor      bigint NOT NULL CHECK (amount_minor >= 0),
  currency          text NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  event_digest      text NOT NULL CHECK (event_digest ~ '^[0-9a-f]{64}$'),
  observed_at       timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (payment_intent_id, reversal_key)
);

CREATE INDEX reversal_evidence_payment_intent_idx
  ON hsb_control.reversal_evidence (payment_intent_id, observed_at);

CREATE TRIGGER reversal_evidence_immutable
  BEFORE UPDATE OR DELETE ON hsb_control.reversal_evidence
  FOR EACH ROW EXECUTE FUNCTION hsb_control.forbid_row_mutation();

-- Separate table, unique per evidence row: consumption can never be double-counted
-- and can never rewrite the evidence it consumes.
CREATE TABLE hsb_control.reversal_consumption (
  payment_intent_id text NOT NULL,
  reversal_key      text NOT NULL,
  order_key         text NOT NULL REFERENCES hsb_control.order_control (order_key)
                      ON DELETE RESTRICT ON UPDATE RESTRICT,
  consumed_at       timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (payment_intent_id, reversal_key),
  FOREIGN KEY (payment_intent_id, reversal_key)
    REFERENCES hsb_control.reversal_evidence (payment_intent_id, reversal_key)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX reversal_consumption_order_idx ON hsb_control.reversal_consumption (order_key);

CREATE TRIGGER reversal_consumption_immutable
  BEFORE UPDATE OR DELETE ON hsb_control.reversal_consumption
  FOR EACH ROW EXECUTE FUNCTION hsb_control.forbid_row_mutation();

CREATE FUNCTION hsb_control.record_reversal_evidence(
  p_payment_intent_id text,
  p_reversal_key      text,
  p_reversal_kind     hsb_control.reversal_kind,
  p_amount_minor      bigint,
  p_currency          text,
  p_event_digest      text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hsb_control, pg_temp
AS $$
DECLARE
  v_kind     hsb_control.reversal_kind;
  v_amount   bigint;
  v_currency text;
  v_digest   text;
BEGIN
  PERFORM hsb_control.assert_runtime_mutation_allowed('record_reversal_evidence');

  PERFORM hsb_control.lock_payment_identities(
    ARRAY['payment_intent']::hsb_control.identity_kind[],
    ARRAY[p_payment_intent_id]
  );

  SELECT r.reversal_kind, r.amount_minor, r.currency::text, r.event_digest
    INTO v_kind, v_amount, v_currency, v_digest
    FROM hsb_control.reversal_evidence r
   WHERE r.payment_intent_id = p_payment_intent_id
     AND r.reversal_key = p_reversal_key
   FOR UPDATE;
  IF FOUND THEN
    IF v_kind IS DISTINCT FROM p_reversal_kind
       OR v_amount IS DISTINCT FROM p_amount_minor
       OR v_currency IS DISTINCT FROM p_currency
       OR v_digest IS DISTINCT FROM p_event_digest THEN
      RAISE EXCEPTION
        USING ERRCODE = 'ZH007',
              MESSAGE = 'HSB_CONTROL_REVERSAL_CONFLICT: exact replay requires identical evidence';
    END IF;
    RETURN false;
  END IF;

  INSERT INTO hsb_control.reversal_evidence
    (payment_intent_id, reversal_key, reversal_kind, amount_minor, currency, event_digest)
  VALUES (p_payment_intent_id, p_reversal_key, p_reversal_kind, p_amount_minor, p_currency, p_event_digest);
  RETURN true;
END
$$;

CREATE FUNCTION hsb_control.consume_reversal(
  p_payment_intent_id text,
  p_reversal_key      text,
  p_order_key         text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hsb_control, pg_temp
AS $$
DECLARE
  v_existing_order text;
BEGIN
  PERFORM hsb_control.assert_runtime_mutation_allowed('consume_reversal');

  PERFORM hsb_control.lock_payment_identities(
    ARRAY['payment_intent']::hsb_control.identity_kind[],
    ARRAY[p_payment_intent_id]
  );

  SELECT c.order_key INTO v_existing_order
    FROM hsb_control.reversal_consumption c
   WHERE c.payment_intent_id = p_payment_intent_id
     AND c.reversal_key = p_reversal_key
   FOR UPDATE;
  IF FOUND THEN
    IF v_existing_order IS DISTINCT FROM p_order_key THEN
      RAISE EXCEPTION
        USING ERRCODE = 'ZH007',
              MESSAGE = 'HSB_CONTROL_REVERSAL_CONSUMPTION_CONFLICT: evidence is already consumed by another order';
    END IF;
    RETURN false;
  END IF;

  INSERT INTO hsb_control.reversal_consumption (payment_intent_id, reversal_key, order_key)
  VALUES (p_payment_intent_id, p_reversal_key, p_order_key);
  RETURN true;
END
$$;

-- ===========================================================================
-- Dispute state and evidence
-- ===========================================================================

-- registries.dispute_edges_with_guards, all 15 edges, all_unlisted_rejected: true
CREATE TABLE hsb_control.dispute_edge (
  from_state hsb_control.dispute_state NOT NULL,
  incoming   hsb_control.dispute_state NOT NULL,
  to_state   hsb_control.dispute_state NOT NULL,
  guard      text NOT NULL REFERENCES hsb_control.transition_guard (guard),
  PRIMARY KEY (from_state, incoming)
);

INSERT INTO hsb_control.dispute_edge (from_state, incoming, to_state, guard) VALUES
  ('none', 'open', 'open', 'first_open_evidence'),
  ('none', 'won', 'won', 'first_won_evidence'),
  ('none', 'lost', 'lost', 'first_lost_evidence'),
  ('open', 'open', 'open', 'compatible_open_evidence'),
  ('open', 'won', 'won', 'won_evidence'),
  ('open', 'lost', 'lost', 'lost_evidence'),
  ('won', 'open', 'won', 'stale_open_preserves_terminal'),
  ('won', 'won', 'won', 'compatible_won_evidence'),
  ('won', 'lost', 'conflict', 'opposite_lost_evidence'),
  ('lost', 'open', 'lost', 'stale_open_preserves_terminal'),
  ('lost', 'won', 'conflict', 'opposite_won_evidence'),
  ('lost', 'lost', 'lost', 'compatible_lost_evidence'),
  ('conflict', 'open', 'conflict', 'all_later_evidence'),
  ('conflict', 'won', 'conflict', 'all_later_evidence'),
  ('conflict', 'lost', 'conflict', 'all_later_evidence');

CREATE TRIGGER dispute_edge_immutable
  BEFORE UPDATE OR DELETE ON hsb_control.dispute_edge
  FOR EACH ROW EXECUTE FUNCTION hsb_control.forbid_row_mutation();

CREATE TABLE hsb_control.dispute_record (
  dispute_id    text PRIMARY KEY CHECK (dispute_id ~ '^[A-Za-z0-9_:-]{1,128}$'),
  order_key     text NOT NULL REFERENCES hsb_control.order_control (order_key)
                  ON DELETE RESTRICT ON UPDATE RESTRICT,
  dispute_state hsb_control.dispute_state NOT NULL,
  dispute_seq   bigint NOT NULL DEFAULT 0 CHECK (dispute_seq >= 0),
  updated_at    timestamptz NOT NULL DEFAULT pg_catalog.now()
);

CREATE INDEX dispute_record_order_idx ON hsb_control.dispute_record (order_key);

CREATE TABLE hsb_control.dispute_evidence (
  evidence_seq  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dispute_id    text NOT NULL REFERENCES hsb_control.dispute_record (dispute_id)
                  ON DELETE RESTRICT ON UPDATE RESTRICT,
  incoming      hsb_control.dispute_state NOT NULL,
  resulting     hsb_control.dispute_state NOT NULL,
  guard         text NOT NULL REFERENCES hsb_control.transition_guard (guard),
  event_digest  text NOT NULL CHECK (event_digest ~ '^[0-9a-f]{64}$'),
  observed_at   timestamptz NOT NULL DEFAULT pg_catalog.now(),
  -- Exact-fact identity. The owning order is not repeated here because a dispute id
  -- binds to exactly one order_key in dispute_record, and apply_dispute_evidence
  -- refuses a different binding before it ever reaches this table.
  CONSTRAINT dispute_evidence_exact_fact_key UNIQUE (dispute_id, incoming, event_digest)
);

CREATE INDEX dispute_evidence_dispute_idx ON hsb_control.dispute_evidence (dispute_id, evidence_seq);

CREATE TRIGGER dispute_evidence_immutable
  BEFORE UPDATE OR DELETE ON hsb_control.dispute_evidence
  FOR EACH ROW EXECUTE FUNCTION hsb_control.forbid_row_mutation();

CREATE FUNCTION hsb_control.apply_dispute_evidence(
  p_dispute_id   text,
  p_order_key    text,
  p_incoming     hsb_control.dispute_state,
  p_event_digest text
)
RETURNS hsb_control.dispute_state
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hsb_control, pg_temp
AS $$
DECLARE
  v_from  hsb_control.dispute_state;
  v_seq   bigint;
  v_order text;
  v_edge  hsb_control.dispute_edge%ROWTYPE;
BEGIN
  PERFORM hsb_control.assert_runtime_mutation_allowed('apply_dispute_evidence');

  IF p_incoming NOT IN ('open', 'won', 'lost') THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH008',
            MESSAGE = 'HSB_CONTROL_DISPUTE_INPUT_REJECTED: incoming evidence must be open, won, or lost';
  END IF;

  -- Open the record before taking the row lock. Two sessions racing on a brand-new
  -- dispute id cannot see each other's uncommitted row, so the loser must land on
  -- DO NOTHING rather than a raw dispute_record_pkey violation.
  INSERT INTO hsb_control.dispute_record (dispute_id, order_key, dispute_state)
  VALUES (p_dispute_id, p_order_key, 'none')
  ON CONFLICT (dispute_id) DO NOTHING;

  -- READ COMMITTED gives this command a fresh snapshot, so the loser of that race
  -- now sees the winner's committed record and serializes behind its row lock.
  SELECT d.dispute_state, d.dispute_seq, d.order_key INTO v_from, v_seq, v_order
    FROM hsb_control.dispute_record d
   WHERE d.dispute_id = p_dispute_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'ZH008', MESSAGE = 'HSB_CONTROL_DISPUTE_UNKNOWN';
  END IF;

  IF v_order IS DISTINCT FROM p_order_key THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH007',
            MESSAGE = 'HSB_CONTROL_DISPUTE_ORDER_CONFLICT: dispute is bound to another order';
  END IF;

  -- Exact replay of a fact already applied: return the state the graph now holds
  -- without appending evidence or advancing dispute_seq a second time. The row lock
  -- above makes this check race-free; dispute_evidence_exact_fact_key is the
  -- structural backstop. Any distinct observation falls through and advances.
  IF EXISTS (
    SELECT 1 FROM hsb_control.dispute_evidence e
     WHERE e.dispute_id = p_dispute_id
       AND e.incoming = p_incoming
       AND e.event_digest = p_event_digest
  ) THEN
    RETURN v_from;
  END IF;

  SELECT * INTO v_edge
    FROM hsb_control.dispute_edge e
   WHERE e.from_state = v_from AND e.incoming = p_incoming;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH008',
            MESSAGE = 'HSB_CONTROL_DISPUTE_EDGE_REJECTED: ' || v_from::text || ' + '
                      || p_incoming::text || ' is not a contract edge';
  END IF;

  UPDATE hsb_control.dispute_record
     SET dispute_state = v_edge.to_state,
         dispute_seq = v_seq + 1,
         updated_at = now()
   WHERE dispute_id = p_dispute_id;

  INSERT INTO hsb_control.dispute_evidence (dispute_id, incoming, resulting, guard, event_digest)
  VALUES (p_dispute_id, p_incoming, v_edge.to_state, v_edge.guard, p_event_digest);

  RETURN v_edge.to_state;
END
$$;

-- ===========================================================================
-- Non-authoritative projections
-- registries.projection_contract:
--   payload          immutable_canonical_bytes_and_digest
--   outbox_identity  (entity_kind, entity_key, mutation_seq)
--   apply            sequence_monotonic_owner_token_fenced_exact_readback
--   reverse_gate_exists: false
-- ===========================================================================

CREATE TABLE hsb_control.projection_outbox (
  entity_kind    text NOT NULL CHECK (entity_kind ~ '^[a-z_]{1,64}$'),
  entity_key     text NOT NULL CHECK (entity_key ~ '^[A-Za-z0-9_:-]{1,128}$'),
  mutation_seq   bigint NOT NULL CHECK (mutation_seq >= 0),
  payload_bytes  bytea NOT NULL,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  enqueued_at    timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (entity_kind, entity_key, mutation_seq)
);

CREATE INDEX projection_outbox_pending_idx
  ON hsb_control.projection_outbox (entity_kind, entity_key, mutation_seq);

CREATE TRIGGER projection_outbox_immutable
  BEFORE UPDATE OR DELETE ON hsb_control.projection_outbox
  FOR EACH ROW EXECUTE FUNCTION hsb_control.forbid_row_mutation();

CREATE TABLE hsb_control.projection_row (
  entity_kind      text NOT NULL CHECK (entity_kind ~ '^[a-z_]{1,64}$'),
  entity_key       text NOT NULL CHECK (entity_key ~ '^[A-Za-z0-9_:-]{1,128}$'),
  applied_seq      bigint NOT NULL CHECK (applied_seq >= 0),
  applied_digest   text NOT NULL CHECK (applied_digest ~ '^[0-9a-f]{64}$'),
  owner_token      uuid NOT NULL,
  -- A projection is never a source of truth. The constraint says so structurally,
  -- so no later slice can quietly promote it.
  is_authoritative boolean NOT NULL DEFAULT false CHECK (is_authoritative = false),
  applied_at       timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (entity_kind, entity_key),
  FOREIGN KEY (entity_kind, entity_key, applied_seq)
    REFERENCES hsb_control.projection_outbox (entity_kind, entity_key, mutation_seq)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

COMMENT ON TABLE hsb_control.projection_row IS
  'Non-authoritative read projection. is_authoritative is pinned false by CHECK.';

CREATE FUNCTION hsb_control.enqueue_projection(
  p_entity_kind    text,
  p_entity_key     text,
  p_mutation_seq   bigint,
  p_payload_bytes  bytea,
  p_payload_digest text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hsb_control, pg_temp
AS $$
DECLARE
  v_inserted        bigint;
  v_existing_bytes  bytea;
  v_existing_digest text;
BEGIN
  PERFORM hsb_control.assert_runtime_mutation_allowed('enqueue_projection');

  IF encode(sha256(p_payload_bytes), 'hex') IS DISTINCT FROM p_payload_digest THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH008',
            MESSAGE = 'HSB_CONTROL_PROJECTION_DIGEST_MISMATCH: payload digest must match the canonical bytes';
  END IF;

  INSERT INTO hsb_control.projection_outbox
    (entity_kind, entity_key, mutation_seq, payload_bytes, payload_digest)
  VALUES (p_entity_kind, p_entity_key, p_mutation_seq, p_payload_bytes, p_payload_digest)
  ON CONFLICT (entity_kind, entity_key, mutation_seq) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 0 THEN
    SELECT o.payload_bytes, o.payload_digest
      INTO v_existing_bytes, v_existing_digest
      FROM hsb_control.projection_outbox o
     WHERE o.entity_kind = p_entity_kind
       AND o.entity_key = p_entity_key
       AND o.mutation_seq = p_mutation_seq;

    IF NOT FOUND
       OR v_existing_bytes IS DISTINCT FROM p_payload_bytes
       OR v_existing_digest IS DISTINCT FROM p_payload_digest THEN
      RAISE EXCEPTION
        USING ERRCODE = 'ZH007',
              MESSAGE = 'HSB_CONTROL_PROJECTION_REPLAY_CONFLICT: duplicate identity requires identical canonical bytes';
    END IF;
  END IF;

  RETURN v_inserted = 1;
END
$$;

CREATE FUNCTION hsb_control.apply_projection(
  p_entity_kind  text,
  p_entity_key   text,
  p_mutation_seq bigint,
  p_owner_token  uuid
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hsb_control, pg_temp
AS $$
DECLARE
  v_applied bigint;
  v_owner   uuid;
  v_digest  text;
BEGIN
  PERFORM hsb_control.assert_runtime_mutation_allowed('apply_projection');

  SELECT o.payload_digest INTO v_digest
    FROM hsb_control.projection_outbox o
   WHERE o.entity_kind = p_entity_kind
     AND o.entity_key = p_entity_key
     AND o.mutation_seq = p_mutation_seq;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'ZH008', MESSAGE = 'HSB_CONTROL_PROJECTION_UNKNOWN';
  END IF;

  SELECT r.applied_seq, r.owner_token INTO v_applied, v_owner
    FROM hsb_control.projection_row r
   WHERE r.entity_kind = p_entity_kind AND r.entity_key = p_entity_key
     FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO hsb_control.projection_row
      (entity_kind, entity_key, applied_seq, applied_digest, owner_token)
    VALUES (p_entity_kind, p_entity_key, p_mutation_seq, v_digest, p_owner_token);
    RETURN p_mutation_seq;
  END IF;

  -- registries.projection_contract.apply: monotonic and owner-token fenced.
  IF v_owner IS DISTINCT FROM p_owner_token THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH007',
            MESSAGE = 'HSB_CONTROL_PROJECTION_FENCED: the presented owner token does not own this projection';
  END IF;

  IF p_mutation_seq <= v_applied THEN
    RETURN v_applied;  -- reverse_gate_exists: false — never move a projection backwards
  END IF;

  UPDATE hsb_control.projection_row
     SET applied_seq = p_mutation_seq,
         applied_digest = v_digest,
         applied_at = now()
   WHERE entity_kind = p_entity_kind AND entity_key = p_entity_key;

  RETURN p_mutation_seq;
END
$$;

RESET ROLE;
