-- HSB Phase B control-plane foundation — Phase-1 payment-domain serialization primitive.
--
-- registries.payment_identity_lock_protocol:
--   global_lock_name  hsb-provider-payment-identity-v1
--   global_lock_kind  pg_advisory_xact_lock          (transaction scoped, never session scoped)
--   identity_order    (identity_kind, identity_id)
--   alias_rule        charge_to_payment_intent_immutable_insert_once
--   evidence_rule     append_only_with_separate_unique_consumption
--
-- Steps 1-5 of the protocol are implemented here (global transaction advisory lock,
-- materialise presented identities, lock identity rows in kind/id order, validate
-- immutable aliases, insert alias once). The closure/consumption/fulfillment steps
-- belong to a later slice and are intentionally absent rather than approximated.

\set ON_ERROR_STOP on

SET ROLE hsb_owner;

CREATE TABLE hsb_control.payment_identity (
  identity_kind hsb_control.identity_kind NOT NULL,
  identity_id   text NOT NULL CHECK (identity_id ~ '^[A-Za-z0-9_-]{1,255}$'),
  first_seen_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (identity_kind, identity_id)
);

COMMENT ON TABLE hsb_control.payment_identity IS
  'Opaque provider identity keys only (marker/candidate/session/PaymentIntent/charge). Never personal data.';

CREATE TABLE hsb_control.charge_alias (
  charge_id         text PRIMARY KEY CHECK (charge_id ~ '^[A-Za-z0-9_-]{1,255}$'),
  payment_intent_id text NOT NULL CHECK (payment_intent_id ~ '^[A-Za-z0-9_-]{1,255}$'),
  bound_at          timestamptz NOT NULL DEFAULT pg_catalog.now()
);

CREATE INDEX charge_alias_payment_intent_idx ON hsb_control.charge_alias (payment_intent_id);

-- charge_to_payment_intent_immutable_insert_once
CREATE TRIGGER charge_alias_immutable
  BEFORE UPDATE OR DELETE ON hsb_control.charge_alias
  FOR EACH ROW EXECUTE FUNCTION hsb_control.forbid_row_mutation();

-- ---------------------------------------------------------------------------
-- Deterministic lock identity.
--
-- md5 is used here purely as a stable name -> 64-bit slot mapping for the advisory
-- lock space. It is NOT a security primitive: nothing secret is hashed, and the
-- value is a public, fixed constant derived from the contract's global_lock_name.
-- The DO block below pins it, so the derivation and the documented constant can
-- never drift apart.
-- ---------------------------------------------------------------------------
CREATE FUNCTION hsb_control.payment_identity_lock_key()
RETURNS bigint
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path = pg_catalog, hsb_control, pg_temp
AS $$
  SELECT ('x' || pg_catalog.substr(pg_catalog.md5('hsb-provider-payment-identity-v1'), 1, 16))::bit(64)::bigint;
$$;

DO $do$
BEGIN
  IF hsb_control.payment_identity_lock_key() <> (-7866424830880951197)::bigint THEN
    RAISE EXCEPTION 'HSB_CONTROL_LOCK_KEY_DRIFT: derived advisory lock key does not match the pinned constant';
  END IF;
END
$do$;

-- Step 1: acquire_global_transaction_advisory_lock.
CREATE FUNCTION hsb_control.acquire_payment_identity_lock()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hsb_control, pg_temp
AS $$
DECLARE
  v_key bigint := hsb_control.payment_identity_lock_key();
BEGIN
  -- Transaction scoped by construction: released at COMMIT or ROLLBACK, never held
  -- past the transaction, and never releasable early by the caller.
  PERFORM pg_advisory_xact_lock(v_key);
  RETURN v_key;
END
$$;

