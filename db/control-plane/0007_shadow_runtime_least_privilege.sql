-- HSB Phase B control-plane foundation — least-privilege binding for the shadow
-- settlement runtime.
--
-- Additive only. Files 0001–0006 are the accepted foundation and are not
-- rewritten by this one. Everything here is either a single extra function grant
-- on an existing role, or a rebinding of a single EXTERNAL login that must
-- already exist. No role is added to the accepted set of seven, no credential of
-- any kind is minted or changed, and no object ownership moves.
--
-- Why hsb_webhook: the shadow settlement adapter runs inside the Stripe webhook
-- handler and records webhook evidence, so it belongs on the existing evidence
-- intake boundary. hsb_webhook is the narrowest role that can carry the call. It
-- holds no order lifecycle, no provider lifecycle, no stage machine, no worker
-- application, no backfill, and no direct table DML, so the shadow runtime can
-- reach evidence and nothing else.
--
-- hsb_app is deliberately preserved exactly as 0006 left it. It keeps
-- enqueue_projection and its whole order lifecycle surface for future code; the
-- only thing removed from it here is the one external login the shadow runtime
-- authenticates as.
--
-- This file changes no stage: it neither reads nor writes the stage singleton,
-- so whatever stage is in force before it is applied is still in force after.
-- Admission continues to depend on that singleton, which is managed
-- independently of this migration.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. Fail closed on the external login prerequisite.
--
-- This migration rebinds a login it does not own and must never bring into
-- existence: provisioning that identity belongs to the deployment, not to the
-- checked-in schema. If the expected login is absent the file aborts here,
-- before any grant is applied, so a clean apply can never be read as "the shadow
-- runtime was narrowed" when it was not.
-- ---------------------------------------------------------------------------
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_roles
     WHERE rolname = 'hsb_runtime_login'
       AND rolcanlogin
  ) THEN
    RAISE EXCEPTION
      USING ERRCODE = 'ZH009',
            MESSAGE = 'HSB_CONTROL_RUNTIME_LOGIN_ABSENT: the external login hsb_runtime_login '
                      || 'must already exist before 0007 is applied',
            HINT    = 'Provision the runtime login out of band, then re-apply this migration. '
                      || 'This file never mints an identity and never grants one a secret.';
  END IF;
END
$do$;

-- ---------------------------------------------------------------------------
-- 2. The one additional grant, applied as the schema owner.
--
-- Exactly one function is added to hsb_webhook, with its full argument list so
-- no overload is granted by accident. Nothing else about the role changes: it
-- stays NOLOGIN, it gains no table privilege, no schema CREATE, and no
-- membership.
-- ---------------------------------------------------------------------------
SET ROLE hsb_owner;

GRANT EXECUTE ON FUNCTION
  hsb_control.enqueue_projection(text, text, bigint, bytea, text) TO hsb_webhook;

RESET ROLE;

-- ---------------------------------------------------------------------------
-- 3. Rebind the external runtime login, widen-before-narrow.
--
-- Order matters. The membership that the runtime needs is granted first and the
-- one it must lose is revoked last, so re-applying this file — or applying it
-- while the runtime is live — never leaves a window in which the shadow path has
-- neither boundary.
--
-- The effective role is stored SERVER-SIDE, as a role-level default. A pooler
-- sits between the adapter and PostgreSQL and may drop, rewrite, or never
-- forward the connection's startup options, so an options-only binding is not
-- trusted to hold. With the default stored on the server, a session that arrives
-- carrying nothing at all still resolves to hsb_webhook.
--
-- Each statement is idempotent: re-applying this file is a no-op on an already
-- rebound login.
-- ---------------------------------------------------------------------------
GRANT hsb_webhook TO hsb_runtime_login;

ALTER ROLE hsb_runtime_login SET role TO hsb_webhook;

-- The narrowing itself. hsb_app survives for future order lifecycle code; only
-- this one login stops being a member of it.
REVOKE hsb_app FROM hsb_runtime_login;
