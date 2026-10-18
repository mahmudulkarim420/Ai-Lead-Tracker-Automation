import express, { type ErrorRequestHandler } from "express";
import { requestContext } from "./middleware/request-context.js";
import { errorInfo, log } from "./lib/logger.js";

// ---------------------------------------------------------------------------
// Lead analysis now lives in the n8n workflow (Gemini → Google Sheets), so this
// Express service no longer performs any AI work. It exposes a health probe and
// keeps the shared request pipeline (request correlation, structured logging,
// body-parser hardening, and a JSON-only error handler) that the deployment
// relies on.
// ---------------------------------------------------------------------------
const app = express();

// Correlate every request first: resolves/generates a request id, echoes it in
// the X-Request-ID header, and emits a single structured completion log.
app.use(requestContext);

// Reject malformed or oversized JSON bodies with a safe 4xx before any route
// runs. There is no current route that consumes a body; this stays as generic
// request hardening for the HTTP surface.
app.use(express.json({ limit: "10kb" }));

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// ---------------------------------------------------------------------------
// Global error handler (must be registered LAST, after all routes).
// ---------------------------------------------------------------------------
// Safety net for errors raised by middleware that runs before the routes (most
// notably express.json() rejecting malformed or oversized bodies) and for any
// error propagated with next(err).
//
// Guarantees:
//   - responds with JSON only ({ error, [requestId] }) – never HTML, a stack
//     trace, or internal error details;
//   - logs the real error server-side via the request-scoped logger using
//     errorInfo() (name/message/category only) so it stays correlatable;
//   - echoes the request id when available.
const globalErrorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (res.headersSent) {
    // A response is already on the wire; we can only defer to Express to
    // close/abort the connection. Cannot change the response at this point.
    return;
  }

  const clientStatus = getClientErrorStatus(err);

  if (clientStatus !== undefined) {
    // A well-formed client error such as a parser 400 (bad JSON / body too
    // large). Log at warn – it is the caller's mistake, not a server fault.
    log().warn(
      { errorDetails: errorInfo(err, "validation_error") },
      "client request error",
    );
    res.status(clientStatus).json({ error: "Invalid request" });
    return;
  }

  // Unexpected server error: log the category + safe details, return a generic
  // message. No name, message, or stack is ever sent to the client.
  log().error(
    { errorDetails: errorInfo(err) },
    "unhandled request error",
  );
  const requestId = res.getHeader("X-Request-ID");
  res.status(500).json({
    error: "Internal server error",
    ...(typeof requestId === "string" ? { requestId } : {}),
  });
};

/**
 * Return a 4xx status for known client-caused errors (so the handler can reply
 * with a generic client message instead of a 500), or undefined for anything
 * else. Only well-formed 4xx `.status`/`.statusCode` values are honored, so a
 * malformed error cannot force an invalid or 5xx status.
 */
function getClientErrorStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const raw = (err as { status?: unknown; statusCode?: unknown });
  const candidate = raw.status ?? raw.statusCode;
  return typeof candidate === "number" && candidate >= 400 && candidate < 500
    ? candidate
    : undefined;
}

// Register the handler after every route so it only sees errors that fall
// through the request pipeline (Express skips 4-arg middleware otherwise).
app.use(globalErrorHandler);

export default app;
