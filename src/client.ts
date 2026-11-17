import { readFile, writeFile } from "node:fs/promises";
import { ZetaError } from "./errors.ts";
import { parseStreamChunks } from "./stream.ts";
import type {
  ChatStreamChunk,
  CreateRoomRequest,
  DetailedPlotApiDto,
  ExternalToken,
  JsonRecord,
  ListMessageResponse,
  ListRoomsResponse,
  PagePlotResponse,
  PageQuery,
  PlotApiDto,
  RegenerateMessageRequest,
  RoomApiDto,
  SendMessagePayload,
  Tokens,
  UpdateMessageRequest,
  UserApiDto,
  UserMeResponse,
  ZetaClientOptions,
} from "./types.ts";
import { buildSendMessageBody } from "./types.ts";

export const DEFAULT_BASE_URL = "https://api.zeta-ai.io";
export const DEFAULT_CLIENT_VERSION = "3.51.94";
/** Web sends the version name here, not VERSION_CODE (359 was rejected with APP_UPDATE_REQUIRED). */
export const DEFAULT_NATIVE_VERSION = "3.51.94";
/** BuildConfig SUPPORT_URL — SSO redirect target. */
export const SUPPORT_URL = "https://support.zeta-ai.io/zeta";

/** `<SUPPORT_URL>/sso?code=<code>&to=<path>` (module_6653:39-44). */
export function buildSsoRedirectUrl(code: string, to = "/"): string {
  const q = new URLSearchParams({ code });
  if (to) q.set("to", to);
  return `${SUPPORT_URL}/sso?${q.toString()}`;
}

function parseTokens(body: unknown): Tokens | null {
  const src = (body as { data?: unknown })?.data ?? body;
  const t = src as {
    accessToken?: unknown;
    refreshToken?: unknown;
    newAccessToken?: unknown;
    newRefreshToken?: unknown;
  };
  const accessToken = t.newAccessToken ?? t.accessToken;
  const refreshToken = t.newRefreshToken ?? t.refreshToken;
  if (typeof accessToken !== "string" || !accessToken) return null;
  return {
    accessToken,
    refreshToken: typeof refreshToken === "string" ? refreshToken : "",
  };
}

/** linejs-style factory: `const client = loginWithAccessToken(token)`. */
export function loginWithAccessToken(
  accessToken: string,
  options: Omit<ZetaClientOptions, "accessToken"> = {},
): ZetaClient {
  return new ZetaClient({ ...options, accessToken });
}

export async function saveTokens(path: string, tokens: Tokens): Promise<void> {
  await writeFile(path, JSON.stringify(tokens), { mode: 0o600 });
}

export async function loadTokens(path: string): Promise<Tokens | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as Tokens).accessToken === "string"
    ) {
      return parsed as Tokens;
    }
    return null;
  } catch {
    return null;
  }
}

function decodeJwtExp(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    return typeof (json as { exp?: unknown }).exp === "number"
      ? (json as { exp: number }).exp
      : null;
  } catch {
    return null;
  }
}

/** Query string for one request; skips undefined, encodes keys and values. */
function toQueryString(query: Record<string, unknown>): string {
  let out = "";
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    if (out) out += "&";
    out += `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`;
  }
  return out;
}

