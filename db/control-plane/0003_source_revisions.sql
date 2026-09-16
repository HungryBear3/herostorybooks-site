-- HSB Phase B control-plane foundation — immutable source-revision substrate.
--
-- registries.backfill_revision_protocol:
--   input_registry            immutable_full_source_fact_rows
--   result_domain             append | noop | reject
--   canonical_row_order       (source_identity, source_version, source_digest)
--   append_cardinality        1
--   prior_rows_preserved_exactly  true
--   rollback                  mark_inert_never_delete_immutable_history
--
-- `reject` is materialised as a raised exception so the branch always fails closed
-- and can never be mistaken for a silent success. `append` and `noop` are returned.

\set ON_ERROR_STOP on

SET ROLE hsb_owner;

-- registries.legacy_source_facts.string_bounds / .enums.source_era
CREATE TABLE hsb_control.source_identity_registry (
  source_identity    text PRIMARY KEY
                       CHECK (pg_catalog.length(source_identity) BETWEEN 1 AND 256),
  source_era         hsb_control.source_era NOT NULL,
  canonical_adoption hsb_control.canonical_adoption NOT NULL DEFAULT 'none',
  registered_at      timestamptz NOT NULL DEFAULT pg_catalog.now()
);

COMMENT ON TABLE hsb_control.source_identity_registry IS
  'Known legacy source identities. Opaque keys only; never personal data.';

CREATE TRIGGER source_identity_registry_immutable
  BEFORE UPDATE OR DELETE ON hsb_control.source_identity_registry
  FOR EACH ROW EXECUTE FUNCTION hsb_control.forbid_row_mutation();

-- registries.legacy_source_facts.digest_pattern
CREATE TABLE hsb_control.source_revision (
  revision_seq    bigint GENERATED ALWAYS AS IDENTITY,
  source_identity text NOT NULL
                    REFERENCES hsb_control.source_identity_registry (source_identity)
                    ON DELETE RESTRICT ON UPDATE RESTRICT,
  source_version  text NOT NULL CHECK (pg_catalog.length(source_version) BETWEEN 1 AND 128),
  source_digest   text NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  -- Rollback marks a revision inert. History is never deleted or rewritten.
  inert           boolean NOT NULL DEFAULT false,
  recorded_at     timestamptz NOT NULL DEFAULT pg_catalog.now(),
  PRIMARY KEY (source_identity, source_version)
);

-- Same identity + unchanged bytes under a new version cannot exist.
CREATE UNIQUE INDEX source_revision_identity_digest_uniq
  ON hsb_control.source_revision (source_identity, source_digest);

CREATE UNIQUE INDEX source_revision_seq_uniq
  ON hsb_control.source_revision (revision_seq);

CREATE INDEX source_revision_canonical_order_idx
  ON hsb_control.source_revision (source_identity, source_version, source_digest);

-- registries.backfill_revision_protocol.canonical_row_order
CREATE VIEW hsb_control.source_revision_canonical AS
  SELECT r.source_identity, r.source_version, r.source_digest, r.inert,
         r.revision_seq, r.recorded_at
    FROM hsb_control.source_revision r
   ORDER BY r.source_identity, r.source_version, r.source_digest;

CREATE FUNCTION hsb_control.enforce_source_revision_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hsb_control, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH007',
            MESSAGE = 'HSB_CONTROL_IMMUTABLE_ROW: source_revision history is never deleted';
  END IF;

  IF NEW.source_identity IS DISTINCT FROM OLD.source_identity
     OR NEW.source_version IS DISTINCT FROM OLD.source_version
     OR NEW.source_digest IS DISTINCT FROM OLD.source_digest
     OR NEW.revision_seq IS DISTINCT FROM OLD.revision_seq
     OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH007',
            MESSAGE = 'HSB_CONTROL_IMMUTABLE_ROW: source_revision identity and digest are immutable';
  END IF;

  IF OLD.inert AND NOT NEW.inert THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH007',
            MESSAGE = 'HSB_CONTROL_IMMUTABLE_ROW: an inert revision is never revived';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER source_revision_immutable
  BEFORE UPDATE OR DELETE ON hsb_control.source_revision
  FOR EACH ROW EXECUTE FUNCTION hsb_control.enforce_source_revision_immutability();

