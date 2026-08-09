import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeGoogleEvent } from "./calendar-events.js";
import {
  eventUrl, fullSyncDue, GoogleApiError, requiresGoogleReauthentication,
} from "./google-calendar.service.js";

test("calendar normalization accepts qualifying Meet interviews", () => {
  const event = normalizeGoogleEvent({
    id: "event-1", summary: "Technical interview — Backend Engineer",
    hangoutLink: "https://meet.google.com/abc-defg-hij",
    organizer: { email: "recruiter@acme.com" },
    attendees: [{ email: "candidate@example.com", displayName: "Candidate" },
      { email: "recruiter@acme.com", self: true }],
    start: { dateTime: "2026-08-10T10:00:00Z" },
    end: { dateTime: "2026-08-10T11:00:00Z" },
  }, "acme.com");
  assert.equal(event?.cancelled, false);
  assert.equal(event && "candidateEmail" in event ? event.candidateEmail : null, "candidate@example.com");
});

test("calendar normalization never treats room resources as candidates", () => {
  const event = normalizeGoogleEvent({
    id: "event-room", summary: "Technical interview",
    hangoutLink: "https://meet.google.com/abc-defg-hij",
    organizer: { email: "recruiter@acme.com" },
    attendees: [
      { email: "room@facilities.example", displayName: "Board room", resource: true },
      { email: "candidate@example.com", displayName: "Candidate" },
      { email: "recruiter@acme.com", self: true },
    ],
    start: { dateTime: "2026-08-10T10:00:00Z" },
    end: { dateTime: "2026-08-10T11:00:00Z" },
  }, "acme.com");
  assert.equal(event && "candidateEmail" in event ? event.candidateEmail : null,
    "candidate@example.com");
  const participants = event && "participants" in event ? event.participants ?? [] : [];
  assert.deepEqual(participants.map((participant) => participant.email),
  ["candidate@example.com", "recruiter@acme.com"]);
});

test("calendar normalization selects one explicitly marked candidate", () => {
  const event = normalizeGoogleEvent({
    id: "event-ambiguous", summary: "Technical interview",
    hangoutLink: "https://meet.google.com/abc-defg-hij",
    organizer: { email: "recruiter@acme.com" },
    attendees: [
      { email: "agency@example.com", displayName: "Agency recruiter" },
      { email: "candidate@example.net", displayName: "Candidate" },
      { email: "recruiter@acme.com", self: true },
    ],
    start: { dateTime: "2026-08-10T10:00:00Z" },
    end: { dateTime: "2026-08-10T11:00:00Z" },
  }, "acme.com");
  assert.equal(event && "candidateEmail" in event ? event.candidateEmail : null,
    "candidate@example.net");
  const participants = event && "participants" in event ? event.participants ?? [] : [];
  assert.equal(participants.filter((participant) => participant.type === "CANDIDATE").length, 1);
});

test("calendar normalization excludes ambiguous external attendees", () => {
  const event = normalizeGoogleEvent({
    id: "event-ambiguous", summary: "Technical interview",
    hangoutLink: "https://meet.google.com/abc-defg-hij",
    organizer: { email: "recruiter@acme.com" },
    attendees: [
      { email: "alex@example.com", displayName: "Alex" },
      { email: "agency@example.net", displayName: "Agency recruiter" },
    ],
    start: { dateTime: "2026-08-10T10:00:00Z" },
    end: { dateTime: "2026-08-10T11:00:00Z" },
  }, "acme.com");
  assert.deepEqual(event, { eventId: "event-ambiguous", cancelled: false,
    excluded: true, updatedAt: null });
});

test("calendar normalization rejects internal or non-interview events", () => {
  const base = {
    id: "event-2", hangoutLink: "https://meet.google.com/abc-defg-hij",
    organizer: { email: "owner@acme.com" },
    attendees: [{ email: "teammate@acme.com" }],
    start: { dateTime: "2026-08-10T10:00:00Z" },
    end: { dateTime: "2026-08-10T11:00:00Z" },
  };
  assert.deepEqual(normalizeGoogleEvent({ ...base, summary: "Technical interview" }, "acme.com"),
    { eventId: "event-2", cancelled: false, excluded: true, updatedAt: null });
  assert.deepEqual(normalizeGoogleEvent({ ...base, summary: "Weekly standup",
    attendees: [{ email: "guest@example.com" }] }, "acme.com"),
  { eventId: "event-2", cancelled: false, excluded: true, updatedAt: null });
  assert.deepEqual(normalizeGoogleEvent({ ...base, summary: "Technical interview",
    organizer: { email: "agency@example.com" },
    attendees: [{ email: "candidate@outside.com" }] }, "acme.com"),
  { eventId: "event-2", cancelled: false, excluded: true, updatedAt: null });
});

