-- Run db/create-runtime-role.sql first, then run this file on the direct Neon
-- owner connection. With psql, the caller must enable ON_ERROR_STOP. This file
-- is pure SQL and atomic, so pg clients can execute it as one migration.
-- Run db/finalize-bootstrap.sql only after the administrator verifies their email.
BEGIN;

DO $$
DECLARE runtime pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO runtime FROM pg_roles WHERE rolname = 'seedance_runtime';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'seedance_runtime does not exist.';
  END IF;
  IF NOT runtime.rolcanlogin
     OR runtime.rolsuper
     OR runtime.rolbypassrls
     OR runtime.rolcreatedb
     OR runtime.rolcreaterole
     OR runtime.rolreplication
     OR runtime.rolinherit
     OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member = runtime.oid) THEN
    RAISE EXCEPTION 'seedance_runtime does not satisfy the required safe role attributes.';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "user" (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  "emailVerified" BOOLEAN NOT NULL DEFAULT FALSE, image TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS "session" (
  id TEXT PRIMARY KEY, "expiresAt" TIMESTAMPTZ NOT NULL, token TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "ipAddress" TEXT, "userAgent" TEXT, "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS session_user_id_idx ON "session" ("userId");
CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY, issuer TEXT NOT NULL, "accountId" TEXT NOT NULL, "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "accessToken" TEXT, "refreshToken" TEXT, "idToken" TEXT, "accessTokenExpiresAt" TIMESTAMPTZ,
  "refreshTokenExpiresAt" TIMESTAMPTZ, scope TEXT, password TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (issuer, "accountId")
);
CREATE INDEX IF NOT EXISTS account_user_id_idx ON account ("userId");
CREATE TABLE IF NOT EXISTS verification (
  id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL, "expiresAt" TIMESTAMPTZ NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(), "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification (identifier);

CREATE TABLE IF NOT EXISTS studio_assets (
  id TEXT PRIMARY KEY, user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  name TEXT NOT NULL, type TEXT NOT NULL CHECK (type IN ('image', 'video', 'audio')),
  purpose TEXT NOT NULL DEFAULT '', source_url TEXT NOT NULL, provider_asset_id TEXT,
  provider_status TEXT NOT NULL DEFAULT 'unregistered', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS studio_generations (
  id TEXT PRIMARY KEY, user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  provider_task_id TEXT UNIQUE, mode TEXT NOT NULL, model TEXT NOT NULL, prompt TEXT NOT NULL,
  request_json JSONB NOT NULL, status TEXT NOT NULL, parent_generation_id TEXT,
  provider_video_url TEXT, saved_video_url TEXT, error_message TEXT, usage_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS studio_provider_settings (
  id TEXT PRIMARY KEY, user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  encrypted_token TEXT NOT NULL, base_url TEXT NOT NULL, model TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS studio_storage_settings (
  user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL, bucket TEXT NOT NULL,
  jurisdiction TEXT NOT NULL CHECK (jurisdiction IN ('default', 'eu', 'us', 'fedramp')),
  encrypted_credentials TEXT, namespace TEXT NOT NULL, state TEXT NOT NULL,
  verified_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, bucket, jurisdiction)
);

ALTER TABLE studio_assets ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE;
ALTER TABLE studio_generations ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE;
ALTER TABLE studio_provider_settings ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE;
ALTER TABLE studio_provider_settings ADD COLUMN IF NOT EXISTS adapter_config JSONB;
ALTER TABLE studio_provider_settings ADD COLUMN IF NOT EXISTS encrypted_credentials TEXT;
ALTER TABLE studio_provider_settings ADD COLUMN IF NOT EXISTS provider_binding_id TEXT;
ALTER TABLE studio_assets ADD COLUMN IF NOT EXISTS provider_binding_id TEXT;
ALTER TABLE studio_assets ADD COLUMN IF NOT EXISTS registration_started_at TIMESTAMPTZ;
ALTER TABLE studio_generations ADD COLUMN IF NOT EXISTS provider_binding_id TEXT;
ALTER TABLE studio_generations ADD COLUMN IF NOT EXISTS provider_snapshot JSONB;
ALTER TABLE studio_generations ADD COLUMN IF NOT EXISTS archive_lease_until TIMESTAMPTZ;

-- Existing records keep their original KKIDC account binding. This migration
-- changes no ciphertext and preserves every asset, task and storage setting.
UPDATE studio_provider_settings SET provider_binding_id='legacy:' || user_id::text WHERE provider_binding_id IS NULL AND user_id IS NOT NULL;
UPDATE studio_assets SET provider_binding_id='legacy:' || user_id::text WHERE provider_binding_id IS NULL AND provider_asset_id IS NOT NULL AND user_id IS NOT NULL;
UPDATE studio_generations SET provider_binding_id='legacy:' || user_id::text WHERE provider_binding_id IS NULL AND user_id IS NOT NULL;
ALTER TABLE studio_generations DROP CONSTRAINT IF EXISTS studio_generations_provider_task_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS studio_generations_provider_task_tenant_idx
  ON studio_generations (user_id, provider_binding_id, provider_task_id);
DROP INDEX IF EXISTS studio_provider_settings_user_idx;

DO $$
DECLARE
  user_column smallint;
  generation_key smallint[];
  parent_key smallint[];
  composite_fk text;
  old_fk record;
BEGIN
  SELECT attnum INTO user_column
  FROM pg_attribute
  WHERE attrelid = 'public.studio_provider_settings'::regclass
    AND attname = 'user_id' AND NOT attisdropped;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.studio_provider_settings'::regclass
      AND contype = 'u'
      AND conkey = ARRAY[user_column]::smallint[]
      AND NOT condeferrable
      AND convalidated
  ) THEN
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.studio_provider_settings'::regclass
        AND conname = 'studio_provider_settings_user_key'
    ) THEN
      RAISE EXCEPTION 'studio_provider_settings_user_key exists with unexpected columns or properties.';
    END IF;
    ALTER TABLE public.studio_provider_settings
      ADD CONSTRAINT studio_provider_settings_user_key UNIQUE (user_id) NOT DEFERRABLE;
  END IF;

  SELECT ARRAY[user_att.attnum, id_att.attnum]::smallint[]
  INTO generation_key
  FROM pg_attribute user_att, pg_attribute id_att
  WHERE user_att.attrelid = 'public.studio_generations'::regclass
    AND user_att.attname = 'user_id' AND NOT user_att.attisdropped
    AND id_att.attrelid = 'public.studio_generations'::regclass
    AND id_att.attname = 'id' AND NOT id_att.attisdropped;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.studio_generations'::regclass
      AND contype = 'u'
      AND conkey = generation_key
      AND NOT condeferrable
      AND convalidated
  ) THEN
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.studio_generations'::regclass
        AND conname = 'studio_generations_user_id_id_key'
    ) THEN
      RAISE EXCEPTION 'studio_generations_user_id_id_key exists with unexpected columns or properties.';
    END IF;
    ALTER TABLE public.studio_generations
      ADD CONSTRAINT studio_generations_user_id_id_key UNIQUE (user_id, id) NOT DEFERRABLE;
  END IF;

  SELECT ARRAY[user_att.attnum, parent_att.attnum]::smallint[]
  INTO parent_key
  FROM pg_attribute user_att, pg_attribute parent_att
  WHERE user_att.attrelid = 'public.studio_generations'::regclass
    AND user_att.attname = 'user_id' AND NOT user_att.attisdropped
    AND parent_att.attrelid = 'public.studio_generations'::regclass
    AND parent_att.attname = 'parent_generation_id' AND NOT parent_att.attisdropped;

  SELECT conname INTO composite_fk
  FROM pg_constraint
  WHERE conrelid = 'public.studio_generations'::regclass
    AND confrelid = 'public.studio_generations'::regclass
    AND contype = 'f'
    AND conkey = parent_key
    AND confkey = generation_key
    AND NOT condeferrable
  ORDER BY convalidated DESC, oid
  LIMIT 1;

  IF composite_fk IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.studio_generations'::regclass
        AND conname = 'studio_generations_parent_tenant_fkey'
    ) THEN
      RAISE EXCEPTION 'studio_generations_parent_tenant_fkey exists with unexpected columns or properties.';
    END IF;
    ALTER TABLE public.studio_generations
      ADD CONSTRAINT studio_generations_parent_tenant_fkey
      FOREIGN KEY (user_id, parent_generation_id)
      REFERENCES public.studio_generations (user_id, id)
      NOT DEFERRABLE NOT VALID;
    composite_fk := 'studio_generations_parent_tenant_fkey';
  END IF;

  EXECUTE format(
    'ALTER TABLE public.studio_generations VALIDATE CONSTRAINT %I',
    composite_fk
  );

  FOR old_fk IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.studio_generations'::regclass
      AND confrelid = 'public.studio_generations'::regclass
      AND contype = 'f'
      AND conkey = ARRAY[parent_key[2]]::smallint[]
      AND confkey = ARRAY[generation_key[2]]::smallint[]
  LOOP
    EXECUTE format(
      'ALTER TABLE public.studio_generations DROP CONSTRAINT %I',
      old_fk.conname
    );
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS studio_assets_user_idx ON studio_assets (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS studio_generations_user_idx ON studio_generations (user_id, created_at ASC);
CREATE INDEX IF NOT EXISTS studio_generations_status_idx ON studio_generations(status);

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM seedance_runtime;
GRANT USAGE ON SCHEMA public TO seedance_runtime;
REVOKE ALL PRIVILEGES ON "user", "session", account, verification,
  studio_assets, studio_generations, studio_provider_settings, studio_storage_settings
  FROM PUBLIC, seedance_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON "user", "session", account, verification TO seedance_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON studio_assets, studio_generations,
  studio_provider_settings, studio_storage_settings TO seedance_runtime;

DO $$
DECLARE
  table_name text;
  column_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'studio_assets', 'studio_generations',
    'studio_provider_settings', 'studio_storage_settings'
  ] LOOP
    FOR column_name IN
      SELECT attname
      FROM pg_attribute
      WHERE attrelid = format('public.%I', table_name)::regclass
        AND attnum > 0 AND NOT attisdropped
    LOOP
      EXECUTE format(
        'REVOKE REFERENCES (%I) ON TABLE public.%I FROM PUBLIC, seedance_runtime',
        column_name, table_name
      );
    END LOOP;
  END LOOP;
