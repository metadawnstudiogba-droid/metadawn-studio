-- Run on the direct Neon owner connection inside a transaction.
-- The caller must set seedance.runtime_password transaction-locally through a
-- bound parameter over verified TLS, after checking database logging settings.
-- Neon requires the raw password (not a prehashed verifier). Never put it in argv,
-- source, reports, or application logs.
DO $$
DECLARE
  runtime pg_roles%ROWTYPE;
  runtime_password text;
BEGIN
  SELECT * INTO runtime FROM pg_roles WHERE rolname = 'seedance_runtime';

  IF FOUND THEN
    IF NOT runtime.rolcanlogin
       OR runtime.rolsuper
       OR runtime.rolbypassrls
       OR runtime.rolcreatedb
       OR runtime.rolcreaterole
       OR runtime.rolreplication
       OR runtime.rolinherit
       OR EXISTS (
         SELECT 1 FROM pg_auth_members WHERE member = runtime.oid
       ) THEN
      RAISE EXCEPTION 'Existing seedance_runtime role is unsafe; remove it explicitly before recreating it.';
    END IF;
    RETURN;
  END IF;

  runtime_password := current_setting('seedance.runtime_password', true);
  IF runtime_password IS NULL OR runtime_password !~ '^[A-Za-z0-9_-]{43}$' THEN
    RAISE EXCEPTION 'A transaction-local randomly generated password is required to create seedance_runtime.';
  END IF;

  EXECUTE format(
    'CREATE ROLE seedance_runtime LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT PASSWORD %L',
    runtime_password
  );
  PERFORM set_config('seedance.runtime_password', '', true);
END $$;