test("calendar normalization supports every documented interview title", () => {
  const titles = ["HR round", "Founder round", "Manager round", "Culture round",
    "Final round", "Hiring interview", "Candidate assessment"];
  for (const [index, summary] of titles.entries()) {
    const event = normalizeGoogleEvent({ id: `keyword-${index}`, summary,
      hangoutLink: "https://meet.google.com/abc-defg-hij",
      organizer: { email: "owner@acme.com" },
      attendees: [{ email: "candidate@example.com" }],
      start: { dateTime: "2026-08-10T10:00:00Z" },
      end: { dateTime: "2026-08-10T11:00:00Z" } }, "acme.com");
    assert.equal(event?.cancelled, false, summary);
  }
});

test("calendar normalization rejects broad non-interview keyword matches", () => {
  const titles = ["Technical partnership call", "Coding guild sync", "Screen sharing demo",
    "Hiring plan review"];
  for (const [index, summary] of titles.entries()) {
    const event = normalizeGoogleEvent({ id: `broad-keyword-${index}`, summary,
      hangoutLink: "https://meet.google.com/abc-defg-hij",
      organizer: { email: "owner@acme.com" },
      attendees: [{ email: "guest@example.com" }],
      start: { dateTime: "2026-08-10T10:00:00Z" },
      end: { dateTime: "2026-08-10T11:00:00Z" } }, "acme.com");
    assert.deepEqual(event, { eventId: `broad-keyword-${index}`, cancelled: false,
      excluded: true, updatedAt: null }, summary);
  }
});

test("calendar normalization emits a tombstone when a known event stops qualifying", () => {
  assert.deepEqual(normalizeGoogleEvent({ id: "event-3", summary: "Interview" }, "acme.com"),
    { eventId: "event-3", cancelled: false, excluded: true, updatedAt: null });
});

test("calendar tombstones retain the provider update version", () => {
  assert.deepEqual(normalizeGoogleEvent({ id: "event-4", status: "cancelled",
    updated: "2026-08-10T09:00:00Z" }, "acme.com"),
  { eventId: "event-4", cancelled: true, updatedAt: "2026-08-10T09:00:00Z" });
});

test("calendar pagination keeps one stable full-sync window", () => {
  const window = {
    timeMin: "2026-08-05T00:00:00.000Z",
    timeMax: "2026-11-04T00:00:00.000Z",
  };
  const first = new URL(eventUrl("primary", null, undefined, window));
  const next = new URL(eventUrl("primary", null, "page-2", window));
  assert.equal(next.searchParams.get("timeMin"), first.searchParams.get("timeMin"));
  assert.equal(next.searchParams.get("timeMax"), first.searchParams.get("timeMax"));
  assert.equal(next.searchParams.get("pageToken"), "page-2");
});

test("calendar incremental URLs use only the Google sync token", () => {
  const url = new URL(eventUrl("primary", "sync-token"));
  assert.equal(url.searchParams.get("syncToken"), "sync-token");
  assert.equal(url.searchParams.has("timeMin"), false);
  assert.equal(url.searchParams.has("timeMax"), false);
});

test("calendar refreshes its bounded full sync every 24 hours", () => {
  const now = Date.parse("2026-08-06T12:00:00.000Z");
  assert.equal(fullSyncDue(null, now), true);
  assert.equal(fullSyncDue("invalid", now), true);
  assert.equal(fullSyncDue("2026-08-05T13:00:01.000Z", now), false);
  assert.equal(fullSyncDue("2026-08-05T12:00:00.000Z", now), true);
});

test("calendar only requires reauthentication for a revoked Google grant", () => {
  assert.equal(requiresGoogleReauthentication(new GoogleApiError(400, "invalid_grant")), true);
  assert.equal(requiresGoogleReauthentication(new GoogleApiError(429, "rate_limit_exceeded")), false);
  assert.equal(requiresGoogleReauthentication(new GoogleApiError(500)), false);
  assert.equal(requiresGoogleReauthentication(new Error("network timeout")), false);
});