-- Steps 2-3: materialize_presented_identities, lock_identity_rows_in_kind_id_order.
CREATE FUNCTION hsb_control.lock_payment_identities(
  p_identity_kinds hsb_control.identity_kind[],
  p_identity_ids   text[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hsb_control, pg_temp
AS $$
DECLARE
  v_count integer := 0;
  v_row   record;
BEGIN
  PERFORM hsb_control.assert_runtime_mutation_allowed('lock_payment_identities');

  IF p_identity_kinds IS NULL OR p_identity_ids IS NULL
     OR array_ndims(p_identity_kinds) IS DISTINCT FROM 1
     OR array_ndims(p_identity_ids) IS DISTINCT FROM 1
     OR cardinality(p_identity_kinds) NOT BETWEEN 1 AND 64
     OR cardinality(p_identity_kinds) <> cardinality(p_identity_ids) THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH008',
            MESSAGE = 'HSB_CONTROL_IDENTITY_INPUT_REJECTED: kinds and ids must be equal-length arrays of 1..64';
  END IF;

  PERFORM hsb_control.acquire_payment_identity_lock();

  INSERT INTO hsb_control.payment_identity (identity_kind, identity_id)
  SELECT presented.kind, presented.id
    FROM unnest(p_identity_kinds, p_identity_ids) AS presented(kind, id)
  ON CONFLICT (identity_kind, identity_id) DO NOTHING;

  -- Deterministic acquisition order removes the deadlock class entirely. The row
  -- locks are taken one at a time from an explicitly ordered loop rather than from
  -- a single `ORDER BY ... FOR UPDATE`, so the ordering is a property of this code
  -- and not of whichever plan the planner happens to choose.
  FOR v_row IN
    SELECT presented.kind AS identity_kind, presented.id AS identity_id
      FROM unnest(p_identity_kinds, p_identity_ids) AS presented(kind, id)
     GROUP BY presented.kind, presented.id
     ORDER BY presented.kind, presented.id
  LOOP
    PERFORM 1
       FROM hsb_control.payment_identity pi
      WHERE pi.identity_kind = v_row.identity_kind
        AND pi.identity_id = v_row.identity_id
        FOR UPDATE;
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END
$$;

-- Steps 4-5: validate_immutable_aliases, insert_alias_once.
CREATE FUNCTION hsb_control.bind_charge_alias(
  p_charge_id         text,
  p_payment_intent_id text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hsb_control, pg_temp
AS $$
DECLARE
  v_existing text;
BEGIN
  PERFORM hsb_control.assert_runtime_mutation_allowed('bind_charge_alias');

  IF p_charge_id IS NULL OR p_charge_id !~ '^[A-Za-z0-9_-]{1,255}$'
     OR p_payment_intent_id IS NULL OR p_payment_intent_id !~ '^[A-Za-z0-9_-]{1,255}$' THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH008',
            MESSAGE = 'HSB_CONTROL_IDENTITY_INPUT_REJECTED: charge and PaymentIntent ids must be opaque provider keys';
  END IF;

  PERFORM hsb_control.lock_payment_identities(
    ARRAY['charge', 'payment_intent']::hsb_control.identity_kind[],
    ARRAY[p_charge_id, p_payment_intent_id]
  );

  SELECT a.payment_intent_id INTO v_existing
    FROM hsb_control.charge_alias a
   WHERE a.charge_id = p_charge_id;

  IF FOUND THEN
    IF v_existing = p_payment_intent_id THEN
      RETURN v_existing;  -- insert-once is idempotent for the exact same alias
    END IF;
    RAISE EXCEPTION
      USING ERRCODE = 'ZH006',
            MESSAGE = 'HSB_CONTROL_ALIAS_IMMUTABLE: charge is already aliased to a different PaymentIntent';
  END IF;

  INSERT INTO hsb_control.charge_alias (charge_id, payment_intent_id)
  VALUES (p_charge_id, p_payment_intent_id);

  INSERT INTO hsb_control.control_audit (audit_kind, subject_key, detail, actor_label, actor_session, stage_at)
  VALUES ('charge_alias_bound', p_charge_id, p_payment_intent_id,
          'payment_domain', session_user, hsb_control.current_stage());

  RETURN p_payment_intent_id;
END
$$;

RESET ROLE;
