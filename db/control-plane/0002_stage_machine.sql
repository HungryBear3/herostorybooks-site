-- HSB Phase B control-plane foundation — the closed stage machine.
--
-- registries.stage_edges: exactly ten edges, `all_complements_rejected: true`,
-- `legacy_reverse_fallback_prohibited: true`. Every other ordered (from, to) pair
-- of the six stages — including every self-loop — is rejected.
--
-- The singleton starts at `off`. Nothing in this file, and nothing in any later
-- file, activates it implicitly.

\set ON_ERROR_STOP on

SET ROLE hsb_owner;

-- ---------------------------------------------------------------------------
-- Guard vocabulary (registries.transition_guards.values, all 55)
-- ---------------------------------------------------------------------------
CREATE TABLE hsb_control.transition_guard (
  guard text PRIMARY KEY CHECK (guard ~ '^[a-z0-9_]{1,64}$')
);

INSERT INTO hsb_control.transition_guard (guard) VALUES
  ('activation_gate_passed'),
  ('all_later_evidence'),
  ('atomic_bind_settle'),
  ('audited_hold'),
  ('audited_resume'),
  ('audited_unblock_from_ambiguous'),
  ('audited_unblock_from_draft'),
  ('audited_unblock_from_payable'),
  ('audited_unblock_from_provisioning'),
  ('authoritative_charge_free'),
  ('backfill_rollback'),
  ('backfill_verified'),
  ('begin_backfill'),
  ('begin_shadow'),
  ('compatible_evidence'),
  ('compatible_later_evidence'),
  ('compatible_lost_evidence'),
  ('compatible_open_evidence'),
  ('compatible_or_partial_or_dispute'),
  ('compatible_won_evidence'),
  ('conflict'),
  ('conflict_or_failed_pi'),
  ('consistent_terminal_evidence'),
  ('contradiction'),
  ('disable_shadow'),
  ('exact_authenticated_settlement'),
  ('exact_settlement'),
  ('first_lost_evidence'),
  ('first_open_evidence'),
  ('first_won_evidence'),
  ('full_refund_or_lost_dispute'),
  ('lost_evidence'),
  ('never_entered_provider'),
  ('opposite_lost_evidence'),
  ('opposite_won_evidence'),
  ('owned_reconciliation'),
  ('runtime_outage_latch'),
  ('stale_open_preserves_terminal'),
  ('terminal_charge_free'),
  ('tx13_all_generations_charge_free'),
  ('tx13_plus_audited_unblock'),
  ('tx3_first_marker'),
  ('tx3_immutable_authorization'),
  ('tx4_exact_response'),
  ('tx5_exact_bind'),
  ('tx5_exact_tuple'),
  ('tx6_charge_free'),
  ('tx6_reconciled_rotate_fence'),
  ('tx6_terminal_charge_free_rotate_fence'),
  ('tx7_exact_settlement'),
  ('tx7_exact_settlement_preserve_holds'),
  ('unknown_or_conflict'),
  ('verification_invalidated'),
  ('verified_rollback'),
  ('won_evidence');

CREATE TRIGGER transition_guard_immutable
  BEFORE UPDATE OR DELETE ON hsb_control.transition_guard
  FOR EACH ROW EXECUTE FUNCTION hsb_control.forbid_row_mutation();

-- ---------------------------------------------------------------------------
-- The closed edge set. Membership in this table IS the accept predicate.
-- ---------------------------------------------------------------------------
CREATE TABLE hsb_control.stage_edge (
  from_stage hsb_control.stage NOT NULL,
  to_stage   hsb_control.stage NOT NULL,
  guard      text NOT NULL REFERENCES hsb_control.transition_guard (guard),
  -- `runtime_outage_latch` is reachable only through the narrow app-only outage
  -- function (preserved control `narrow_activated_to_hold_outage_function`).
  narrow_outage_only boolean NOT NULL DEFAULT false,
  PRIMARY KEY (from_stage, to_stage)
);

CREATE INDEX stage_edge_guard_idx ON hsb_control.stage_edge (guard);