END $$;

ALTER TABLE studio_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_provider_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_storage_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_assets FORCE ROW LEVEL SECURITY;
ALTER TABLE studio_generations FORCE ROW LEVEL SECURITY;
ALTER TABLE studio_provider_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE studio_storage_settings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS studio_assets_owner ON studio_assets;
DROP POLICY IF EXISTS studio_generations_owner ON studio_generations;
DROP POLICY IF EXISTS studio_provider_settings_owner ON studio_provider_settings;
DROP POLICY IF EXISTS studio_storage_settings_owner ON studio_storage_settings;

DO $$
DECLARE
  table_name text;
  auth_user_type oid;
  tenant_type oid;
  tenant_type_count integer;
  tenant_column_count integer;
  tenant_value text;
BEGIN
  SELECT atttypid INTO auth_user_type
  FROM pg_attribute
  WHERE attrelid = 'public."user"'::regclass
    AND attname = 'id' AND NOT attisdropped;

  SELECT MIN(atttypid::integer)::oid, COUNT(DISTINCT atttypid), COUNT(*)
  INTO tenant_type, tenant_type_count, tenant_column_count
  FROM pg_attribute
  WHERE attrelid IN (
      'public.studio_assets'::regclass,
      'public.studio_generations'::regclass,
      'public.studio_provider_settings'::regclass,
      'public.studio_storage_settings'::regclass
    )
    AND attname = 'user_id'
    AND NOT attisdropped;

  IF auth_user_type IS NULL
     OR tenant_type IS NULL
     OR tenant_column_count <> 4
     OR tenant_type_count <> 1
     OR tenant_type <> auth_user_type THEN
    RAISE EXCEPTION 'All tenant user_id columns must share the auth user id type.';
  END IF;

  IF tenant_type = 'text'::regtype THEN
    tenant_value := 'NULLIF(current_setting(''app.user_id'', true), '''')';
  ELSIF tenant_type = 'uuid'::regtype THEN
    tenant_value := 'NULLIF(current_setting(''app.user_id'', true), '''')::uuid';
  ELSE
    RAISE EXCEPTION 'Unsupported tenant user_id type: %', tenant_type::regtype;
  END IF;

  FOREACH table_name IN ARRAY ARRAY[
    'studio_assets', 'studio_generations',
    'studio_provider_settings', 'studio_storage_settings'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO seedance_runtime USING (user_id = %s) WITH CHECK (user_id = %s)',
      table_name || '_owner', table_name, tenant_value, tenant_value
    );
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS public.seedance_pending_generation_refs(integer);

