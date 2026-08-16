BEGIN;

CREATE OR REPLACE FUNCTION authenti8_record_accuracy_release(input JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE item JSONB; recorded JSONB; registered JSONB; platforms TEXT[] := ARRAY[]::TEXT[];
  run_ids JSONB := '[]'::JSONB; active_pack_version TEXT; release_commit TEXT;
BEGIN
  IF jsonb_typeof(input->'results') <> 'array' OR jsonb_array_length(input->'results') <> 2 THEN
    RETURN jsonb_build_object('released', false, 'reason', 'BOTH_PLATFORMS_REQUIRED'); END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(input->'results') LOOP
    IF item->>'platform' NOT IN ('WINDOWS', 'MACOS')
        OR item->>'platform' = ANY(platforms) THEN
      RETURN jsonb_build_object('released', false, 'reason', 'INVALID_PLATFORM_SET'); END IF;
    IF NULLIF(item->>'commitSha', '') IS NULL THEN
      RETURN jsonb_build_object('released', false, 'reason', 'COMMIT_REQUIRED'); END IF;
    release_commit := COALESCE(release_commit, item->>'commitSha');
    IF release_commit IS DISTINCT FROM item->>'commitSha' THEN
      RETURN jsonb_build_object('released', false, 'reason', 'COMMIT_SET_MISMATCH'); END IF;
    platforms := array_append(platforms, item->>'platform');
  END LOOP;
  BEGIN
    FOR item IN SELECT value FROM jsonb_array_elements(input->'results') LOOP
      SELECT version INTO active_pack_version FROM detection_rule_packs
      WHERE platform = item->>'platform' AND disabled_at IS NULL
        AND published_at <= now() AND expires_at > now()
      ORDER BY published_at DESC LIMIT 1;
      IF active_pack_version IS NULL
          OR active_pack_version IS DISTINCT FROM item->>'rulePackVersion' THEN
        RAISE EXCEPTION 'ACCURACY_REJECTED:ACTIVE_RULE_PACK_REQUIRED';
      END IF;
      recorded := authenti8_record_accuracy_run(item);
      IF NOT COALESCE((recorded->>'recorded')::BOOLEAN, false)
          OR NOT COALESCE((recorded->>'passed')::BOOLEAN, false) THEN
        RAISE EXCEPTION 'ACCURACY_REJECTED:%', COALESCE(recorded->>'reason', 'THRESHOLD_FAILED');
      END IF;
      run_ids := run_ids || jsonb_build_array(recorded->'runId');
      registered := authenti8_register_application_version(jsonb_build_object(
        'application', CASE item->>'platform' WHEN 'WINDOWS' THEN 'WINDOWS_AGENT'
          ELSE 'MACOS_AGENT' END, 'platform', item->>'platform',
        'version', item->>'agentVersion', 'releaseChannel', 'PRODUCTION',
        'minimumSupported', true, 'commitSha', item->>'commitSha',
        'artifactDigest', item->>'artifactDigest'));
      IF NOT COALESCE((registered->>'registered')::BOOLEAN, false) THEN
        RAISE EXCEPTION 'VERSION_REJECTED:%', COALESCE(registered->>'reason', 'UNKNOWN');
      END IF;
    END LOOP;
  EXCEPTION WHEN raise_exception THEN
    RETURN jsonb_build_object('released', false, 'reason', SQLERRM);
  END;
  RETURN jsonb_build_object('released', true, 'runIds', run_ids);
END $$;

REVOKE ALL ON FUNCTION authenti8_record_accuracy_release(JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION authenti8_record_accuracy_release(JSONB) TO service_role;

INSERT INTO schema_migrations(version) VALUES ('042_atomic_accuracy_release')
  ON CONFLICT DO NOTHING;
COMMIT;
