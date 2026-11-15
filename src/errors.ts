import type { ExceptionCodeValue } from "./exception-codes.ts";

/** `status` is 0 when the request never reached the server. */
export class ZetaError extends Error {
  readonly status: number;
  /** Server ExceptionCode string when the error body carried one. */
  readonly code: ExceptionCodeValue | string | undefined;
  readonly body: string | undefined;
  constructor(message: string, status = 0, body?: string, code?: string) {
    super(message);
    this.name = "ZetaError";
    this.status = status;
    this.body = body;
    this.code = code;
  }
}
