// Chat stream parser, mirroring the app (fn51718).
// Also accepts plain NDJSON lines (no `data:` prefix) so mocked / proxied streams keep working.

export async function* parseStreamChunks(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<Record<string, unknown>> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf("\n\n");
      while (idx >= 0) {
        yield* parseEvent(buf.slice(0, idx));
        buf = buf.slice(idx + 2);
        idx = buf.indexOf("\n\n");
      }
    }
    buf += decoder.decode();
    yield* parseEvent(buf);
  } finally {
    reader.releaseLock();
  }
}

function* parseEvent(event: string): Generator<Record<string, unknown>> {
  for (const rawLine of event.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith(":")) continue;
    const data = line.startsWith("data:") ? line.slice(5).trim() : line;
    if (!data || data === "[DONE]") continue;
    try {
      const parsed: unknown = JSON.parse(data);
      yield {
        ...(typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : { value: parsed }),
        timestamp: Date.now(),
      };
    } catch {
      yield { raw: data, timestamp: Date.now() };
    }
  }
}
