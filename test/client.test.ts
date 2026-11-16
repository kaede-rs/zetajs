import { describe, expect, test } from "bun:test";
import { ENDPOINTS, ExceptionCode, ZetaClient, ZetaError, loginWithAccessToken } from "../src/index.ts";

function mockFetch(calls: { url: string; init: unknown }[], body: unknown, status = 200): typeof fetch {
  return (async (url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}

function expiredJwt(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp: Math.floor(Date.now() / 1000) - 10 })}.sig`;
}

describe("ZetaClient", () => {
  test("sends Bearer token + app headers to api.zeta-ai.io", async () => {
    const calls: { url: string; init: unknown }[] = [];
    const client = loginWithAccessToken("tok123", { fetch: mockFetch(calls, { id: "me" }), deviceId: "dev-1" });
    await client.getMe();
    expect(calls[0].url).toBe("https://api.zeta-ai.io/v1/users/me");
    expect((calls[0].init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer tok123",
      "X-Client-Type": "app",
      "X-Device-Type": "android",
      "X-Client-Version": "3.51.94",
      "X-Client-Native-Version": "3.51.94",
      "X-Sticky": "dev-1",
    });
  });

  test("createRoom posts CreateRoomRequest to /v1/rooms (not /v1/rooms/plots/:id)", async () => {
    const calls: { url: string; init: unknown }[] = [];
    const client = new ZetaClient({ fetch: mockFetch(calls, { id: "r1" }) });
    await client.createRoom({ chatProfile: { type: "userChatProfileId", userChatProfileId: "p1" } });
    expect(calls[0].url).toBe("https://api.zeta-ai.io/v1/rooms");
    expect((calls[0].init as RequestInit).method).toBe("POST");
    expect((calls[0].init as RequestInit).body).toContain("userChatProfileId");
  });

  test("listRooms returns the {rooms} envelope", async () => {
    const client = new ZetaClient({ fetch: mockFetch([], { rooms: [{ id: "r1" }] }) });
    const res = await client.listRooms();
    expect(res.rooms).toEqual([{ id: "r1" }]);
  });

  test("non-2xx throws ZetaError with status + ExceptionCode", async () => {
    const client = new ZetaClient({ fetch: mockFetch([], { code: "ROOM_NOT_ACTIVE" }, 403) });
    await expect(client.getMe()).rejects.toMatchObject({ status: 403, code: "ROOM_NOT_ACTIVE" });
    await expect(client.getMe()).rejects.toBeInstanceOf(ZetaError);
  });

  test("expired token triggers refresh before the request", async () => {
    const calls: { url: string; init: unknown }[] = [];
    const fetchFn = (async (url: unknown, init?: unknown) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/v1/auth/tokens")) {
        return new Response(JSON.stringify({ newAccessToken: "new-tok", newRefreshToken: "new-ref" }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "me" }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new ZetaClient({ fetch: fetchFn, deviceId: "dev-1" });
    client.setTokens({ accessToken: expiredJwt(), refreshToken: "old-ref" });
    await client.getMe();
    expect(calls[0].url).toBe("https://api.zeta-ai.io/v1/auth/tokens");
    expect((calls[0].init as RequestInit).body).toContain('"type":"refresh"');
    expect((calls[0].init as RequestInit).body).toContain('"deviceId":"dev-1"');
    expect(calls[1].url).toBe("https://api.zeta-ai.io/v1/users/me");
    expect(client.token).toBe("new-tok");
  });

  test("401 retries once after refresh", async () => {
    let n = 0;
    const fetchFn = (async (url: unknown) => {
      n += 1;
      if (String(url).endsWith("/v1/auth/tokens")) {
        return new Response(JSON.stringify({ newAccessToken: "t2", newRefreshToken: "r2" }), { status: 200 });
      }
      if (n === 1) return new Response(JSON.stringify({ code: "AUTH_EXPIRED" }), { status: 401 });
      return new Response(JSON.stringify({ id: "me" }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new ZetaClient({ fetch: fetchFn });
    client.setTokens({ accessToken: "t1", refreshToken: "r1" });
    const me = await client.getMe();
    expect(me).toEqual({ id: "me" });
    expect(n).toBe(3); // me -> refresh -> me
  });

  test("sendMessageStream retries once on 401 after refresh", async () => {
    let n = 0;
    const fetchFn = (async (url: unknown) => {
      n += 1;
      if (String(url).endsWith("/v1/auth/tokens")) {
        return new Response(JSON.stringify({ newAccessToken: "t2", newRefreshToken: "r2" }), { status: 200 });
      }
      if (n === 1) return new Response(JSON.stringify({ code: "AUTH_EXPIRED" }), { status: 401 });
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"chunkMessage":{"contents":[{"text":"hi"}]}}\n\n'));
          c.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;
    const client = new ZetaClient({ fetch: fetchFn });
    client.setTokens({ accessToken: "t1", refreshToken: "r1" });
    const chunks = [];
    for await (const ch of client.sendMessageStream("r1", { kind: "text", text: "hi" })) chunks.push(ch);
    expect(chunks).toHaveLength(1);
    expect(n).toBe(3); // stream -> refresh -> stream
    expect(client.token).toBe("t2");
  });

  test("sendMessageStream parses SSE events split on blank lines", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        c.enqueue(enc.encode('data: {"chunkMessage":{"contents":[{"type":"TEXT"}]}}\n\n'));
        c.enqueue(enc.encode('data: {"replyMessage":{"contents":[]}}\n\n: ping\n\n'));
        c.close();
      },
    });
    const client = loginWithAccessToken("t", { fetch: (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch });
    const chunks = [];
    for await (const ch of client.sendMessageStream("r1", { text: "hello" })) chunks.push(ch);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].chunkMessage).toBeDefined();
    expect(chunks[1].replyMessage).toBeDefined();
    expect(typeof chunks[0].timestamp).toBe("number");
  });

  test("Tier-1 inventory covers the stream + auth + rooms paths", () => {
    const keys = new Set(ENDPOINTS.map((e) => `${e.method} ${e.path}`));
    expect(keys.has("POST /v1/rooms/:roomId/messages/stream")).toBe(true);
    expect(keys.has("POST /v1/auth/tokens")).toBe(true);
    expect(keys.has("GET /v1/rooms")).toBe(true);
    expect(keys.has("POST /v1/rooms")).toBe(true);
    expect(keys.has("GET /v1/plots/:plotId")).toBe(true);
    expect(keys.has("POST /v1/plots/:plotId/reports")).toBe(true);
    expect(keys.has("PUT /v1/rooms/:roomId/user-plot-chat-profiles/:id/selected")).toBe(true);
    expect(ENDPOINTS.length).toBe(400);
  });

  test("loginWithExternalToken posts type external with issuer", async () => {
    const calls: { url: string; init: unknown }[] = [];
    const client = new ZetaClient({ fetch: mockFetch(calls, { accessToken: "a1", refreshToken: "r1" }), deviceId: "dev-9" });
    const tokens = await client.loginWithExternalToken({ token: "id-token", issuer: "GOOGLE" });
    expect(tokens).toEqual({ accessToken: "a1", refreshToken: "r1" });
    expect(calls[0].url).toBe("https://api.zeta-ai.io/v1/auth/tokens");
    expect((calls[0].init as RequestInit).body).toBe(
      JSON.stringify({ deviceId: "dev-9", type: "external", externalToken: { token: "id-token", issuer: "GOOGLE" } }),
    );
    expect(client.token).toBe("a1");
  });

  test("generateSsoCode posts an empty body", async () => {
    const calls: { url: string; init: unknown }[] = [];
    const client = new ZetaClient({ fetch: mockFetch(calls, { code: "abc" }) });
    await client.generateSsoCode();
    expect((calls[0].init as RequestInit).body).toBe("{}");
  });

  test("listAllRooms follows page/nextPage and sends no page on first call", async () => {
    const calls: { url: string; init: unknown }[] = [];
    const fetchFn = (async (url: unknown) => {
      calls.push({ url: String(url), init: {} });
      const u = String(url);
      if (u.includes("page=2")) return new Response(JSON.stringify({ rooms: [{ id: "r2" }], nextPage: null }), { status: 200 });
      return new Response(JSON.stringify({ rooms: [{ id: "r1" }], nextPage: 2 }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new ZetaClient({ fetch: fetchFn });
    const rooms = await client.listAllRooms();
    expect(rooms.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(calls[0].url).not.toContain("page=");
    expect(calls[1].url).toContain("page=2");
  });

  test("stream chunks carry the event discriminator", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"event":"IN_PROGRESS","chunkMessage":{}}\n\ndata: {"event":"CHAT_COMPLETE","replyMessage":{}}\n\n'));
        c.close();
      },
    });
    const client = loginWithAccessToken("t", { fetch: (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch });
    const chunks = [];
    for await (const ch of client.sendMessageStream("r1", { kind: "text", text: "hi" })) chunks.push(ch);
    expect(chunks.map((c) => c.event)).toEqual(["IN_PROGRESS", "CHAT_COMPLETE"]);
  });

  test("sendMessageStream maps typed payloads to the verified wire body", async () => {
    const seen: string[] = [];
    const fetchFn = (async (url: unknown, init: unknown) => {
      seen.push(String((init as RequestInit).body));
      return new Response(new ReadableStream({ start(c) { c.close(); } }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = loginWithAccessToken("t", { fetch: fetchFn });
    for await (const _ of client.sendMessageStream("r1", { kind: "text", text: "hello" })) { /* drain */ }
    for await (const _ of client.sendMessageStream("r1", { kind: "cyoa", title: "t", text: "x" })) { /* drain */ }
    for await (const _ of client.sendMessageStream("r1", { kind: "plugin", pluginId: "p1", content: { a: 1 } })) { /* drain */ }
    expect(seen[0]).toBe(JSON.stringify({ type: "TEXT", text: "hello" }));
    expect(seen[1]).toBe(JSON.stringify({ type: "CYOA", title: "t", text: "x", cyoaType: "DIALOGUE" }));
    expect(seen[2]).toBe(JSON.stringify({ type: "PLUGIN", pluginId: "p1", content: { a: 1 } }));
  });

  test("confirm / edit candidate send verified bodies", async () => {
    const calls: { url: string; init: unknown }[] = [];
    const client = loginWithAccessToken("t", { fetch: mockFetch(calls, {}) });
    await client.confirmCandidate("r1", "m1", "c1");
    expect(calls[0].url).toBe("https://api.zeta-ai.io/v1/rooms/r1/messages/m1");
    expect((calls[0].init as RequestInit).body).toBe(JSON.stringify({ type: "CANDIDATE", candidateId: "c1" }));
    await client.editCandidate("r1", "m1", "c1", { requestId: "q1", text: "new" });
    expect(calls[1].url).toBe("https://api.zeta-ai.io/v1/rooms/r1/messages/m1/candidates/c1");
    expect((calls[1].init as RequestInit).body).toBe(JSON.stringify({ requestId: "q1", text: "new" }));
  });

  test("listMessages sends cursor pagination params", async () => {
    const calls: { url: string; init: unknown }[] = [];
    const client = loginWithAccessToken("t", { fetch: mockFetch(calls, { messages: [] }) });
    await client.listMessages("r1", { limit: 20, cursor: "abc" });
    expect(calls[0].url).toContain("limit=20");
    expect(calls[0].url).toContain("cursor=abc");
  });

  test("ExceptionCode values are derived verbatim, incl. digit keys", () => {
    expect(ExceptionCode.NotFound).toBe("NOT_FOUND");
    expect(ExceptionCode.AuthExpired).toBe("AUTH_EXPIRED");
    expect(ExceptionCode.AppUpdateRequired).toBe("APP_UPDATE_REQUIRED");
    expect(ExceptionCode.Frame4cutEventClosed).toBe("FRAME_4CUT_EVENT_CLOSED");
    expect(ExceptionCode.Zetto2InvalidVideoUrl).toBe("ZETTO2_INVALID_VIDEO_URL");
    expect(ExceptionCode.AnonymousBoardNotAPoll).toBe("ANONYMOUS_BOARD_NOT_A_POLL");
    expect(Object.keys(ExceptionCode)).toHaveLength(376);
  });

  test("ENDPOINTS entries are {method, path} objects built from compact specs", () => {
    expect(ENDPOINTS[0]).toEqual({ method: "GET", path: "/debug/dev-server" });
    expect(new Set(ENDPOINTS.map((e) => e.path)).size).toBe(331);
  });

  test("stream parser handles events split mid-JSON across reads", async () => {
    const enc = new TextEncoder();
    const full = 'data: {"event":"IN_PROGRESS","chunkMessage":{"contents":[{"type":"TEXT","text":"hello"}]}}\n\n';
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        // split inside the JSON payload, and deliver two events in one read
        c.enqueue(enc.encode(full.slice(0, 20)));
        c.enqueue(enc.encode(full.slice(20) + full));
        c.close();
      },
    });
    const client = loginWithAccessToken("t", { fetch: (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch });
    const chunks = [];
    for await (const ch of client.sendMessageStream("r1", { kind: "text", text: "hi" })) chunks.push(ch);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].event).toBe("IN_PROGRESS");
  });

  test("streamRequest network failure throws ZetaError, not the raw error", async () => {
    const fetchFn = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const client = loginWithAccessToken("t", { fetch: fetchFn });
    await expect((async () => {
      for await (const _ of client.sendMessageStream("r1", { kind: "text", text: "hi" })) { /* drain */ }
    })()).rejects.toBeInstanceOf(ZetaError);
  });
});
