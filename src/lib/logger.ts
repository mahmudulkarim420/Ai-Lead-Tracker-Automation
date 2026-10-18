/**
 * Structured JSON logging + request-scoped context.
 *
 * Uses pino (lightweight, maintained) for JSON output and Node's built-in
 * AsyncLocalStorage to propagate a per-request context (currently just the
 * request id) to logs emitted anywhere inside the request's async call graph.
 *
 * Design notes
 * ------------
 * - Log level is configurable via LOG_LEVEL and validated at startup.
 * - A shallow denylist redacts common secret-bearing keys defensively; the
 *   application intentionally never logs request bodies or raw messages.
 * - `errorInfo()` converts an unknown thrown value into a small, safe object
 *   (name / message / category) suitable for structured logs WITHOUT dumping
 *   stack traces or arbitrary internal details.
 * - `setLogSink()` lets tests capture emitted log records instead of writing
 *   them to stdout. It is off by default in production, so there is no test
 *   coupling in the running app.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { pino, type Logger } from "pino";

// ---------------------------------------------------------------------------
// Log level configuration (validated env var)
// ---------------------------------------------------------------------------

/** Boolean/silent levels accepted by pino 10 (high → low verbosity). */
const PINO_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
type PinoLevel = (typeof PINO_LEVELS)[number];

/** Level names we accept as configuration input. */
const CONFIGURABLE_LEVELS = ["error", "warn", "info", "debug"] as const;
type LogLevel = (typeof CONFIGURABLE_LEVELS)[number];

const DEFAULT_LOG_LEVEL: LogLevel = "info";

/**
 * Parse LOG_LEVEL into a pino level.
 * Unset / empty → "info". Present-but-invalid → throw at startup so a typo is
 * never silently ignored.
 */
function parseLogLevel(raw: string | undefined): PinoLevel {
  if (raw === undefined || raw === "") return DEFAULT_LOG_LEVEL;
  const normalized = raw.toLowerCase();
  if ((CONFIGURABLE_LEVELS as readonly string[]).includes(normalized)) {
    return normalized as PinoLevel;
  }
  throw new Error(
    `Invalid LOG_LEVEL value "${raw}": use one of ${CONFIGURABLE_LEVELS.join(", ")}.`,
  );
}

export const LOG_LEVEL: PinoLevel = parseLogLevel(process.env["LOG_LEVEL"]);

// ---------------------------------------------------------------------------
// Defensive redaction
// ---------------------------------------------------------------------------

/**
 * Keys whose values are replaced with "[REDACTED]" at any nesting depth.
 * This is a safety net only: the application must never pass these in the
 * first place (request bodies / raw messages are never logged).
 */
const REDACT_PATHS = [
  // Credentials / auth material at any depth.
  "password",
  "token",
  "authorization",
  "cookie",
  "set-cookie",
  "*.password",
  "*.token",
  "*.authorization",
  "*.cookie",
  // Request payloads: never log the raw lead `message` or any request body.
  // NOTE: these are top-level / body-scoped only. A nested `errorDetails.message`
  // (the error's own description) is intentionally kept visible and useful.
  "message",
  "body",
  "*.body",
  "req.body",
  "request.body",
];

// ---------------------------------------------------------------------------
// Test sink
// ---------------------------------------------------------------------------

/** One emitted log record, normalised for assertions. */
export interface CapturedLog {
  level: number;
  time: number;
  msg?: string;
  [key: string]: unknown;
}

type LogSink = (record: CapturedLog) => void;

let testSink: LogSink | undefined;

/**
 * Install a sink that receives every emitted log record (real-time).
 * Pass `undefined` to restore normal stdout output. Intended for tests.
 */
export function setLogSink(sink: LogSink | undefined): void {
  testSink = sink;
}

// pino.write receives a fully-serialised JSON line.
function makePinoStream() {
  return {
    write(line: string): void {
      if (testSink === undefined) {
        process.stdout.write(line);
        return;
      }
      try {
        testSink(JSON.parse(line) as CapturedLog);
      } catch {
        // Never let a bad sink break logging / the request path.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Logger instance
// ---------------------------------------------------------------------------

export const logger: Logger = pino(
  {
    level: LOG_LEVEL,
    base: null, // omit pid/hostname – not useful here and noisier
    redact: {
      paths: REDACT_PATHS,
      censor: "[REDACTED]",
      remove: false,
    },
  },
  makePinoStream(),
);

// ---------------------------------------------------------------------------
// Request-scoped context (AsyncLocalStorage)
// ---------------------------------------------------------------------------

export interface RequestContext {
  requestId: string;
}

const requestContext = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with the given request context active for all nested async work. */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return requestContext.run(ctx, fn);
}

/** Current request context, or undefined when outside a request. */
export function getRequestContext(): RequestContext | undefined {
  return requestContext.getStore();
}

/** Current request id, or undefined when outside a request. */
export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

/**
 * Logger that automatically attaches the active request id.
 * Use this inside request handlers so every log line is correlated.
 */
export function log(): Logger {
  return logger.child({ requestId: currentRequestId() });
}

// ---------------------------------------------------------------------------
// Safe error serialisation
// ---------------------------------------------------------------------------

// Categories are deliberately generic: this service no longer talks to any AI
// provider, so provider-specific categories (e.g. timeouts/upstream failures)
// were removed. `validation_error` covers client-caused 4xx errors, `unknown`
// everything else.
export type ErrorCategory = "validation_error" | "unknown";

export interface ErrorInfo {
  name: string;
  message: string;
  category: ErrorCategory;
}

/**
 * Reduce an unknown thrown value to a small, safe, structured object.
 *
 * We deliberately do NOT include a stack trace or arbitrary properties: stack
 * traces can embed sensitive data and are not needed for categorised logging.
 * Error *messages* are included (they usually describe the failure); they do
 * not contain request bodies because the analyzer never puts message content
 * into errors.
 */
export function errorInfo(err: unknown, category: ErrorCategory = "unknown"): ErrorInfo {
  const name = err instanceof Error ? err.name : typeof err;
  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : "Non-error value thrown";
  return { name, message, category };
}
