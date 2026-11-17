// Chat stream parser, mirroring the app (fn51718).
// Also accepts plain NDJSON lines (no `data:` prefix) so mocked / proxied streams keep working.

export async function* parseStreamChunks(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<Record<string, unknown>> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let start = 0; // offset of the first unprocessed byte
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // H4 fix: normalize CRLF -> LF. A lone trailing \r is left in place so
      // a \r\n split across reads still normalizes on the next append.
      buf = buf.replace(/\r\n/g, "\n");
      let b = findBoundary(buf, start);
      while (b !== null) {
        yield* parseEvent(buf.slice(start, b.end));
        start = b.next;
        b = findBoundary(buf, start);
      }
      // Compact once per read: only the trailing partial event stays, so the
      // next append never copies already-consumed bytes.
      if (start > 0) {
        buf = buf.slice(start);
        start = 0;
      }
    }
    buf += decoder.decode();
    buf = buf.replace(/\r/g, "\n");
    if (start < buf.length) yield* parseEvent(buf.slice(start));
  } finally {
    reader.releaseLock();
  }
}

/**
 * Next event boundary at or after `start`, or null if the buffer holds only
 * a partial event. Two forms:
 * - SSE: a blank line (`\n\n`) ends the event.
 * - NDJSON (H5 fix): a bare JSON line ending in a single `\n` is its own
 *   event, so it streams before EOF instead of waiting for a blank line.
 *   Lines starting with `data:` / `:` / `event:` are SSE, not NDJSON.
 */
function findBoundary(
  buf: string,
  start: number,
): { end: number; next: number } | null {
  const dbl = buf.indexOf("\n\n", start);
  const nl = buf.indexOf("\n", start);
  if (nl >= 0 && (dbl < 0 || nl < dbl)) {
    const line = buf.slice(start, nl).trim();
    if (
      (line.startsWith("{") && line.endsWith("}")) ||
      (line.startsWith("[") && line.endsWith("]"))
    ) {
      try {
        JSON.parse(line);
        return { end: nl, next: nl + 1 };
      } catch {
        // Incomplete / invalid JSON: wait for more data.
      }
    }
  }
  if (dbl >= 0) return { end: dbl, next: dbl + 2 };
  return null;
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
