import type { GoogleAttendee, GoogleEvent } from "./google.types.js";

const interviewTitle = /\b(?:interview|screening|candidate|assessment|(?:technical|coding|hr|founder|manager|culture|final)\s+round|hiring\s+(?:interview|assessment|screening))\b/i;

export function normalizeGoogleEvent(event: GoogleEvent, organizationDomain: string) {
  if (event.status === "cancelled" && event.id) {
    return { eventId: event.id, cancelled: true, updatedAt: event.updated ?? null };
  }
  if (!event.id) return null;
  const meetUrl = findMeetUrl(event);
  const organizerEmail = event.organizer?.email?.toLowerCase();
  const start = event.start?.dateTime;
  const end = event.end?.dateTime;
  if (!meetUrl || !organizerEmail || !start || !end) return excluded(event);
  if (emailDomain(organizerEmail) !== organizationDomain.toLowerCase()) return excluded(event);
  const candidate = findCandidate(event.attendees ?? [], organizationDomain);
  const title = event.summary?.trim() || "Candidate interview";
  if (!candidate || !interviewTitle.test(title)) return excluded(event);
  return {
    eventId: event.id, cancelled: false, meetCode: meetCode(meetUrl), meetUrl,
    candidateEmail: candidate.email!.toLowerCase(), candidateName: candidate.displayName ?? null,
    organizerEmail, title, reason: "Meet link, interview title, and external attendee matched",
    start, end, updatedAt: event.updated ?? null,
    participants: participants(event.attendees ?? [], candidate.email!, organizationDomain),
  };
}

function excluded(event: GoogleEvent) {
  return { eventId: event.id!, cancelled: false, excluded: true,
    updatedAt: event.updated ?? null };
}

function findMeetUrl(event: GoogleEvent) {
  const video = event.conferenceData?.entryPoints?.find((item) => item.entryPointType === "video")?.uri;
  const value = video ?? event.hangoutLink;
  return value && /^https:\/\/meet\.google\.com\/[a-z0-9-]+$/i.test(value) ? value : null;
}

function meetCode(url: string) {
  return new URL(url).pathname.slice(1).toLowerCase();
}

function findCandidate(attendees: GoogleAttendee[], domain: string) {
  const external = attendees.filter((attendee) => attendee.email && !attendee.self
    && !attendee.resource && emailDomain(attendee.email) !== domain.toLowerCase());
  if (external.length === 1) return external[0];
  const explicitCandidates = external.filter(isExplicitCandidate);
  return explicitCandidates.length === 1 ? explicitCandidates[0] : undefined;
}

function isExplicitCandidate(attendee: GoogleAttendee) {
  const identity = `${attendee.displayName ?? ""} ${attendee.email?.split("@")[0] ?? ""}`
    .replaceAll(/[._-]/g, " ");
  return /\b(candidate|applicant|interviewee)\b/i.test(identity);
}

function participants(attendees: GoogleAttendee[], candidateEmail: string, domain: string) {
  return attendees.filter((item) => item.email && !item.resource).map((item) => ({
    email: item.email!.toLowerCase(), name: item.displayName ?? null,
    type: item.email!.toLowerCase() === candidateEmail.toLowerCase() ? "CANDIDATE" : "INTERVIEWER",
    external: emailDomain(item.email!) !== domain.toLowerCase(),
  }));
}

function emailDomain(email: string) {
  return email.toLowerCase().split("@").at(-1) ?? "";
}
