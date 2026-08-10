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
    PERFORM VAULT.CREATE_SECRET( 'https://YOUR-VERCEL-DOMAIN', 'authenti8_api_origin' );
  ELSE
    PERFORM VAULT.UPDATE_SECRET( SECRET_ID, 'https://YOUR-VERCEL-DOMAIN', 'authenti8_api_origin' );
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
  ) || '/api/v1/internal/mail/drain',
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

CREATE OR REPLACE FUNCTION PUBLIC.AUTHENTI8_RENEW_CALENDAR_CHANNELS() RETURNS BIGINT LANGUAGE SQL SECURITY DEFINER SET SEARCH_PATH = PUBLIC, VAULT, NET AS $CALENDAR_RENEWAL$
SELECT
  NET.HTTP_POST( URL := (
    SELECT DECRYPTED_SECRET FROM VAULT.DECRYPTED_SECRETS
    WHERE NAME = 'authenti8_api_origin'
  ) || '/api/v1/internal/integrations/renew',
  HEADERS := JSONB_BUILD_OBJECT( 'Content-Type', 'application/json', 'Authorization',
    'Bearer ' || (
      SELECT DECRYPTED_SECRET FROM VAULT.DECRYPTED_SECRETS
      WHERE NAME = 'authenti8_mail_worker_secret'
    ) ),
  BODY := '{}'::JSONB,
  TIMEOUT_MILLISECONDS := 90000 );
$CALENDAR_RENEWAL$;
REVOKE ALL ON FUNCTION PUBLIC.AUTHENTI8_RENEW_CALENDAR_CHANNELS() FROM PUBLIC, ANON, AUTHENTICATED, SERVICE_ROLE;

CREATE OR REPLACE FUNCTION PUBLIC.AUTHENTI8_PROCESS_CALENDAR_SYNCS() RETURNS BIGINT LANGUAGE SQL SECURITY DEFINER SET SEARCH_PATH = PUBLIC, VAULT, NET AS $CALENDAR_SYNC$
SELECT
  NET.HTTP_POST( URL := (
    SELECT DECRYPTED_SECRET FROM VAULT.DECRYPTED_SECRETS
    WHERE NAME = 'authenti8_api_origin'
  ) || '/api/v1/internal/integrations/sync',
  HEADERS := JSONB_BUILD_OBJECT( 'Content-Type', 'application/json', 'Authorization',
    'Bearer ' || (
      SELECT DECRYPTED_SECRET FROM VAULT.DECRYPTED_SECRETS
      WHERE NAME = 'authenti8_mail_worker_secret'
    ) ),
  BODY := '{}'::JSONB,
  TIMEOUT_MILLISECONDS := 90000 );
$CALENDAR_SYNC$;
REVOKE ALL ON FUNCTION PUBLIC.AUTHENTI8_PROCESS_CALENDAR_SYNCS() FROM PUBLIC, ANON, AUTHENTICATED, SERVICE_ROLE;

CREATE OR REPLACE FUNCTION PUBLIC.AUTHENTI8_PROCESS_BILLING_WEBHOOKS() RETURNS BIGINT LANGUAGE SQL SECURITY DEFINER SET SEARCH_PATH = PUBLIC, VAULT, NET AS $BILLING_WEBHOOKS$
SELECT
  NET.HTTP_POST( URL := (
    SELECT DECRYPTED_SECRET FROM VAULT.DECRYPTED_SECRETS
    WHERE NAME = 'authenti8_api_origin'
  ) || '/api/v1/internal/billing/webhooks/drain',
  HEADERS := JSONB_BUILD_OBJECT( 'Content-Type', 'application/json', 'Authorization',
    'Bearer ' || (
      SELECT DECRYPTED_SECRET FROM VAULT.DECRYPTED_SECRETS
      WHERE NAME = 'authenti8_mail_worker_secret'
    ) ),
  BODY := '{}'::JSONB,
  TIMEOUT_MILLISECONDS := 90000 );
$BILLING_WEBHOOKS$;
REVOKE ALL ON FUNCTION PUBLIC.AUTHENTI8_PROCESS_BILLING_WEBHOOKS() FROM PUBLIC, ANON, AUTHENTICATED, SERVICE_ROLE;

CREATE OR REPLACE FUNCTION PUBLIC.AUTHENTI8_ORCHESTRATE_INTERVIEWS() RETURNS BIGINT LANGUAGE SQL SECURITY DEFINER SET SEARCH_PATH = PUBLIC, VAULT, NET AS $INTERVIEW_ORCHESTRATOR$
SELECT
  NET.HTTP_POST( URL := (
    SELECT DECRYPTED_SECRET FROM VAULT.DECRYPTED_SECRETS
    WHERE NAME = 'authenti8_api_origin'
  ) || '/api/v1/internal/interviews/orchestrate',
  HEADERS := JSONB_BUILD_OBJECT( 'Content-Type', 'application/json', 'Authorization',
    'Bearer ' || (
      SELECT DECRYPTED_SECRET FROM VAULT.DECRYPTED_SECRETS
      WHERE NAME = 'authenti8_mail_worker_secret'
    ) ),
  BODY := '{}'::JSONB,
  TIMEOUT_MILLISECONDS := 90000 );
$INTERVIEW_ORCHESTRATOR$;
REVOKE ALL ON FUNCTION PUBLIC.AUTHENTI8_ORCHESTRATE_INTERVIEWS() FROM PUBLIC, ANON, AUTHENTICATED, SERVICE_ROLE;

DO $CRON_REPLACE$
DECLARE
  EXISTING_JOB RECORD;
BEGIN
  FOR EXISTING_JOB IN
    SELECT JOBID FROM CRON.JOB WHERE JOBNAME IN (
      'authenti8-mail-worker',
      'authenti8-calendar-renewal',
      'authenti8-calendar-sync',
      'authenti8-billing-webhooks',
      'authenti8-interview-orchestrator',
      'authenti8-cron-history-cleanup'
    )
  LOOP
    PERFORM CRON.UNSCHEDULE(EXISTING_JOB.JOBID);
  END LOOP;
END;
$CRON_REPLACE$;

SELECT
  CRON.SCHEDULE( 'authenti8-mail-worker',
  '10 seconds',
  'SELECT public.authenti8_invoke_mail_worker();' );

SELECT
  CRON.SCHEDULE( 'authenti8-calendar-renewal',
  '*/5 * * * *',
  'SELECT public.authenti8_renew_calendar_channels();' );

SELECT
  CRON.SCHEDULE( 'authenti8-calendar-sync',
  '* * * * *',
  'SELECT public.authenti8_process_calendar_syncs();' );

SELECT
  CRON.SCHEDULE( 'authenti8-billing-webhooks',
  '10 seconds',
  'SELECT public.authenti8_process_billing_webhooks();' );

SELECT
  CRON.SCHEDULE( 'authenti8-interview-orchestrator',
  '10 seconds',
  'SELECT public.authenti8_orchestrate_interviews();' );
 
-- pg_cron does not prune execution history automatically. Keep enough history
-- for operational debugging without allowing this high-frequency job to grow
-- cron.job_run_details indefinitely.
SELECT
  CRON.SCHEDULE( 'authenti8-cron-history-cleanup',
  '0 3 * * *',
  'DELETE FROM cron.job_run_details WHERE end_time < now() - interval ''7 days'';' );
