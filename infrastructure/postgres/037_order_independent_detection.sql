BEGIN;

CREATE OR REPLACE FUNCTION authenti8_evaluate_detection_candidate(candidate telemetry_events)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE matched detection_rules; interview UUID; is_confirmed BOOLEAN := false;
  evaluated_pack_version TEXT;
BEGIN
  IF candidate.event_type NOT IN ('HIDDEN_OVERLAY_MATCH', 'BROWSER_EXTENSION_MATCH',
      'BROWSER_EXTENSION_CHANGED', 'KNOWN_PROCESS_MATCH', 'AUDIO_ROUTE_CHANGED') THEN RETURN; END IF;
  evaluated_pack_version := CASE WHEN candidate.event_type IN
      ('BROWSER_EXTENSION_MATCH', 'BROWSER_EXTENSION_CHANGED')
    THEN candidate.payload->>'rulePackVersion' ELSE candidate.rule_pack_version END;
  IF NULLIF(evaluated_pack_version, '') IS NULL THEN RETURN; END IF;
  SELECT rule.* INTO matched FROM detection_rules rule
    JOIN detection_rule_packs pack ON pack.platform = rule.platform
      AND pack.version = evaluated_pack_version
      AND candidate.event_timestamp BETWEEN pack.published_at AND pack.expires_at
      AND (pack.disabled_at IS NULL OR candidate.event_timestamp <= pack.disabled_at)
  WHERE rule.rule_key = candidate.payload->>'ruleKey'
    AND rule.version = COALESCE((candidate.payload->>'ruleVersion')::INTEGER, 1)
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(pack.rules) packed
      WHERE packed->>'key' = rule.rule_key AND (packed->>'version')::INTEGER = rule.version
        AND (candidate.event_type NOT IN ('BROWSER_EXTENSION_MATCH', 'BROWSER_EXTENSION_CHANGED')
          OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(
            COALESCE(packed->'extensionIds', '[]'::JSONB)) extension_id
            WHERE extension_id.value = candidate.payload->>'extensionId')))
    AND (rule.enabled AND rule.status = 'PUBLISHED' OR rule.status = 'DISABLED'
      AND candidate.event_timestamp <= rule.disabled_at) LIMIT 1;
  IF matched.id IS NULL THEN RETURN; END IF;
  is_confirmed := matched.confidence = 'HIGH' AND (
    (candidate.event_type IN ('BROWSER_EXTENSION_MATCH', 'BROWSER_EXTENSION_CHANGED')
      AND candidate.payload->>'enabled' = 'true')
    OR (candidate.event_type IN ('HIDDEN_OVERLAY_MATCH', 'KNOWN_PROCESS_MATCH')
      AND jsonb_typeof(candidate.payload->'identityEvidence') = 'array'
      AND jsonb_array_length(candidate.payload->'identityEvidence') > 0
      AND jsonb_typeof(candidate.payload->'activeUseEvidence') = 'array'
      AND jsonb_array_length(candidate.payload->'activeUseEvidence') > 0));
  IF matched.confidence = 'MEDIUM' AND NOT (
      (candidate.event_type IN ('BROWSER_EXTENSION_MATCH', 'BROWSER_EXTENSION_CHANGED')
        AND candidate.payload->>'enabled' = 'true')
      OR (candidate.event_type IN ('HIDDEN_OVERLAY_MATCH', 'KNOWN_PROCESS_MATCH')
        AND jsonb_typeof(candidate.payload->'identityEvidence') = 'array'
        AND jsonb_array_length(candidate.payload->'identityEvidence') > 0)
      OR (candidate.event_type = 'AUDIO_ROUTE_CHANGED'
        AND NULLIF(candidate.payload->>'endpointIdHash', '') IS NOT NULL)) THEN RETURN; END IF;
  IF matched.confidence = 'MEDIUM'
      AND jsonb_typeof(matched.required_supporting_signals) = 'array'
      AND jsonb_array_length(matched.required_supporting_signals) > 0 THEN
    SELECT NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(
      matched.required_supporting_signals) required WHERE NOT EXISTS (
      SELECT 1 FROM telemetry_events signal
      JOIN detection_rules supporting ON supporting.rule_key = signal.payload->>'ruleKey'
        AND supporting.version = COALESCE((signal.payload->>'ruleVersion')::INTEGER, 1)
      JOIN detection_rule_packs supporting_pack ON supporting_pack.platform = supporting.platform
        AND supporting_pack.version = CASE WHEN signal.event_type IN
          ('BROWSER_EXTENSION_MATCH', 'BROWSER_EXTENSION_CHANGED')
          THEN signal.payload->>'rulePackVersion' ELSE signal.rule_pack_version END
        AND signal.event_timestamp BETWEEN supporting_pack.published_at
          AND supporting_pack.expires_at
        AND (supporting_pack.disabled_at IS NULL
          OR signal.event_timestamp <= supporting_pack.disabled_at)
      WHERE signal.verification_session_id = candidate.verification_session_id
        AND signal.id <> candidate.id AND supporting.rule_key = required.value
        AND supporting.confidence = 'MEDIUM'
        AND (supporting.enabled AND supporting.status = 'PUBLISHED'
          OR supporting.status = 'DISABLED' AND signal.event_timestamp <= supporting.disabled_at)
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(supporting_pack.rules) packed
          WHERE packed->>'key' = supporting.rule_key
            AND (packed->>'version')::INTEGER = supporting.version
            AND (signal.event_type NOT IN ('BROWSER_EXTENSION_MATCH',
              'BROWSER_EXTENSION_CHANGED') OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(
                COALESCE(packed->'extensionIds', '[]'::JSONB)) extension_id
              WHERE extension_id.value = signal.payload->>'extensionId')))
        AND signal.event_type IN ('KNOWN_PROCESS_MATCH', 'AUDIO_ROUTE_CHANGED',
          'HIDDEN_OVERLAY_MATCH', 'BROWSER_EXTENSION_MATCH', 'BROWSER_EXTENSION_CHANGED')
        AND (CASE WHEN jsonb_typeof(signal.payload->'identityEvidence') = 'array'
            THEN jsonb_array_length(signal.payload->'identityEvidence') ELSE 0 END > 0
          OR (NULLIF(signal.payload->>'extensionId', '') IS NOT NULL
            AND signal.payload->>'enabled' = 'true')
          OR NULLIF(signal.payload->>'endpointIdHash', '') IS NOT NULL))) INTO is_confirmed;
  ELSIF matched.confidence = 'MEDIUM' THEN RETURN;
  END IF;
  IF NOT is_confirmed THEN RETURN; END IF;
  INSERT INTO detection_incidents(verification_session_id, rule_id, source_event_id,
    result, evidence_summary, rule_pack_version, confidence)
  VALUES (candidate.verification_session_id, matched.id, candidate.id, 'CONFIRMED',
    jsonb_build_object('eventType', candidate.event_type,
      'technicalEvidence', candidate.payload), evaluated_pack_version, matched.confidence)
  ON CONFLICT DO NOTHING;
  SELECT interview_id INTO interview FROM verification_sessions
    WHERE id = candidate.verification_session_id;
  UPDATE interviews SET detection_result = 'CONFIRMED', updated_at = now() WHERE id = interview;
  INSERT INTO recruiter_live_events(interview_id, source_event_id, source_kind, source_reference,
    kind, message, occurred_at, metadata, idempotency_key) VALUES (interview, candidate.id,
    'TELEMETRY', candidate.id::TEXT, 'CONFIRMED_DETECTION',
    'Prohibited AI assistance confirmed', candidate.event_timestamp,
    jsonb_build_object('rulePackVersion', evaluated_pack_version),
    'detection:' || candidate.id) ON CONFLICT DO NOTHING;
