/**
 * Dostęp do Bearer tokena: statyczny ADLOOK_TOKEN lub odświeżanie przez
 * POST {ADLOOK_BASE_URL}/auth/token/refresh (Adlook Smart API).
 * Opcjonalnie: własny URL (ADLOOK_OAUTH_TOKEN_URL) lub tryb OAuth2 form (ADLOOK_TOKEN_REFRESH_MODE=oauth2).
 */

const API_BASE = (process.env.ADLOOK_BASE_URL ?? "https://api.uat.smart.adlook.com/api").replace(
  /\/$/,
  ""
);
const DEFAULT_REFRESH_URL = `${API_BASE}/auth/token/refresh`;

const REFRESH_TOKEN = process.env.ADLOOK_REFRESH_TOKEN?.trim() ?? "";
/** Pełny URL odświeżania; domyślnie `{ADLOOK_BASE_URL}/auth/token/refresh`. */
const TOKEN_URL =
  process.env.ADLOOK_OAUTH_TOKEN_URL?.trim() ||
  process.env.ADLOOK_TOKEN_REFRESH_URL?.trim() ||
  DEFAULT_REFRESH_URL;

const REFRESH_MODE = (process.env.ADLOOK_TOKEN_REFRESH_MODE ?? "json").toLowerCase();

/** Pole JSON z refresh tokenem w body (Adlook Smart API: `refresh`). */
const REFRESH_JSON_FIELD = process.env.ADLOOK_REFRESH_TOKEN_JSON_FIELD ?? "refresh";

const CLIENT_ID = process.env.ADLOOK_OAUTH_CLIENT_ID?.trim() ?? "";
const CLIENT_SECRET = process.env.ADLOOK_OAUTH_CLIENT_SECRET?.trim() ?? "";

/** Odświeżaj access token wcześniej niż wygaśnie (sekundy). */
const REFRESH_SKEW_SEC = parseInt(process.env.ADLOOK_TOKEN_REFRESH_SKEW_SEC ?? "60", 10);

let cachedAccessToken: string | null = process.env.ADLOOK_TOKEN?.trim() || null;
let cachedRefreshToken = REFRESH_TOKEN;

let refreshInFlight: Promise<void> | null = null;

function jwtExpMs(token: string): number | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const json = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof json.exp === "number" ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Czy jest refresh token (env lub ustawiony przez setSessionAuth). */
export function isOAuthRefreshConfigured(): boolean {
  return Boolean(cachedRefreshToken);
}

export function invalidateCachedAccessToken(): void {
  cachedAccessToken = null;
}

/**
 * Tokeny wklejone z przeglądarki na czas życia procesu MCP (pamięć RAM).
 * `refresh_token` — z odpowiedzi logowania / DevTools; bez niego nie ma auto-odświeżania.
 */
export function setSessionAuth(accessToken: string, refreshToken?: string): void {
  const a = accessToken.trim();
  if (!a) {
    throw new Error("access_token nie może być pusty.");
  }
  cachedAccessToken = a;
  if (refreshToken !== undefined) {
    const r = refreshToken.trim();
    cachedRefreshToken = r.length > 0 ? r : cachedRefreshToken;
  }
}

function pickAccessToken(data: Record<string, unknown>): string | null {
  const a = data.access ?? data.accessToken ?? data.access_token ?? data.token;
  return typeof a === "string" && a.length > 0 ? a : null;
}

function pickRefreshToken(data: Record<string, unknown>): string | null {
  const r = data.refresh ?? data.refreshToken ?? data.refresh_token;
  return typeof r === "string" && r.length > 0 ? r : null;
}

async function postRefreshJson(): Promise<void> {
  const bodyObj: Record<string, string> = {
    [REFRESH_JSON_FIELD]: cachedRefreshToken,
  };

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(bodyObj),
  });

  const data = (await res.json()) as Record<string, unknown>;

  if (!res.ok) {
    throw new Error(
      `Odświeżenie tokenu nie powiodło się: HTTP ${res.status}: ${JSON.stringify(data)}`
    );
  }

  const access = pickAccessToken(data);
  if (!access) {
    throw new Error(
      `Odświeżenie tokenu: brak access tokena w odpowiedzi (accessToken / access_token / token): ${JSON.stringify(data)}`
    );
  }

  cachedAccessToken = access;
  const nextRefresh = pickRefreshToken(data);
  if (nextRefresh) {
    cachedRefreshToken = nextRefresh;
  }
}

async function postRefreshOAuth2Form(): Promise<void> {
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", cachedRefreshToken);
  if (CLIENT_ID) body.set("client_id", CLIENT_ID);
  if (CLIENT_SECRET) body.set("client_secret", CLIENT_SECRET);

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const data = (await res.json()) as Record<string, unknown>;

  if (!res.ok) {
    throw new Error(
      `Odświeżenie tokenu OAuth nie powiodło się: HTTP ${res.status}: ${JSON.stringify(data)}`
    );
  }

  const access = pickAccessToken(data);
  if (!access) {
    throw new Error(
      `Odświeżenie tokenu: brak access tokena w odpowiedzi: ${JSON.stringify(data)}`
    );
  }

  cachedAccessToken = access;
  const nextRefresh = pickRefreshToken(data);
  if (nextRefresh) {
    cachedRefreshToken = nextRefresh;
  }
}

async function postRefresh(): Promise<void> {
  if (REFRESH_MODE === "oauth2") {
    await postRefreshOAuth2Form();
  } else {
    await postRefreshJson();
  }
}

async function ensureFreshAccessToken(): Promise<void> {
  const now = Date.now();
  const skewMs = Math.max(0, REFRESH_SKEW_SEC) * 1000;

  if (cachedAccessToken) {
    const exp = jwtExpMs(cachedAccessToken);
    if (exp === null || exp > now + skewMs) {
      return;
    }
  } else if (!cachedRefreshToken) {
    return;
  }

  if (refreshInFlight) {
    await refreshInFlight;
    return;
  }

  refreshInFlight = postRefresh().finally(() => {
    refreshInFlight = null;
  });
  await refreshInFlight;
}

/**
 * Token do nagłówka Authorization.
 * `tokenOverride` — jawny token z argumentu narzędzia MCP (bez odświeżania env).
 */
export async function resolveAccessToken(tokenOverride?: string): Promise<string> {
  const trimmed = tokenOverride?.trim();
  if (trimmed) {
    return trimmed;
  }

  if (!isOAuthRefreshConfigured()) {
    const t = cachedAccessToken || process.env.ADLOOK_TOKEN?.trim();
    if (!t) {
      throw new Error(
        "Brak tokenu autoryzacyjnego. Na początku sesji wywołaj set_adlook_auth (token z przeglądarki), " +
          "albo ustaw ADLOOK_TOKEN w env, albo podaj adlook_token w argumencie narzędzia."
      );
    }
    return t;
  }

  await ensureFreshAccessToken();
  if (!cachedAccessToken) {
    throw new Error(
      `Brak access tokenu po odświeżeniu. Sprawdź refresh_token (set_adlook_auth lub ADLOOK_REFRESH_TOKEN) i URL: ${TOKEN_URL}`
    );
  }
  return cachedAccessToken;
}