INSERT INTO hsb_control.stage_edge (from_stage, to_stage, guard) VALUES
  ('off', 'shadow', 'begin_shadow'),
  ('shadow', 'off', 'disable_shadow'),
  ('shadow', 'backfill', 'begin_backfill'),
  ('backfill', 'shadow', 'backfill_rollback'),
  ('backfill', 'verified', 'backfill_verified'),
  ('verified', 'backfill', 'verification_invalidated'),
  ('verified', 'shadow', 'verified_rollback'),
  ('verified', 'activated', 'activation_gate_passed'),
  ('activated', 'hold', 'runtime_outage_latch'),
  ('hold', 'activated', 'audited_resume');

UPDATE hsb_control.stage_edge
   SET narrow_outage_only = true
 WHERE from_stage = 'activated' AND to_stage = 'hold';

CREATE TRIGGER stage_edge_immutable
  BEFORE UPDATE OR DELETE ON hsb_control.stage_edge
  FOR EACH ROW EXECUTE FUNCTION hsb_control.forbid_row_mutation();

-- ---------------------------------------------------------------------------
-- The singleton. Seeded at `off`, epoch 0, runtime generation 0.
-- ---------------------------------------------------------------------------
CREATE TABLE hsb_control.stage_state (
  stage_id           text PRIMARY KEY DEFAULT 'singleton' CHECK (stage_id = 'singleton'),
  stage              hsb_control.stage NOT NULL,
  stage_epoch        bigint NOT NULL CHECK (stage_epoch >= 0),
  runtime_generation bigint NOT NULL CHECK (runtime_generation >= 0),
  entered_at         timestamptz NOT NULL DEFAULT pg_catalog.now()
);

INSERT INTO hsb_control.stage_state (stage_id, stage, stage_epoch, runtime_generation)
VALUES ('singleton', 'off', 0, 0);

CREATE TABLE hsb_control.stage_transition_audit (
  audit_seq          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  from_stage         hsb_control.stage NOT NULL,
  to_stage           hsb_control.stage NOT NULL,
  guard              text NOT NULL REFERENCES hsb_control.transition_guard (guard),
  actor_label        text NOT NULL CHECK (pg_catalog.length(actor_label) BETWEEN 1 AND 128),
  actor_session      name NOT NULL,
  reason             text NOT NULL DEFAULT '' CHECK (pg_catalog.length(reason) <= 1024),
  stage_epoch        bigint NOT NULL,
  runtime_generation bigint NOT NULL,
  via_narrow_outage  boolean NOT NULL,
  occurred_at        timestamptz NOT NULL DEFAULT pg_catalog.now()
);

CREATE INDEX stage_transition_audit_epoch_idx
  ON hsb_control.stage_transition_audit (stage_epoch);

CREATE TRIGGER stage_transition_audit_immutable
  BEFORE UPDATE OR DELETE ON hsb_control.stage_transition_audit
  FOR EACH ROW EXECUTE FUNCTION hsb_control.forbid_row_mutation();

-- ---------------------------------------------------------------------------
-- Enforcement. The trigger is the last line of defence: even the schema owner
-- cannot move the stage with direct DML, because only the transition functions
-- set the transaction-local marker this trigger demands.
-- ---------------------------------------------------------------------------
CREATE FUNCTION hsb_control.enforce_stage_edge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hsb_control, pg_temp
AS $$
DECLARE
  v_marker text := current_setting('hsb_control.transition_active', true);
BEGIN
  IF v_marker IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH002',
            MESSAGE = 'HSB_CONTROL_STAGE_DIRECT_DML: stage_state moves only through '
                      || 'hsb_control.request_stage_transition or hsb_control.enter_hold_after_outage';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM hsb_control.stage_edge e
     WHERE e.from_stage = OLD.stage AND e.to_stage = NEW.stage
  ) THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH002',
            MESSAGE = 'HSB_CONTROL_STAGE_EDGE_REJECTED: ' || OLD.stage::text || ' -> '
                      || NEW.stage::text || ' is not a contract edge';
  END IF;

  IF NEW.stage_epoch <> OLD.stage_epoch + 1 THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH002',
            MESSAGE = 'HSB_CONTROL_STAGE_EPOCH_NOT_MONOTONIC';
  END IF;

  IF NEW.runtime_generation < OLD.runtime_generation THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH002',
            MESSAGE = 'HSB_CONTROL_STAGE_GENERATION_NOT_MONOTONIC';
  END IF;

  RETURN NEW;
