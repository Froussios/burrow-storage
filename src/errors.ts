// API-13: every rejection is a BurrowError with a stable code. BE-4: adapters reject BackendError.

export type BurrowErrorCode =
  | "no-provider"
  | "prf-unsupported"
  | "bad-code"
  | "item-too-large"
  | "backend"
  | "conflict"
  | "quota"
  | "decrypt-failed"
  | "would-orphan";

export class BurrowError extends Error {
  override readonly name = "BurrowError";
  readonly code: BurrowErrorCode;
  constructor(code: BurrowErrorCode, message?: string, options?: { cause?: unknown }) {
    super(message ?? code, options?.cause === undefined ? undefined : { cause: scrub(options.cause) });
    this.code = code;
  }
}

export type BackendErrorCode = "conflict" | "unauthorized" | "too-large" | "quota" | "network";

export class BackendError extends Error {
  override readonly name = "BackendError";
  readonly code: BackendErrorCode;
  constructor(code: BackendErrorCode, message?: string, options?: { cause?: unknown }) {
    super(message ?? code, options?.cause === undefined ? undefined : { cause: scrub(options.cause) });
    this.code = code;
  }
}

// SEC-8: ids are 43-char base64url strings and tokens are base64url/hex; never let them reach
// a cause, message or log. Replace any such run with a placeholder.
const SECRETISH = /[A-Za-z0-9_-]{40,}/g;
export const scrubText = (s: string): string => s.replace(SECRETISH, "[redacted]");

export function scrub(cause: unknown): unknown {
  if (cause instanceof BurrowError || cause instanceof BackendError) return cause;
  if (cause instanceof Error) {
    const e = new Error(scrubText(cause.message));
    e.name = cause.name;
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string") (e as Error & { code?: string }).code = code;
    return e;
  }
  if (typeof cause === "string") return scrubText(cause);
  return undefined;
}

/** Map a backend failure onto the public error enum (API-13). */
export function fromBackend(e: unknown): BurrowError {
  if (e instanceof BurrowError) return e;
  if (e instanceof BackendError) {
    if (e.code === "conflict") return new BurrowError("conflict", undefined, { cause: e });
    if (e.code === "quota") return new BurrowError("quota", undefined, { cause: e });
    if (e.code === "too-large") return new BurrowError("item-too-large", undefined, { cause: e });
  }
  return new BurrowError("backend", undefined, { cause: e });
}