DO $$
DECLARE
  runtime_oid oid;
  expected_tables constant text[] := ARRAY[
    'user', 'session', 'account', 'verification',
    'studio_assets', 'studio_generations',
    'studio_provider_settings', 'studio_storage_settings'
  ];
BEGIN
  SELECT oid INTO runtime_oid FROM pg_roles WHERE rolname = 'seedance_runtime';

  IF has_schema_privilege('seedance_runtime', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'seedance_runtime must not have CREATE on schema public.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE relowner = runtime_oid
      AND oid IN (
        'public.studio_assets'::regclass,
        'public.studio_generations'::regclass,
        'public.studio_provider_settings'::regclass,
        'public.studio_storage_settings'::regclass
      )
  ) THEN
    RAISE EXCEPTION 'seedance_runtime must not own tenant tables.';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM unnest(expected_tables) AS expected(table_name)
    WHERE NOT (
      has_table_privilege('seedance_runtime', format('public.%I', expected.table_name), 'SELECT')
      AND has_table_privilege('seedance_runtime', format('public.%I', expected.table_name), 'INSERT')
      AND has_table_privilege('seedance_runtime', format('public.%I', expected.table_name), 'UPDATE')
      AND has_table_privilege('seedance_runtime', format('public.%I', expected.table_name), 'DELETE')
    )
  ) THEN
    RAISE EXCEPTION 'seedance_runtime is missing required CRUD privileges.';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_class relation
    WHERE relation.oid IN (
        'public.studio_assets'::regclass,
        'public.studio_generations'::regclass,
        'public.studio_provider_settings'::regclass,
        'public.studio_storage_settings'::regclass
      )
      AND (
        has_table_privilege('seedance_runtime', relation.oid, 'TRUNCATE')
        OR has_table_privilege('seedance_runtime', relation.oid, 'REFERENCES')
        OR has_table_privilege('seedance_runtime', relation.oid, 'TRIGGER')
      )
  ) THEN
    RAISE EXCEPTION 'seedance_runtime has a forbidden tenant-table privilege.';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_attribute attribute
    WHERE attribute.attrelid IN (
        'public.studio_assets'::regclass,
        'public.studio_generations'::regclass,
        'public.studio_provider_settings'::regclass,
        'public.studio_storage_settings'::regclass
      )
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND has_column_privilege(
        'seedance_runtime', attribute.attrelid, attribute.attnum, 'REFERENCES'
      )
  ) THEN
    RAISE EXCEPTION 'seedance_runtime has a forbidden column REFERENCES privilege.';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM information_schema.role_table_grants
    WHERE grantee = 'seedance_runtime'
      AND table_schema = 'public'
      AND (
        table_name <> ALL(expected_tables)
        OR privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
      )
  ) THEN
    RAISE EXCEPTION 'seedance_runtime has an unexpected direct table grant.';
  END IF;
  IF (
    SELECT COUNT(*)
    FROM pg_class relation
    WHERE relation.oid IN (
        'public.studio_assets'::regclass,
        'public.studio_generations'::regclass,
        'public.studio_provider_settings'::regclass,
        'public.studio_storage_settings'::regclass
      )
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
  ) <> 4 THEN
    RAISE EXCEPTION 'All four tenant tables must enable and force RLS.';
  END IF;
  IF (
    SELECT COUNT(*)
    FROM pg_policy policy
    WHERE policy.polrelid IN (
        'public.studio_assets'::regclass,
        'public.studio_generations'::regclass,
        'public.studio_provider_settings'::regclass,
        'public.studio_storage_settings'::regclass
      )
  ) <> 4 OR (
    SELECT COUNT(*)
    FROM pg_policy policy
    WHERE policy.polrelid IN (
        'public.studio_assets'::regclass,
        'public.studio_generations'::regclass,
        'public.studio_provider_settings'::regclass,
        'public.studio_storage_settings'::regclass
      )
      AND policy.polcmd = '*'
      AND policy.polroles = ARRAY[runtime_oid]::oid[]
      AND policy.polqual IS NOT NULL
      AND policy.polwithcheck IS NOT NULL
  ) <> 4 THEN
    RAISE EXCEPTION 'All four tenant tables require only the runtime USING and WITH CHECK policies.';
  END IF;
  IF to_regprocedure('public.seedance_pending_generation_refs(integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'The cross-tenant pending-generation function must not exist.';
  END IF;
END $$;

COMMIT;