END
$$;

CREATE FUNCTION hsb_control.forbid_stage_singleton_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hsb_control, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION
    USING ERRCODE = 'ZH002',
          MESSAGE = 'HSB_CONTROL_STAGE_SINGLETON: stage_state holds exactly one row; '
                    || TG_OP || ' is rejected';
END
$$;

CREATE TRIGGER stage_state_edge_guard
  BEFORE UPDATE ON hsb_control.stage_state
  FOR EACH ROW EXECUTE FUNCTION hsb_control.enforce_stage_edge();

CREATE TRIGGER stage_state_singleton_guard
  BEFORE INSERT OR DELETE ON hsb_control.stage_state
  FOR EACH ROW EXECUTE FUNCTION hsb_control.forbid_stage_singleton_change();

-- ---------------------------------------------------------------------------
-- Readers
-- ---------------------------------------------------------------------------
CREATE FUNCTION hsb_control.current_stage()
RETURNS hsb_control.stage
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, hsb_control, pg_temp
AS $$
  SELECT s.stage FROM hsb_control.stage_state s WHERE s.stage_id = 'singleton';
$$;

CREATE FUNCTION hsb_control.current_stage_fingerprint(
  OUT stage hsb_control.stage,
  OUT stage_epoch bigint,
  OUT runtime_generation bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, hsb_control, pg_temp
AS $$
  SELECT s.stage, s.stage_epoch, s.runtime_generation
    FROM hsb_control.stage_state s
   WHERE s.stage_id = 'singleton';
$$;

-- ---------------------------------------------------------------------------
-- Shared runtime gate. `off` fails closed for every mutation that would create
-- or advance runtime order/provider/payment state.
-- ---------------------------------------------------------------------------
CREATE FUNCTION hsb_control.assert_runtime_mutation_allowed(p_operation text)
RETURNS hsb_control.stage
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hsb_control, pg_temp
AS $$
DECLARE
  v_stage hsb_control.stage;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('hsb-control-stage-admission-v1', 0)
  );
  SELECT s.stage INTO v_stage
    FROM hsb_control.stage_state s
   WHERE s.stage_id = 'singleton'
   FOR SHARE;
  IF v_stage = 'off' THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH001',
            MESSAGE = 'HSB_CONTROL_STAGE_OFF: ' || p_operation
                      || ' is refused while the control plane stage is off';
  END IF;
  RETURN v_stage;
END
$$;

-- ---------------------------------------------------------------------------
-- The general stage transition. Accepts nine of the ten contract edges; the
-- activated -> hold outage latch is deliberately NOT reachable here.
-- ---------------------------------------------------------------------------
CREATE FUNCTION hsb_control.request_stage_transition(
  p_to_stage hsb_control.stage,
  p_guard    text,
  p_actor    text,
  p_reason   text DEFAULT ''
)
RETURNS hsb_control.stage
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hsb_control, pg_temp
AS $$
DECLARE
  v_from   hsb_control.stage;
  v_epoch  bigint;
  v_gen    bigint;
  v_edge   hsb_control.stage_edge%ROWTYPE;
