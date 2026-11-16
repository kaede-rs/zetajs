# zetajs

An unofficial client for zeta.

[![技術者倫理 遵守済み](https://img.shields.io/badge/%E6%8A%80%E8%A1%93%E8%80%85%E5%80%AB%E7%90%86-%E9%81%B5%E5%AE%88%E6%B8%88%E3%81%BF-0a0a0a?style=for-the-badge&labelColor=ffffff)](https://技術者倫理.com)
[![JSR](https://jsr.io/badges/@kaede/zetajs)](https://jsr.io/@kaede/zetajs)

## Installation

```bash
deno add jsr:@kaede/zetajs
# or
npx jsr add @kaede/zetajs
```

For local development:

```bash
bun i
bun test
bun run check
```

## Usage

```ts
import { ZetaClient } from "jsr:@kaede/zetajs";

const client = new ZetaClient({
  accessToken: process.env.ZETA_ACCESS_TOKEN,
  refreshToken: process.env.ZETA_REFRESH_TOKEN, // enables auto-refresh
});
const me = await client.getMe();
const { rooms } = await client.listRooms();
const room = await client.createRoom({
  chatProfile: { type: "userChatProfileId", userChatProfileId: "…" },
});

for await (const chunk of client.sendMessageStream(room.id as string, {
  kind: "text",
  text: "Hello, zeta!",
})) {
  console.log(chunk.chunkMessage ?? chunk.replyMessage);
}
```

From a local checkout, import from `./src/index.ts` instead.

## Authentication

You can log in directly against zeta's API.

```ts
// Google / Apple / Kakao / Facebook / LINE — token from the platform SDK
const tokens = await client.loginWithExternalToken({
  token: idToken, // Google idToken / Apple identityToken
  issuer: "GOOGLE",
  name: "Given Family", // Apple only
});
// 404 → account not signed up: client.checkSignup({ token, issuer })
// Internal/debug login: await client.loginInternal(username, password)
```

- `POST /v1/auth/tokens` — Issues and refreshes tokens. To refresh, send `{deviceId, type:"refresh", refreshToken}` and you'll get back `{newAccessToken, newRefreshToken}`. The client refreshes proactively when the JWT's `exp` is within 30 seconds, and retries once if it gets a 401. Token responses are accepted as `{accessToken, refreshToken}` or `{newAccessToken, newRefreshToken}`, top-level or nested under `data`.
- `POST /v1/auth/sso/code` — Call it with `{}` and it returns `{code}`. From there, redirect to `<SUPPORT_URL>/sso?code=<code>&to=<path>`. See `buildSsoRedirectUrl()` for details.
- `POST /v1/auth/tokens/sso-access-token` — Implemented, but the request body is unknown.

## API Overview

| Area     | Methods                                                                                                                                                                                   |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| auth     | `loginWithExternalToken`, `loginInternal`, `checkSignup`, `issueToken`, `refreshAccessToken`, `generateSsoCode`, `exchangeSsoAccessToken`, `getConnectedExternalPlatforms`                |
| users    | `getMe`, `updateMe`, `getUser`, `getUserIdByUsername`, `logout`, `reportUser`                                                                                                             |
| rooms    | `listRooms`, `listAllRooms`, `getRoom`, `createRoom`, `updateRoom`, `deleteRoom`, `pinRoom`, `unpinRoom`, `cloneRoom`, `purgeRooms`, `getActiveRoomId`, `getRoomPlotId`                   |
| messages | `listMessages` (cursors: `limit` / `cursor` / `prevCursor`), `updateMessage`, `confirmCandidate`, `editCandidate`, `deleteRoomMessages`, `sendMessageStream`, `regenerateCandidateStream` |
| plots    | `listPlots`, `listAllPlots`, `getPlot`, `createPlot`, `updatePlot`, `searchPlots`                                                                                                         |
| reports  | `createPlotReport`, `createLorebookReport`, `createWithdrawalRequest`, `selectUserPlotChatProfile`, `createAndSelectUserPlotChatProfile`                                                  |
| misc     | `searchCreators`, `getCreatorStats`, `listNotifications`, `listChatProfiles`, `getCoinBalance`                                                                                            |

For pagination, make the first request without a `page` parameter. For each following page, pass the returned `nextPage` as `page`, and stop once `nextPage` is null. `listAllRooms` / `listAllPlots` handle this loop for you.

`src/endpoints.ts` contains the full Tier-1 list: 331 unique paths and 400 methods in total. `src/exception-codes.ts` contains all 376 server-side `ExceptionCode` strings, which show up in `ZetaError.code`.

Chat chunks have an `event` field (`IN_PROGRESS`, `CHAT_COMPLETE`, `CANDIDATE_COMPLETE`, `CHAT_OPTION_COMPLETE`, `RECOMMENDED_MESSAGE_COMPLETE`, and so on). Tell chunks apart by `event` first, then by which fields are present (`chunkMessage`, `replyMessage`, `candidate`, `replyOption`, `penalty`). There is no `type` field.

## Disclaimer

This is unofficial, so you might get banned. The author takes no responsibility for whatever happens.
