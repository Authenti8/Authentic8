export type GoogleTokenResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
};

export type GoogleProfile = { sub: string; email: string };

export type GoogleCalendar = { id: string; summary?: string };

export type GoogleAttendee = {
  email?: string;
  displayName?: string;
  self?: boolean;
  resource?: boolean;
};

export type GoogleEvent = {
  id?: string;
  iCalUID?: string;
  recurringEventId?: string;
  status?: string;
  summary?: string;
  updated?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  organizer?: { email?: string };
  attendees?: GoogleAttendee[];
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  originalStartTime?: { date?: string; dateTime?: string };
};

export type EventPage = {
  items?: GoogleEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
};

export type IntegrationCredentials = {
  id: string;
  generation: number;
  organizationId: string;
  organizationDomain: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  calendarId: string;
  syncToken: string | null;
  lastFullSyncAt: string | null;
  channelId: string | null;
  channelResourceId: string | null;
};

export type GoogleWatchResponse = {
  expiration?: string;
  resourceId: string;
};