BEGIN
  IF p_actor IS NULL OR length(p_actor) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZH008', MESSAGE = 'HSB_CONTROL_ACTOR_REQUIRED';
  END IF;

  PERFORM pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hsb-control-stage-admission-v1', 0)
  );

  SELECT s.stage, s.stage_epoch, s.runtime_generation
    INTO v_from, v_epoch, v_gen
    FROM hsb_control.stage_state s
   WHERE s.stage_id = 'singleton'
     FOR UPDATE;

  SELECT * INTO v_edge
    FROM hsb_control.stage_edge e
   WHERE e.from_stage = v_from AND e.to_stage = p_to_stage;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH002',
            MESSAGE = 'HSB_CONTROL_STAGE_EDGE_REJECTED: ' || v_from::text || ' -> '
                      || p_to_stage::text || ' is not a contract edge';
  END IF;

  IF v_edge.narrow_outage_only THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH002',
            MESSAGE = 'HSB_CONTROL_STAGE_NARROW_ONLY: ' || v_from::text || ' -> '
                      || p_to_stage::text || ' is reachable only through '
                      || 'hsb_control.enter_hold_after_outage';
  END IF;

  IF p_guard IS DISTINCT FROM v_edge.guard THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH002',
            MESSAGE = 'HSB_CONTROL_STAGE_GUARD_REJECTED: ' || v_from::text || ' -> '
                      || p_to_stage::text || ' requires guard ' || v_edge.guard;
  END IF;

  -- Entering `activated` opens a new runtime admission generation.
  IF p_to_stage = 'activated' THEN
    v_gen := v_gen + 1;
  END IF;

  PERFORM set_config('hsb_control.transition_active', 'on', true);
  UPDATE hsb_control.stage_state
     SET stage = p_to_stage,
         stage_epoch = v_epoch + 1,
         runtime_generation = v_gen,
         entered_at = now()
   WHERE stage_id = 'singleton';
  PERFORM set_config('hsb_control.transition_active', 'off', true);

  INSERT INTO hsb_control.stage_transition_audit (
    from_stage, to_stage, guard, actor_label, actor_session, reason,
    stage_epoch, runtime_generation, via_narrow_outage
  ) VALUES (
    v_from, p_to_stage, v_edge.guard, p_actor, session_user, coalesce(p_reason, ''),
    v_epoch + 1, v_gen, false
  );

  INSERT INTO hsb_control.control_audit (audit_kind, subject_key, detail, actor_label, actor_session, stage_at)
  VALUES ('stage_transition', 'stage_state:singleton',
          v_from::text || '->' || p_to_stage::text, p_actor, session_user, p_to_stage);

  RETURN p_to_stage;
END
$$;

-- ---------------------------------------------------------------------------
-- registries.roles_and_function_grants.enter_hold_after_outage:
--   hsb_app_only_activated_to_hold_exact_epoch_generation
-- ---------------------------------------------------------------------------
CREATE FUNCTION hsb_control.enter_hold_after_outage(
  p_expected_epoch      bigint,
  p_expected_generation bigint,
  p_actor               text
)
RETURNS hsb_control.stage
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hsb_control, pg_temp
AS $$
DECLARE
  v_from  hsb_control.stage;
  v_epoch bigint;
  v_gen   bigint;
BEGIN
  IF p_actor IS NULL OR length(p_actor) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION USING ERRCODE = 'ZH008', MESSAGE = 'HSB_CONTROL_ACTOR_REQUIRED';
  END IF;

  PERFORM pg_advisory_xact_lock(
    pg_catalog.hashtextextended('hsb-control-stage-admission-v1', 0)
  );

  SELECT s.stage, s.stage_epoch, s.runtime_generation
    INTO v_from, v_epoch, v_gen
    FROM hsb_control.stage_state s
   WHERE s.stage_id = 'singleton'
     FOR UPDATE;

  IF v_from <> 'activated' THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH002',
            MESSAGE = 'HSB_CONTROL_STAGE_EDGE_REJECTED: ' || v_from::text
                      || ' -> hold is not a contract edge from this stage';
  END IF;

  IF p_expected_epoch IS DISTINCT FROM v_epoch OR p_expected_generation IS DISTINCT FROM v_gen THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH002',
            MESSAGE = 'HSB_CONTROL_STAGE_FENCE_REJECTED: outage latch requires the exact '
                      || 'epoch and runtime generation';
  END IF;

  PERFORM set_config('hsb_control.transition_active', 'on', true);
  UPDATE hsb_control.stage_state
     SET stage = 'hold',
         stage_epoch = v_epoch + 1,
         entered_at = now()
   WHERE stage_id = 'singleton';
  PERFORM set_config('hsb_control.transition_active', 'off', true);

  INSERT INTO hsb_control.stage_transition_audit (
    from_stage, to_stage, guard, actor_label, actor_session, reason,
    stage_epoch, runtime_generation, via_narrow_outage
  ) VALUES (
    'activated', 'hold', 'runtime_outage_latch', p_actor, session_user, 'runtime outage latch',
    v_epoch + 1, v_gen, true
  );

  INSERT INTO hsb_control.control_audit (audit_kind, subject_key, detail, actor_label, actor_session, stage_at)
  VALUES ('stage_transition', 'stage_state:singleton', 'activated->hold', p_actor, session_user, 'hold');

  RETURN 'hold';
END
$$;

RESET ROLE;
