import { ZetaClient } from "../src/index.ts";

const token = process.env.ZETA_ACCESS_TOKEN;
const [roomId, ...rest] = Bun.argv.slice(2);
if (!token || !roomId || rest.length === 0) {
  console.error("usage: ZETA_ACCESS_TOKEN=... bun examples/chat.ts <roomId> <message>");
  process.exit(1);
}
const client = new ZetaClient({ accessToken: token, refreshToken: process.env.ZETA_REFRESH_TOKEN });
// Each chunk carries the full message text so far, not just the new part.
let printed = "";
for await (const chunk of client.sendMessageStream(roomId, { kind: "text", text: rest.join(" ") })) {
  const msg = chunk.chunkMessage ?? chunk.replyMessage;
  const text = (msg?.contents ?? [])
    .map((c) => (typeof c === "object" && c !== null ? (c as { text?: unknown }).text : undefined))
    .filter((t): t is string => typeof t === "string")
    .join("");
  if (!text || printed.startsWith(text)) continue;
  if (text.startsWith(printed)) {
    process.stdout.write(text.slice(printed.length));
  } else {
    process.stdout.write(text);
  }
  printed = text;
}
process.stdout.write("\n");
