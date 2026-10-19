import type { Config } from "../config.js";
import type { Repo } from "../db/repo.js";
import { decrypt, encrypt } from "../lib/crypto.js";
import { fetchJson } from "../lib/http.js";
import type { Interval } from "./slots.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3";
// Read free/busy + create events. calendar.readonly covers the freeBusy query.
const SCOPES = ["https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.readonly"];

export function googleRedirectUri(config: Config): string {
  return `${config.PUBLIC_BASE_URL}/oauth/google/callback`;
}

export function googleAuthUrl(config: Config, state: string): string {
  if (!config.GOOGLE_CLIENT_ID) throw new Error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to connect Google Calendar");
  const params = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirectUri(config),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_URL}?${params}`;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}

/** Finishes the OAuth flow and stores the (encrypted) refresh token for the contractor. */
export async function completeGoogleOAuth(config: Config, repo: Repo, contractorId: string, code: string): Promise<string | null> {
  const tokens = await fetchJson<TokenResponse>(TOKEN_URL, {
    method: "POST",
    form: {
      code,
      client_id: config.GOOGLE_CLIENT_ID ?? "",
      client_secret: config.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: googleRedirectUri(config),
      grant_type: "authorization_code",
    },
  });
  if (!tokens.refresh_token) {
    throw new Error("Google did not return a refresh token. Remove the app's access at myaccount.google.com/permissions and connect again.");
  }
  // The primary calendar's id is the account's email address.
  const primary = await fetchJson<{ id: string }>(`${API}/calendars/primary`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  }).catch(() => null);
  repo.upsertCalendarConnection({
    contractorId,
    provider: "google",
    accountEmail: primary?.id ?? null,
    refreshToken: encrypt(tokens.refresh_token, config.APP_SECRET),
    accessToken: encrypt(tokens.access_token, config.APP_SECRET),
    accessTokenExpiresAt: new Date(Date.now() + (tokens.expires_in - 60) * 1000).toISOString(),
  });
  return primary?.id ?? null;
}

export class GoogleCalendarClient {
  constructor(
    private readonly config: Config,
    private readonly repo: Repo,
  ) {}

  private async accessToken(contractorId: string): Promise<string> {
    const conn = this.repo.getCalendarConnection(contractorId);
    if (!conn) throw new Error("Google Calendar is not connected");
    if (conn.accessToken && conn.accessTokenExpiresAt && new Date(conn.accessTokenExpiresAt) > new Date()) {
      return decrypt(conn.accessToken, this.config.APP_SECRET);
    }
    const tokens = await fetchJson<TokenResponse>(TOKEN_URL, {
      method: "POST",
      form: {
        client_id: this.config.GOOGLE_CLIENT_ID ?? "",
        client_secret: this.config.GOOGLE_CLIENT_SECRET ?? "",
        refresh_token: decrypt(conn.refreshToken, this.config.APP_SECRET),
        grant_type: "refresh_token",
      },
    });
    this.repo.updateCalendarAccessToken(
      contractorId,
      encrypt(tokens.access_token, this.config.APP_SECRET),
      new Date(Date.now() + (tokens.expires_in - 60) * 1000).toISOString(),
    );
    return tokens.access_token;
  }

  async busy(contractorId: string, calendarId: string, from: Date, to: Date): Promise<Interval[]> {
    const token = await this.accessToken(contractorId);
    const res = await fetchJson<{ calendars: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: unknown[] }> }>(
      `${API}/freeBusy`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        json: { timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: calendarId }] },
      },
    );
    const cal = res.calendars[calendarId];
    if (!cal) return [];
    if (cal.errors?.length) throw new Error(`Google Calendar free/busy error: ${JSON.stringify(cal.errors)}`);
    return (cal.busy ?? []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
  }

  async createEvent(
    contractorId: string,
    calendarId: string,
    event: { summary: string; description: string; location?: string; start: Date; end: Date; timezone: string },
  ): Promise<{ id: string; htmlLink?: string }> {
    const token = await this.accessToken(contractorId);
    return fetchJson<{ id: string; htmlLink?: string }>(`${API}/calendars/${encodeURIComponent(calendarId)}/events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      json: {
        summary: event.summary,
        description: event.description,
        location: event.location,
        start: { dateTime: event.start.toISOString(), timeZone: event.timezone },
        end: { dateTime: event.end.toISOString(), timeZone: event.timezone },
        reminders: { useDefault: true },
      },
    });
  }
}