EXCEPTION WHEN invalid_text_representation THEN RETURN;
END $$;

CREATE OR REPLACE FUNCTION authenti8_evaluate_detection_event() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE pending telemetry_events;
BEGIN
  PERFORM authenti8_evaluate_detection_candidate(NEW);
  IF NULLIF(NEW.payload->>'ruleKey', '') IS NULL OR NOT EXISTS (
      SELECT 1 FROM detection_rules WHERE confidence = 'MEDIUM'
        AND required_supporting_signals ? (NEW.payload->>'ruleKey')) THEN RETURN NEW; END IF;
  FOR pending IN SELECT event.* FROM telemetry_events event
    JOIN detection_rules rule ON rule.rule_key = event.payload->>'ruleKey'
      AND rule.version = CASE WHEN event.payload->>'ruleVersion' IS NULL THEN 1
        WHEN event.payload->>'ruleVersion' ~ '^[1-9][0-9]{0,8}$'
        THEN (event.payload->>'ruleVersion')::INTEGER END
    WHERE event.verification_session_id = NEW.verification_session_id AND event.id <> NEW.id
      AND rule.confidence = 'MEDIUM'
      AND rule.required_supporting_signals ? (NEW.payload->>'ruleKey')
  LOOP PERFORM authenti8_evaluate_detection_candidate(pending); END LOOP;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION authenti8_evaluate_detection_candidate(telemetry_events)
  FROM PUBLIC, anon, authenticated;

INSERT INTO schema_migrations(version) VALUES ('037_order_independent_detection')
  ON CONFLICT DO NOTHING;
COMMIT;
