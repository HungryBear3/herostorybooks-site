-- HSB Phase B control-plane foundation — role and function boundaries.
--
-- registries.roles_and_function_grants:
--   public_execute             false
--   direct_table_dml_nonowner  false
--   drain_catch_up_item        hsb_backfill_only_verified_active_drain_closed_admission_designated_run
--   enter_hold_after_outage    hsb_app_only_activated_to_hold_exact_epoch_generation
--
-- Nothing below grants a login, a password, or a superuser attribute. Every role is
-- NOLOGIN; these are privilege boundaries, not credentials.

\set ON_ERROR_STOP on

SET ROLE hsb_owner;

-- ---------------------------------------------------------------------------
-- Deny by default
-- ---------------------------------------------------------------------------
REVOKE ALL ON SCHEMA hsb_control FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA hsb_control FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA hsb_control FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA hsb_control FROM PUBLIC;

ALTER DEFAULT PRIVILEGES FOR ROLE hsb_owner IN SCHEMA hsb_control
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE hsb_owner IN SCHEMA hsb_control
  REVOKE ALL ON TABLES FROM PUBLIC;

-- Schema visibility only. CREATE is deliberately withheld: no role but the owner
-- may add objects to this schema.
GRANT USAGE ON SCHEMA hsb_control
  TO hsb_app, hsb_webhook, hsb_worker, hsb_backfill, hsb_stage_admin, hsb_auditor;

-- ---------------------------------------------------------------------------
-- Readers. Stage visibility is safe for every role; the auditor additionally reads
-- the tables, which is not DML.
-- ---------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION hsb_control.current_stage()
  TO hsb_app, hsb_webhook, hsb_worker, hsb_backfill, hsb_stage_admin, hsb_auditor;
GRANT EXECUTE ON FUNCTION hsb_control.current_stage_fingerprint()
  TO hsb_app, hsb_webhook, hsb_worker, hsb_backfill, hsb_stage_admin, hsb_auditor;

GRANT SELECT ON ALL TABLES IN SCHEMA hsb_control TO hsb_auditor;

-- ---------------------------------------------------------------------------
-- hsb_stage_admin — stage machine and registry seeding only.
-- ---------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION
  hsb_control.request_stage_transition(hsb_control.stage, text, text, text)
  TO hsb_stage_admin;
GRANT EXECUTE ON FUNCTION
  hsb_control.register_source_identity(text, hsb_control.source_era)
  TO hsb_stage_admin;

-- ---------------------------------------------------------------------------
-- hsb_app — order lifecycle, the payment-identity lock, and the narrow outage latch.
-- ---------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION hsb_control.enter_hold_after_outage(bigint, bigint, text) TO hsb_app;
GRANT EXECUTE ON FUNCTION hsb_control.acquire_payment_identity_lock() TO hsb_app;
GRANT EXECUTE ON FUNCTION
  hsb_control.lock_payment_identities(hsb_control.identity_kind[], text[]) TO hsb_app;
GRANT EXECUTE ON FUNCTION hsb_control.bind_charge_alias(text, text) TO hsb_app;
GRANT EXECUTE ON FUNCTION hsb_control.open_order_control(text) TO hsb_app;
GRANT EXECUTE ON FUNCTION
  hsb_control.advance_order_state(text, hsb_control.order_state, text) TO hsb_app;
GRANT EXECUTE ON FUNCTION hsb_control.open_provider_phase(text, integer) TO hsb_app;
GRANT EXECUTE ON FUNCTION
  hsb_control.advance_provider_phase(text, integer, hsb_control.provider_phase, text) TO hsb_app;
GRANT EXECUTE ON FUNCTION
  hsb_control.enqueue_projection(text, text, bigint, bytea, text) TO hsb_app;

-- ---------------------------------------------------------------------------
-- hsb_webhook — durable receipt and evidence intake only. It can never advance the
-- stage, open an order, or settle a lease it does not hold.
-- ---------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION
  hsb_control.record_event_receipt(text, hsb_control.event_family, text) TO hsb_webhook;
GRANT EXECUTE ON FUNCTION
  hsb_control.record_provider_evidence(text, integer, hsb_control.evidence_class, hsb_control.event_family, text)
  TO hsb_webhook;
GRANT EXECUTE ON FUNCTION
  hsb_control.record_reversal_evidence(text, text, hsb_control.reversal_kind, bigint, text, text)
  TO hsb_webhook;
GRANT EXECUTE ON FUNCTION
  hsb_control.apply_dispute_evidence(text, text, hsb_control.dispute_state, text) TO hsb_webhook;
GRANT EXECUTE ON FUNCTION hsb_control.acquire_payment_identity_lock() TO hsb_webhook;
GRANT EXECUTE ON FUNCTION
  hsb_control.lock_payment_identities(hsb_control.identity_kind[], text[]) TO hsb_webhook;
GRANT EXECUTE ON FUNCTION hsb_control.bind_charge_alias(text, text) TO hsb_webhook;

-- ---------------------------------------------------------------------------
-- hsb_worker — lease settlement, reversal consumption, projection application.
-- ---------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION hsb_control.claim_event_lease(text, uuid, integer) TO hsb_worker;
GRANT EXECUTE ON FUNCTION
  hsb_control.settle_event_lease(text, uuid, hsb_control.event_processing_state) TO hsb_worker;
GRANT EXECUTE ON FUNCTION hsb_control.consume_reversal(text, text, text) TO hsb_worker;
GRANT EXECUTE ON FUNCTION hsb_control.apply_projection(text, text, bigint, uuid) TO hsb_worker;
GRANT EXECUTE ON FUNCTION hsb_control.acquire_payment_identity_lock() TO hsb_worker;
GRANT EXECUTE ON FUNCTION
  hsb_control.lock_payment_identities(hsb_control.identity_kind[], text[]) TO hsb_worker;

-- ---------------------------------------------------------------------------
-- hsb_backfill — immutable source revisions only.
-- ---------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION hsb_control.record_source_revision(text, text, text) TO hsb_backfill;
GRANT EXECUTE ON FUNCTION hsb_control.mark_source_revision_inert(text, text) TO hsb_backfill;

-- hsb_auditor receives no mutation function at all; SELECT above is its whole surface.

RESET ROLE;
