/**
 * Dostęp do Bearer tokena: statyczny ADLOOK_TOKEN lub odświeżanie przez
 * POST {ADLOOK_BASE_URL}/auth/token/refresh (Adlook Smart API).
 * Opcjonalnie: własny URL (ADLOOK_OAUTH_TOKEN_URL) lub tryb OAuth2 form (ADLOOK_TOKEN_REFRESH_MODE=oauth2).
 */
/** Czy jest refresh token (env lub ustawiony przez setSessionAuth). */
export declare function isOAuthRefreshConfigured(): boolean;
export declare function invalidateCachedAccessToken(): void;
/**
 * Tokeny wklejone z przeglądarki na czas życia procesu MCP (pamięć RAM).
 * `refresh_token` — z odpowiedzi logowania / DevTools; bez niego nie ma auto-odświeżania.
 */
export declare function setSessionAuth(accessToken: string, refreshToken?: string): void;
/**
 * Token do nagłówka Authorization.
 * `tokenOverride` — jawny token z argumentu narzędzia MCP (bez odświeżania env).
 */
export declare function resolveAccessToken(tokenOverride?: string): Promise<string>;
