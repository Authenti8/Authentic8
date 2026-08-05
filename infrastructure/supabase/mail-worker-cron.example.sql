-- Copy this file into Supabase SQL Editor before replacing placeholders.
-- Never save or commit the real CRON_SECRET in this repository file.

CREATE EXTENSION IF NOT EXISTS PG_CRON;

CREATE EXTENSION IF NOT EXISTS PG_NET WITH SCHEMA EXTENSIONS;

DO $VAULT_SETUP$

DECLARE
  SECRET_ID UUID;
BEGIN
  SELECT
    ID INTO SECRET_ID
  FROM
    VAULT.SECRETS
  WHERE
    NAME = 'authenti8_api_origin';
  IF SECRET_ID IS NULL THEN
    PERFORM VAULT.CREATE_SECRET( 'https://authentic8-api.vercel.app', 'authenti8_api_origin' );
  ELSE
    PERFORM VAULT.UPDATE_SECRET( SECRET_ID, 'https://authentic8-api.vercel.app', 'authenti8_api_origin' );
  END IF;

  SELECT
    ID INTO SECRET_ID
  FROM
    VAULT.SECRETS
  WHERE
    NAME = 'authenti8_mail_worker_secret';
  IF SECRET_ID IS NULL THEN
    PERFORM VAULT.CREATE_SECRET( 'YOUR-ROTATED-CRON-SECRET', 'authenti8_mail_worker_secret' );
  ELSE
    PERFORM VAULT.UPDATE_SECRET( SECRET_ID, 'YOUR-ROTATED-CRON-SECRET', 'authenti8_mail_worker_secret' );
  END IF;
END;
$VAULT_SETUP$;

CREATE OR REPLACE FUNCTION PUBLIC.AUTHENTI8_INVOKE_MAIL_WORKER() RETURNS BIGINT LANGUAGE SQL SECURITY DEFINER SET SEARCH_PATH = PUBLIC, VAULT, NET AS $MAIL_WORKER$
SELECT
  NET.HTTP_POST( URL := (
    SELECT
      DECRYPTED_SECRET
    FROM
      VAULT.DECRYPTED_SECRETS
    WHERE
      NAME = 'authenti8_api_origin'
  ) || '/v1/internal/mail/drain',
  HEADERS := JSONB_BUILD_OBJECT( 'Content-Type',
  'application/json',
  'Authorization',
  'Bearer ' || (
    SELECT
      DECRYPTED_SECRET
    FROM
      VAULT.DECRYPTED_SECRETS
    WHERE
      NAME = 'authenti8_mail_worker_secret'
  ) ),
  BODY := '{}'::JSONB,
  TIMEOUT_MILLISECONDS := 90000 );
$MAIL_WORKER$;
REVOKE ALL ON FUNCTION PUBLIC.AUTHENTI8_INVOKE_MAIL_WORKER() FROM PUBLIC, ANON, AUTHENTICATED, SERVICE_ROLE;
SELECT
  CRON.SCHEDULE( 'authenti8-mail-worker',
  '10 seconds',
  'SELECT public.authenti8_invoke_mail_worker();' );

-- pg_cron does not prune execution history automatically. Keep enough history
-- for operational debugging without allowing this high-frequency job to grow
-- cron.job_run_details indefinitely.
SELECT
  CRON.SCHEDULE( 'authenti8-cron-history-cleanup',
  '0 3 * * *',
  'DELETE FROM cron.job_run_details WHERE end_time < now() - interval ''7 days'';' );