export class ZetaClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly extraHeaders: Record<string, string>;
  private readonly doFetch: typeof fetch;
  private readonly onTokensRefreshed: ZetaClientOptions["onTokensRefreshed"];
  private readonly clientVersion: string;
  private readonly nativeVersion: string;
  private readonly language: string | undefined;
  readonly deviceId: string;
  private accessToken: string | undefined;
  private refreshToken: string | undefined;
  private refreshing: Promise<void> | null = null;
  private jsonHeaders: Record<string, string> | null = null;
  private streamHeaders: Record<string, string> | null = null;
  private tokenExp: number | null = null;
  private tokenExpFor: string | undefined;

  constructor(options: ZetaClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.accessToken = options.accessToken;
    this.refreshToken = options.refreshToken;
    this.deviceId = options.deviceId ?? crypto.randomUUID();
    this.apiKey = options.apiKey;
    this.extraHeaders = options.extraHeaders ?? {};
    this.doFetch = options.fetch ?? fetch;
    this.onTokensRefreshed = options.onTokensRefreshed;
    this.clientVersion = options.clientVersion ?? DEFAULT_CLIENT_VERSION;
    this.nativeVersion = options.nativeVersion ?? DEFAULT_NATIVE_VERSION;
    this.language = options.language;
  }

  get token(): string | undefined {
    return this.accessToken;
  }

  setTokens(tokens: Tokens): void {
    this.accessToken = tokens.accessToken;
    this.refreshToken = tokens.refreshToken;
    this.jsonHeaders = null;
    this.streamHeaders = null;
  }

  /** Clears local tokens + cached headers/exp (C1/H3 fix: logout must do this). */
  clearTokens(): void {
    this.accessToken = undefined;
    this.refreshToken = undefined;
    this.jsonHeaders = null;
    this.streamHeaders = null;
    this.tokenExp = null;
    this.tokenExpFor = undefined;
  }

  setAccessToken(token: string): void {
    this.accessToken = token;
    this.jsonHeaders = null;
    this.streamHeaders = null;
  }

  /** Headers the app sends (fn51718/fn52394). Built once per token; a caller
   * mutating extraHeaders after construction still gets a fresh object. */
  private headers(
    accept: "application/json" | "text/event-stream",
  ): Record<string, string> {
    const extra = Object.keys(this.extraHeaders).length > 0;
    const cached =
      accept === "application/json" ? this.jsonHeaders : this.streamHeaders;
    if (cached && !extra) return cached;
    const h: Record<string, string> = {
      Accept: accept,
      "X-Client-Type": "app",
      "X-Device-Type": "android",
      "X-Client-Version": this.clientVersion,
      "X-Client-Native-Version": this.nativeVersion,
      "X-Sticky": this.deviceId,
      ...this.extraHeaders,
    };
    if (this.language) h["X-User-Language"] = this.language;
    if (this.accessToken) h.Authorization = `Bearer ${this.accessToken}`;
    if (this.apiKey) h["x-api-key"] = this.apiKey;
    if (!extra) {
      if (accept === "application/json") this.jsonHeaders = h;
      else this.streamHeaders = h;
    }
    return h;
  }

  /** App rule (fn52394): refresh when jwt exp is within 30s. exp is decoded
   * once per token string, not once per request. */
  private tokenExpiringSoon(): boolean {
    if (!this.accessToken || !this.refreshToken) return false;
    if (this.tokenExpFor !== this.accessToken) {
      this.tokenExpFor = this.accessToken;
      this.tokenExp = decodeJwtExp(this.accessToken);
    }
    const exp = this.tokenExp;
    return exp !== null && exp * 1000 - 30_000 < Date.now();
  }

  /** POST /v1/auth/tokens {deviceId, type:"refresh", refreshToken} (fn52882). */
  async refreshAccessToken(): Promise<Tokens> {
    if (!this.refreshToken) throw new ZetaError("no refresh token stored", 0);
    if (!this.refreshing) {
      // C1 fix: keep the old refresh token if the server omits newRefreshToken.
      const oldRefreshToken = this.refreshToken;
      this.refreshing = (async () => {
        const res = await this.doFetch(`${this.baseUrl}/v1/auth/tokens`, {
          method: "POST",
          headers: {
            ...this.headers("application/json"),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            deviceId: this.deviceId,
            type: "refresh",
            refreshToken: this.refreshToken,
          }),
        });
        if (!res.ok)
          throw new ZetaError(
            `zeta ${res.status}: refresh`,
            res.status,
            await res.text().catch(() => ""),
          );
        const parsed = parseTokens(await res.json());
        if (!parsed)
          throw new ZetaError("refresh returned no access token", res.status);
        const tokens: Tokens = parsed.refreshToken
          ? parsed
          : { ...parsed, refreshToken: oldRefreshToken };
        this.setTokens(tokens);
        this.onTokensRefreshed?.(tokens);
      })().finally(() => {
        this.refreshing = null;
      });
    }
    await this.refreshing;
    return {
      accessToken: this.accessToken ?? "",
      refreshToken: this.refreshToken ?? "",
    };
  }

  private async request<T>(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      query?: Record<string, unknown>;
      signal?: AbortSignal;
    } = {},
    retried = false,
    // H1 fix: one refresh attempt per request. Pre-refresh and 401-refresh
    // must not both run (and the retry must not pre-refresh again).
    refreshTried = false,
  ): Promise<T> {
    if (!refreshTried && this.tokenExpiringSoon()) {
      refreshTried = true;
      await this.refreshAccessToken().catch(() => undefined);
    }
    const qs = init.query ? toQueryString(init.query) : "";
    const url = qs ? `${this.baseUrl}${path}?${qs}` : this.baseUrl + path;
    const headers =
      init.body !== undefined
        ? {
            ...this.headers("application/json"),
            "Content-Type": "application/json",
          }
        : this.headers("application/json");
    let res: Response;
    try {
      res = await this.doFetch(url, {
        method: init.method ?? "GET",
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: init.signal,
      });
    } catch (cause) {
      throw new ZetaError(`request failed: ${path}`, 0, String(cause));
    }
    if (res.status === 401 && this.refreshToken && !retried && !refreshTried) {
      refreshTried = true;
      let refreshed = false;
      try {
        await this.refreshAccessToken();
        refreshed = true;
      } catch {
        // Refresh failed: fall through to the 401 error below instead of
        // retrying with the known-expired token.
      }
      if (refreshed && this.accessToken)
        return this.request<T>(path, init, true, refreshTried);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      let code: string | undefined;
      try {
        const parsed: unknown = JSON.parse(body);
        const c =
          (parsed as { code?: unknown; exceptionCode?: unknown }).code ??
          (parsed as { exceptionCode?: unknown }).exceptionCode;
        if (typeof c === "string") code = c;
      } catch {
        // non-JSON error body: keep code undefined
      }
      throw new ZetaError(
        `zeta ${res.status}: ${path}`,
        res.status,
        body,
        code,
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private async streamRequest(
    path: string,
    body: unknown,
    signal?: AbortSignal,
    retried = false,
    // H1 fix: see request().
    refreshTried = false,
  ): Promise<Response> {
    if (!refreshTried && this.tokenExpiringSoon()) {
      refreshTried = true;
      await this.refreshAccessToken().catch(() => undefined);
    }
    let res: Response;
    try {
      res = await this.doFetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          ...this.headers("text/event-stream"),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (cause) {
      throw new ZetaError(`request failed: ${path}`, 0, String(cause));
    }
    if (res.status === 401 && this.refreshToken && !retried && !refreshTried) {
      refreshTried = true;
      let refreshed = false;
      try {
        await this.refreshAccessToken();
        refreshed = true;
      } catch {
        // Refresh failed: fall through to the 401 error below.
      }
      if (refreshed && this.accessToken)
        return this.streamRequest(path, body, signal, true, refreshTried);
    }
    if (!res.ok)
      throw new ZetaError(
        `zeta ${res.status}: ${path}`,
        res.status,
        await res.text().catch(() => ""),
      );
    return res;
  }

  /** POST /v1/auth/tokens {deviceId, type:"external", externalToken} (module_4161:212).
   * Google: token = idToken; Apple: token = identityToken, name = given+family.
   * On 404 the app calls checkSignup. */
  async loginWithExternalToken(
    externalToken: ExternalToken,
    signal?: AbortSignal,
  ): Promise<Tokens> {
    const res = await this.request<JsonRecord>("/v1/auth/tokens", {
      method: "POST",
      body: { deviceId: this.deviceId, type: "external", externalToken },
      signal,
    });
    const tokens = parseTokens(res);
    if (!tokens) throw new ZetaError("login returned no access token", 0);
    this.setTokens(tokens);
    return tokens;
  }

  /** POST /v1/users/check {externalToken} — called when external login 404s. */
  checkSignup(
    externalToken: ExternalToken,
    signal?: AbortSignal,
  ): Promise<JsonRecord> {
    return this.request<JsonRecord>("/v1/users/check", {
      method: "POST",
      body: { externalToken },
      signal,
    });
  }

  /** Internal/debug login (InternalLoginScreen). Experimental — not the normal user login. */
  async loginInternal(
    username: string,
    password: string,
    signal?: AbortSignal,
  ): Promise<Tokens> {
    const res = await this.request<JsonRecord>("/v1/auth/tokens", {
      method: "POST",
      body: { type: "internal", deviceId: this.deviceId, username, password },
      signal,
    });
    const tokens = parseTokens(res);
    if (!tokens) throw new ZetaError("login returned no access token", 0);
    this.setTokens(tokens);
    return tokens;
  }

  /** POST /v1/auth/tokens → TokenApiDto. Body shape unknown beyond login/refresh. */
  issueToken(body: JsonRecord, signal?: AbortSignal): Promise<JsonRecord> {
    return this.request<JsonRecord>("/v1/auth/tokens", {
      method: "POST",
      body,
      signal,
    });
  }
  /** POST /v1/auth/sso/code → {code}. The app calls it with {} (module_6653). */
  generateSsoCode(
    body: JsonRecord = {},
    signal?: AbortSignal,
  ): Promise<JsonRecord> {
    return this.request<JsonRecord>("/v1/auth/sso/code", {
      method: "POST",
      body,
      signal,
    });
  }
  /** POST /v1/auth/tokens/sso-access-token → SsoAccessTokenApiDto. Body unknown. */
  exchangeSsoAccessToken(
    body: JsonRecord,
    signal?: AbortSignal,
  ): Promise<JsonRecord> {
    return this.request<JsonRecord>("/v1/auth/tokens/sso-access-token", {
      method: "POST",
      body,
      signal,
    });
  }
  getConnectedExternalPlatforms(signal?: AbortSignal): Promise<JsonRecord> {
    return this.request<JsonRecord>("/v1/auth/connected-external-platforms", {
      signal,
    });
  }

  getMe(signal?: AbortSignal): Promise<UserMeResponse> {
    return this.request<UserMeResponse>("/v1/users/me", { signal });
  }
  updateMe(body: JsonRecord, signal?: AbortSignal): Promise<UserMeResponse> {
    return this.request<UserMeResponse>("/v1/users/me", {
      method: "PATCH",
      body,
      signal,
    });
  }
  getUser(userId: string, signal?: AbortSignal): Promise<UserApiDto> {
    return this.request<UserApiDto>(`/v1/users/${encodeURIComponent(userId)}`, {
      signal,
    });
  }
  getUserIdByUsername(
    username: string,
    signal?: AbortSignal,
  ): Promise<JsonRecord> {
    return this.request<JsonRecord>(
      `/v1/users/get-id-by-username/${encodeURIComponent(username)}`,
      { signal },
    );
  }
  // H3 fix: logout clears local tokens; otherwise the client keeps using them.
  async logout(signal?: AbortSignal): Promise<JsonRecord> {
    const res = await this.request<JsonRecord>("/v1/users/logout", {
      method: "POST",
      signal,
    });
    this.clearTokens();
    return res;
  }
  reportUser(
    userId: string,
    body: JsonRecord = {},
    signal?: AbortSignal,
  ): Promise<JsonRecord> {
    return this.request<JsonRecord>(
      `/v1/users/${encodeURIComponent(userId)}/report`,
      { method: "POST", body, signal },
    );
  }

  /** Shared page/nextPage loop (first call sends no `page`). */
  private async listAllPages<P extends Record<string, unknown>, T>(
    fetchPage: (query: PageQuery) => Promise<P>,
    pick: (page: P) => T[] | undefined,
  ): Promise<T[]> {
    // H2 fix: bound the loop. A server repeating the same nextPage (or an
    // invalid one) previously looped forever and grew `all` without limit.
    const MAX_PAGES = 100;
    const seen = new Set<string>();
    const all: T[] = [];
    let page: number | string | undefined;
    for (let n = 0; ; n++) {
      if (n >= MAX_PAGES)
        throw new ZetaError(`listAllPages: too many pages (>${MAX_PAGES})`, 0);
      const res = await fetchPage(page === undefined ? {} : { page });
      all.push(...(pick(res) ?? []));
      const next = (res as { nextPage?: unknown }).nextPage;
      if (next === null || next === undefined) break;
      if ((typeof next !== "number" && typeof next !== "string") || next === "")
        throw new ZetaError(
          `listAllPages: invalid nextPage: ${String(next)}`,
          0,
        );
      const key = String(next);
      if (seen.has(key))
        throw new ZetaError(`listAllPages: repeated nextPage: ${key}`, 0);
      seen.add(key);
      page = next;
    }
    return all;
  }

  listRooms(
    query: PageQuery = {},
    signal?: AbortSignal,
  ): Promise<ListRoomsResponse> {
    return this.request<ListRoomsResponse>("/v1/rooms", { query, signal });
  }
  /** First call sends no page param, then page = previous nextPage until null. */
  listAllRooms(signal?: AbortSignal): Promise<RoomApiDto[]> {
    return this.listAllPages(
      (q) => this.listRooms(q, signal),
      (r) => r.rooms,
    );
  }
  getRoom(roomId: string, signal?: AbortSignal): Promise<RoomApiDto> {
    return this.request<RoomApiDto>(`/v1/rooms/${encodeURIComponent(roomId)}`, {
      signal,
    });
  }
  createRoom(
    body: CreateRoomRequest,
    signal?: AbortSignal,
  ): Promise<RoomApiDto> {
    return this.request<RoomApiDto>("/v1/rooms", {
      method: "POST",
      body,
      signal,
    });
  }
  updateRoom(
    roomId: string,
    body: JsonRecord,
    signal?: AbortSignal,
  ): Promise<RoomApiDto> {
    return this.request<RoomApiDto>(`/v1/rooms/${encodeURIComponent(roomId)}`, {
      method: "PUT",
      body,
      signal,
    });
  }
  deleteRoom(roomId: string, signal?: AbortSignal): Promise<JsonRecord> {
    return this.request<JsonRecord>(`/v1/rooms/${encodeURIComponent(roomId)}`, {
      method: "DELETE",
      signal,
    });
  }
  pinRoom(roomId: string, signal?: AbortSignal): Promise<JsonRecord> {
    return this.request<JsonRecord>(
      `/v1/rooms/${encodeURIComponent(roomId)}/pin`,
      { method: "POST", signal },
    );
  }
  unpinRoom(roomId: string, signal?: AbortSignal): Promise<JsonRecord> {
    return this.request<JsonRecord>(
      `/v1/rooms/${encodeURIComponent(roomId)}/pin`,
      { method: "DELETE", signal },
    );
  }
  cloneRoom(roomId: string, signal?: AbortSignal): Promise<RoomApiDto> {
    return this.request<RoomApiDto>(
      `/v1/rooms/${encodeURIComponent(roomId)}/clone`,
      { method: "POST", signal },
    );
  }
  purgeRooms(signal?: AbortSignal): Promise<JsonRecord> {
    return this.request<JsonRecord>("/v1/rooms/purge", {
      method: "POST",
      signal,
    });
  }
  getActiveRoomId(signal?: AbortSignal): Promise<JsonRecord> {
    return this.request<JsonRecord>("/v1/rooms/active-room-id", { signal });
  }
  getRoomPlotId(roomId: string, signal?: AbortSignal): Promise<JsonRecord> {
    return this.request<JsonRecord>(
      `/v1/rooms/${encodeURIComponent(roomId)}/plot-id`,
      { signal },
    );
  }

  listMessages(
    roomId: string,
    query: {
      limit?: number | string;
      cursor?: string;
      prevCursor?: string;
    } = {},
    signal?: AbortSignal,
  ): Promise<ListMessageResponse> {
    return this.request<ListMessageResponse>(
      `/v1/rooms/${encodeURIComponent(roomId)}/messages`,
      { query, signal },
    );
  }
  updateMessage(
    roomId: string,
    messageId: string,
    body: UpdateMessageRequest,
    signal?: AbortSignal,
  ): Promise<JsonRecord> {
    return this.request<JsonRecord>(
      `/v1/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}`,
      { method: "PUT", body, signal },
    );
  }
  confirmCandidate(
    roomId: string,
    messageId: string,
    candidateId: string,
    signal?: AbortSignal,
  ): Promise<JsonRecord> {
    return this.updateMessage(
      roomId,
      messageId,
      { type: "CANDIDATE", candidateId },
      signal,
    );
  }
  editCandidate(
    roomId: string,
    messageId: string,
    candidateId: string,
    body: { requestId: string; text: string },
    signal?: AbortSignal,
  ): Promise<JsonRecord> {
    return this.request<JsonRecord>(
      `/v1/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}/candidates/${encodeURIComponent(candidateId)}`,
      { method: "PUT", body, signal },
    );
  }
  deleteRoomMessages(
    roomId: string,
    body: JsonRecord = {},
    signal?: AbortSignal,
  ): Promise<JsonRecord> {
    return this.request<JsonRecord>(
      `/v1/rooms/${encodeURIComponent(roomId)}/room-messages`,
      { method: "DELETE", body, signal },
    );
  }

  listPlots(
    query: PageQuery = {},
    signal?: AbortSignal,
  ): Promise<PagePlotResponse> {
    return this.request<PagePlotResponse>("/v1/plots", { query, signal });
  }
  listAllPlots(signal?: AbortSignal): Promise<PlotApiDto[]> {
    return this.listAllPages(
      (q) => this.listPlots(q, signal),
      (r) => r.plots,
    );
  }
  getPlot(plotId: string, signal?: AbortSignal): Promise<DetailedPlotApiDto> {
    return this.request<DetailedPlotApiDto>(
      `/v1/plots/${encodeURIComponent(plotId)}`,
      { signal },
    );
  }
  createPlot(body: JsonRecord, signal?: AbortSignal): Promise<JsonRecord> {
    return this.request<JsonRecord>("/v1/plots", {
      method: "POST",
      body,
      signal,
    });
  }
  updatePlot(
    plotId: string,
    body: JsonRecord,
    signal?: AbortSignal,
  ): Promise<JsonRecord> {
    return this.request<JsonRecord>(`/v1/plots/${encodeURIComponent(plotId)}`, {
      method: "PATCH",
      body,
      signal,
    });
  }
  searchPlots(query: string, signal?: AbortSignal): Promise<PagePlotResponse> {
    return this.request<PagePlotResponse>("/v1/plots/search/autocomplete", {
      query: { query },
      signal,
    });
  }

  searchCreators(query: string, signal?: AbortSignal): Promise<JsonRecord> {
    return this.request<JsonRecord>("/v1/creators/search/autocomplete", {
      query: { query },
      signal,
    });
  }
  getCreatorStats(
    creatorId: string,
    signal?: AbortSignal,
  ): Promise<JsonRecord> {
    return this.request<JsonRecord>(
      `/v1/creators/${encodeURIComponent(creatorId)}/stats`,
      { signal },
    );
  }
  listNotifications(
    query: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<JsonRecord> {
    return this.request<JsonRecord>("/v1/notifications", { query, signal });
  }
  listChatProfiles(signal?: AbortSignal): Promise<JsonRecord[]> {
    return this.request<JsonRecord[]>("/v1/user-chat-profiles", { signal });
  }
  getCoinBalance(signal?: AbortSignal): Promise<JsonRecord> {
    return this.request<JsonRecord>("/v1/coin/balance", { signal });
  }

  /** POST /v1/plots/:plotId/reports (module_3865). */
  createPlotReport(
    plotId: string,
    body: JsonRecord = {},
    signal?: AbortSignal,
  ): Promise<JsonRecord> {
    return this.request<JsonRecord>(
      `/v1/plots/${encodeURIComponent(plotId)}/reports`,
      { method: "POST", body, signal },
    );
  }
  /** POST /v1/lorebooks/:lorebookId/reports (module_3981). */
  createLorebookReport(
    lorebookId: string,
    body: JsonRecord = {},
    signal?: AbortSignal,
  ): Promise<JsonRecord> {
    return this.request<JsonRecord>(
      `/v1/lorebooks/${encodeURIComponent(lorebookId)}/reports`,
      { method: "POST", body, signal },
    );
  }
  /** POST /v1/withdrawal-requests (module_6469). */
  createWithdrawalRequest(
    body: JsonRecord = {},
    signal?: AbortSignal,
  ): Promise<JsonRecord> {
    return this.request<JsonRecord>("/v1/withdrawal-requests", {
      method: "POST",
      body,
      signal,
    });
  }
  /** PUT /v1/rooms/:roomId/user-plot-chat-profiles/:id/selected (module_4703). */
  selectUserPlotChatProfile(
    roomId: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<JsonRecord> {
    return this.request<JsonRecord>(
      `/v1/rooms/${encodeURIComponent(roomId)}/user-plot-chat-profiles/${encodeURIComponent(id)}/selected`,
      { method: "PUT", signal },
    );
  }
  /** POST /v1/rooms/:roomId/user-plot-chat-profiles/selected (module_4703). */
  createAndSelectUserPlotChatProfile(
    roomId: string,
    body: JsonRecord,
    signal?: AbortSignal,
  ): Promise<JsonRecord> {
    return this.request<JsonRecord>(
      `/v1/rooms/${encodeURIComponent(roomId)}/user-plot-chat-profiles/selected`,
      { method: "POST", body, signal },
    );
  }

  /** Typed payload ({kind:"text"|"cyoa"|"plugin"}) is mapped to the wire body; a raw JsonRecord passes through verbatim. */
  async *sendMessageStream(
    roomId: string,
    body: JsonRecord | SendMessagePayload,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatStreamChunk> {
    const wire =
      (body as SendMessagePayload).kind !== undefined
        ? buildSendMessageBody(body as SendMessagePayload)
        : (body as JsonRecord);
    const res = await this.streamRequest(
      `/v1/rooms/${encodeURIComponent(roomId)}/messages/stream`,
      wire,
      signal,
    );
    yield* parseStreamChunks(res.body);
  }

  /** Body shape from room-UjsQENDl.js `regenerateMessage`. */
  async *regenerateCandidateStream(
    roomId: string,
    messageId: string,
    body: RegenerateMessageRequest = {},
    signal?: AbortSignal,
  ): AsyncGenerator<ChatStreamChunk> {
    const res = await this.streamRequest(
      `/v1/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}/candidates/stream`,
      body,
      signal,
    );
    yield* parseStreamChunks(res.body);
  }
}
