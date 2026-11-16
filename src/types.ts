// DTOs recovered from Hermes fn1652 / dto-fields2.json (class-transformer Type() literals).
// Fields marked [] in the analysis are unknown, NOT empty: every DTO keeps an index signature, all fields optional.

export type JsonRecord = Record<string, unknown>;

export interface ZetaClientOptions {
  accessToken?: string;
  refreshToken?: string;
  deviceId?: string;
  /** BuildConfig BACKEND_API_URL. */
  baseUrl?: string;
  /** Sent as `x-api-key` when set. No value was found in the APK. */
  apiKey?: string;
  clientVersion?: string;
  nativeVersion?: string;
  language?: string;
  extraHeaders?: Record<string, string>;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
  onTokensRefreshed?: (tokens: {
    accessToken: string;
    refreshToken: string;
  }) => void;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

/** Chat-send payload as the app builds it (room-UjsQENDl.js `Eo`). */
export type SendMessagePayload =
  | { kind: "text"; text: string; recommendedMessageId?: string }
  | { kind: "cyoa"; title: string; text: string }
  | { kind: "plugin"; pluginId: string; content: unknown };

/** Wire body for POST /v1/rooms/:roomId/messages/stream (webview JS, verified). */
export type ChatSendMessageRequest =
  | { type: "TEXT"; text: string; recommendedMessageId?: string }
  | { type: "CYOA"; title: string; text: string; cyoaType: "DIALOGUE" }
  | { type: "PLUGIN"; pluginId: string; content: unknown };

/** `cyoaType` is always "DIALOGUE" (gen-BT-d5in2.js). */
export function buildSendMessageBody(
  payload: SendMessagePayload,
): ChatSendMessageRequest {
  switch (payload.kind) {
    case "cyoa":
      return {
        type: "CYOA",
        title: payload.title,
        text: payload.text,
        cyoaType: "DIALOGUE",
      };
    case "plugin":
      return {
        type: "PLUGIN",
        pluginId: payload.pluginId,
        content: payload.content,
      };
    default:
      return {
        type: "TEXT",
        text: payload.text,
        recommendedMessageId: payload.recommendedMessageId,
      };
  }
}

/** PUT /v1/rooms/:roomId/messages/:messageId body (room-UjsQENDl.js `confirmCandidate`). */
export type UpdateMessageRequest =
  { type: "CANDIDATE"; candidateId: string } | JsonRecord;

export interface RegenerateMessageRequest {
  guidePrompt?: string;
  targetCandidateId?: string;
}

/** POST /v1/auth/tokens {type:"external"} body (module_4161:212). */
export interface ExternalToken {
  token: string;
  issuer:
    "GOOGLE" | "APPLE" | "KAKAO" | "FACEBOOK" | "LINE" | "INTERNAL_ACCESS";
  /** Apple only: givenName + familyName. */
  name?: string;
}

/** Pagination wire protocol (2102_axiosInstance.js:33, 2101/2159). */
export interface PageQuery {
  /** First page: omit `page` entirely (axios drops undefined). Then page = nextPage. */
  page?: number | string;
  [key: string]: unknown;
}

/** POST /v1/rooms body. chatProfile discriminator: `userChatProfileId` or `plotChatProfileContent`. */
export interface CreateRoomRequest {
  chatProfile: JsonRecord;
  [key: string]: unknown;
}

export interface MessageContent {
  type?: "TEXT" | "TOPIC" | "IMAGE" | "INFO_BOX" | "PLUGIN" | string;
  [key: string]: unknown;
}

export interface MessageApiDto {
  sender?: JsonRecord;
  contents?: MessageContent[];
  voice?: JsonRecord;
  messageTime?: string;
  snapshotImage?: JsonRecord;
  cyoa?: JsonRecord;
  plugins?: JsonRecord[];
  [key: string]: unknown;
}

export interface RoomApiDto {
  createdAt?: string;
  lastMessage?: MessageApiDto;
  plot?: JsonRecord;
  savedAt?: string;
  penalty?: JsonRecord;
  [key: string]: unknown;
}

export interface ListRoomsResponse {
  rooms?: RoomApiDto[];
  [key: string]: unknown;
}

export interface ListMessageResponse {
  messages?: MessageApiDto[];
  [key: string]: unknown;
}

export interface PlotApiDto {
  id?: string;
  plotId?: string;
  name?: string;
  [key: string]: unknown;
}

export interface DetailedPlotApiDto extends PlotApiDto {
  characters?: JsonRecord[];
  chatProfiles?: JsonRecord[];
  conversations?: JsonRecord[];
  intros?: JsonRecord[];
  about?: JsonRecord;
  createdAt?: string;
  releasedAt?: string;
  updatedAt?: string;
  creator?: JsonRecord;
  contestCategory?: JsonRecord;
  lorebooks?: JsonRecord[];
  infoBoxSetting?: JsonRecord;
  cyoaSetting?: JsonRecord;
}

export interface PagePlotResponse {
  plots?: PlotApiDto[];
  /** Pagination keys seen in the client: data / page / nextPage. Param names unconfirmed. */
  page?: unknown;
  nextPage?: unknown;
  [key: string]: unknown;
}

export interface UserMeResponse {
  additionalAuthExpiresAt?: string;
  createdAt?: string;
  tier?: string;
  [key: string]: unknown;
}

export interface UserApiDto {
  id?: string;
  userId?: string;
  username?: string;
  nickname?: string;
  [key: string]: unknown;
}

/** One chunk from POST …/messages/stream. No `type` field on the base DTO — discriminate by field presence. */
export type ChatStreamChunk = {
  /** Discriminator (4959_useChatStream.js:101): IN_PROGRESS, CHAT_COMPLETE,
   * CANDIDATE_COMPLETE, EXAMPLE_CHAT_COMPLETE, CHAT_OPTION_COMPLETE,
   * RECOMMENDED_MESSAGE_COMPLETE, CHAT_INTERIM_COMPLETE, AUTO_PAYMENT_CHARGED,
   * CHANGE_FACIAL, CYOA, ERROR, DETECT_ABUSING. */
  event?: string;
  replyMessage?: MessageApiDto;
  requestMessage?: MessageApiDto;
  candidate?: JsonRecord;
  chunkMessage?: MessageApiDto;
  replyOption?: JsonRecord;
  data?: JsonRecord;
  penalty?: JsonRecord;
  timestamp?: number;
  [key: string]: unknown;
};

export interface Creator {
  id?: string;
  creatorId?: string;
  username?: string;
  [key: string]: unknown;
}