-- ---------------------------------------------------------------------------
-- Registry seeding. Explicitly available while the stage is `off`: it creates no
-- runtime order, provider, or payment state.
-- ---------------------------------------------------------------------------
CREATE FUNCTION hsb_control.register_source_identity(
  p_source_identity text,
  p_source_era      hsb_control.source_era
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hsb_control, pg_temp
AS $$
DECLARE
  v_existing hsb_control.source_era;
BEGIN
  IF p_source_identity IS NULL OR length(p_source_identity) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH003',
            MESSAGE = 'HSB_CONTROL_REVISION_REJECT:malformed_observed_source_fact: '
                      || 'source_identity must be 1..256 characters';
  END IF;

  SELECT g.source_era INTO v_existing
    FROM hsb_control.source_identity_registry g
   WHERE g.source_identity = p_source_identity;

  IF FOUND THEN
    IF v_existing IS DISTINCT FROM p_source_era THEN
      RAISE EXCEPTION
        USING ERRCODE = 'ZH003',
              MESSAGE = 'HSB_CONTROL_REVISION_REJECT:immutable_revision_overwrite: '
                        || 'source identity era is immutable';
    END IF;
    RETURN false;
  END IF;

  INSERT INTO hsb_control.source_identity_registry (source_identity, source_era)
  VALUES (p_source_identity, p_source_era);

  INSERT INTO hsb_control.control_audit (audit_kind, subject_key, detail, actor_label, actor_session, stage_at)
  VALUES ('source_identity_registered', p_source_identity, p_source_era::text,
          'stage_admin', session_user, hsb_control.current_stage());

  RETURN true;
END
$$;

-- ---------------------------------------------------------------------------
-- The append/noop/reject transition table.
-- ---------------------------------------------------------------------------
CREATE FUNCTION hsb_control.record_source_revision(
  p_source_identity text,
  p_source_version  text,
  p_source_digest   text
)
RETURNS hsb_control.revision_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hsb_control, pg_temp
AS $$
DECLARE
  v_prior_digest text;
  v_other_version text;
  v_bad_priors bigint;
  v_appended bigint;
BEGIN
  -- 1. malformed_observed_source_fact
  IF p_source_identity IS NULL OR length(p_source_identity) NOT BETWEEN 1 AND 256 THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH003',
            MESSAGE = 'HSB_CONTROL_REVISION_REJECT:malformed_observed_source_fact: source_identity';
  END IF;
  IF p_source_version IS NULL OR length(p_source_version) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH003',
            MESSAGE = 'HSB_CONTROL_REVISION_REJECT:malformed_observed_source_fact: source_version';
  END IF;
  IF p_source_digest IS NULL OR p_source_digest !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH003',
            MESSAGE = 'HSB_CONTROL_REVISION_REJECT:malformed_observed_source_fact: source_digest';
  END IF;

  -- 2. unknown_source_identity. Locking the registry row serialises concurrent
  --    observations of the same identity, so `append_cardinality: 1` holds.
  PERFORM 1
     FROM hsb_control.source_identity_registry g
    WHERE g.source_identity = p_source_identity
      FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH003',
            MESSAGE = 'HSB_CONTROL_REVISION_REJECT:unknown_source_identity: '
                      || 'identity is not in the immutable input registry';
  END IF;

  -- 3. malformed_prior_row / duplicate_prior_revision_key. Constraints make these
  --    unreachable; the protocol still requires the input registry to be proven
  --    well-formed before a revision decision is taken.
  SELECT count(*) INTO v_bad_priors
    FROM hsb_control.source_revision r
   WHERE r.source_identity = p_source_identity
     AND (r.source_digest !~ '^[0-9a-f]{64}$'
          OR length(r.source_version) NOT BETWEEN 1 AND 128);
  IF v_bad_priors > 0 THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH003',
            MESSAGE = 'HSB_CONTROL_REVISION_REJECT:malformed_prior_row';
  END IF;

  SELECT count(*) INTO v_bad_priors
    FROM (
      SELECT 1
        FROM hsb_control.source_revision r
       WHERE r.source_identity = p_source_identity
       GROUP BY r.source_identity, r.source_version
      HAVING count(*) > 1
    ) duplicated;
  IF v_bad_priors > 0 THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH003',
            MESSAGE = 'HSB_CONTROL_REVISION_REJECT:duplicate_prior_revision_key';
  END IF;

  SELECT r.source_digest INTO v_prior_digest
    FROM hsb_control.source_revision r
   WHERE r.source_identity = p_source_identity
     AND r.source_version = p_source_version;

  IF FOUND THEN
    -- same_identity_same_version_same_digest -> noop
    IF v_prior_digest = p_source_digest THEN
      RETURN 'noop';
    END IF;
    -- same_identity_same_version_changed_digest -> reject
    RAISE EXCEPTION
      USING ERRCODE = 'ZH003',
            MESSAGE = 'HSB_CONTROL_REVISION_REJECT:immutable_revision_overwrite';
  END IF;

  -- same_identity_new_version_unchanged_digest -> reject
  SELECT r.source_version INTO v_other_version
    FROM hsb_control.source_revision r
   WHERE r.source_identity = p_source_identity
     AND r.source_digest = p_source_digest;
  IF FOUND THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH003',
            MESSAGE = 'HSB_CONTROL_REVISION_REJECT:unchanged_bytes_new_revision';
  END IF;

  -- same_identity_new_version_changed_digest -> append exactly one
  INSERT INTO hsb_control.source_revision (source_identity, source_version, source_digest)
  VALUES (p_source_identity, p_source_version, p_source_digest);
  GET DIAGNOSTICS v_appended = ROW_COUNT;
  IF v_appended <> 1 THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH003',
            MESSAGE = 'HSB_CONTROL_REVISION_REJECT:append_cardinality';
  END IF;

  INSERT INTO hsb_control.control_audit (audit_kind, subject_key, detail, actor_label, actor_session, stage_at)
  VALUES ('source_revision_appended', p_source_identity, p_source_version,
          'backfill', session_user, hsb_control.current_stage());

  RETURN 'append';
END
$$;

-- registries.backfill_revision_protocol.rollback
CREATE FUNCTION hsb_control.mark_source_revision_inert(
  p_source_identity text,
  p_source_version  text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, hsb_control, pg_temp
AS $$
DECLARE
  v_updated bigint;
BEGIN
  UPDATE hsb_control.source_revision
     SET inert = true
   WHERE source_identity = p_source_identity
     AND source_version = p_source_version
     AND NOT inert;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  IF v_updated > 0 THEN
    INSERT INTO hsb_control.control_audit (audit_kind, subject_key, detail, actor_label, actor_session, stage_at)
    VALUES ('source_revision_inert', p_source_identity, p_source_version,
            'backfill', session_user, hsb_control.current_stage());
  END IF;

  RETURN v_updated > 0;
END
$$;

RESET ROLE;
