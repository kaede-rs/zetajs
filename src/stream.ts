// Chat stream parser, mirroring the app (fn51718).
// Also accepts plain NDJSON lines (no `data:` prefix) so mocked / proxied streams keep working.

export async function* parseStreamChunks(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<Record<string, unknown>> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let start = 0; // offset of the first unprocessed byte; buf is only compacted past 64KB
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf("\n\n", start);
      while (idx >= 0) {
        yield* parseEvent(buf.slice(start, idx));
        start = idx + 2;
        idx = buf.indexOf("\n\n", start);
      }
      // Compact once per read: only the trailing partial event stays, so the
      // next append never copies already-consumed bytes (old code re-sliced
      // after every event; never compacting re-copies the whole prefix).
      if (start > 0) {
        buf = buf.slice(start);
        start = 0;
      }
    }
    buf += decoder.decode();
    if (start < buf.length) yield* parseEvent(buf.slice(start));
  } finally {
    reader.releaseLock();
  }
}

function* parseEvent(event: string): Generator<Record<string, unknown>> {
  let pos = 0;
  while (pos <= event.length) {
    const nl = event.indexOf("\n", pos);
    const line = event.slice(pos, nl < 0 ? event.length : nl).trim();
    pos = nl < 0 ? event.length + 1 : nl + 1;
    if (!line || line.startsWith(":")) continue;
    const data = line.startsWith("data:") ? line.slice(5).trim() : line;
    if (!data || data === "[DONE]") continue;
    try {
      const parsed: unknown = JSON.parse(data);
      if (typeof parsed === "object" && parsed !== null) {
        // Fresh from JSON.parse: stamping in place avoids a full-object spread copy.
        (parsed as Record<string, unknown>).timestamp = Date.now();
        yield parsed as Record<string, unknown>;
      } else {
        yield { value: parsed, timestamp: Date.now() };
      }
    } catch {
      yield { raw: data, timestamp: Date.now() };
    }
  }
}
