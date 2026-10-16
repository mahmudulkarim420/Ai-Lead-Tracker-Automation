
import express, { type ErrorRequestHandler } from "express";
import { z } from "zod";
import { analyzeLead, OllamaTimeoutError } from "./services/lead-analyzer.js";
import { apiRateLimiter, configureTrustProxy } from "./middleware/rate-limit.js";
import { requestContext } from "./middleware/request-context.js";
import { errorInfo, log } from "./lib/logger.js";

const app = express();

// Apply the RATE_LIMIT_TRUST_PROXY setting *before* any request handling.
// With the default (0) this is a no-op, preserving Express's secure default so
// X-Forwarded-For is never trusted. Enable it only behind a known proxy.
configureTrustProxy(app);

// Correlate every request first: resolves/generates a request id, echoes it in
// the X-Request-ID header, and emits a single structured completion log.
app.use(requestContext);

app.use(express.json({ limit: "10kb" }));

const AnalyzeLeadRequestSchema = z.object({
  message: z.string().trim().min(1).max(5000),
});

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.post("/api/leads/analyze", apiRateLimiter, async (req, res) => {
  const input = AnalyzeLeadRequestSchema.safeParse(req.body);

  if (!input.success) {
    res.status(400).json({
      error: "Invalid request",
      details: input.error.issues,
    });
    return;
  }

  try {
    const lead = await analyzeLead(input.data.message);

    res.status(200).json({
      success: true,
      data: lead,
    });
  } catch (error: unknown) {
    // Structured, categorised logging. errorInfo() emits only name/message/
    // category – never a stack trace or the raw thrown object – and the log
    // line is correlated via the active request id.
    if (error instanceof OllamaTimeoutError) {
      log().error(
        { errorDetails: errorInfo(error, "ollama_timeout") },
        "ollama request timed out",
      );
      res.status(504).json({
        error: "Lead analysis timed out",
      });
      return;
    }

    log().error(
      { errorDetails: errorInfo(error, "upstream_failure") },
      "lead analysis upstream failure",
    );
    res.status(502).json({
      error: "Lead analysis failed",
    });
  }
});

// ---------------------------------------------------------------------------
// Global error handler (must be registered LAST, after all routes).
// ---------------------------------------------------------------------------
// Safety net for errors raised by middleware that runs *before* the analyze
// handler (most notably express.json() rejecting malformed or oversized
// bodies) and for any error propagated with next(err).
//
// Guarantees:
//   - responds with JSON only ({ error, [requestId] }) – never HTML, a stack
//     trace, or internal error details;
//   - logs the real error server-side via the request-scoped logger using
//     errorInfo() (name/message/category only) so it stays correlatable;
//   - echoes the request id when available;
//   - leaves the existing inline 400 / 429 / 502 / 504 responses untouched:
//     those are sent directly by the route/limiter and never call next(err).
const globalErrorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (res.headersSent) {
    // A response is already on the wire; we can only defer to Express to
    // close/abort the connection. Cannot change the response at this point.
    return;
  }

  const info = errorInfo(err);
  const clientStatus = getClientErrorStatus(err);

  if (clientStatus !== undefined) {
    // A well-formed client error such as a parser 400 (bad JSON / body too
    // large). Log at warn – it is the caller's mistake, not a server fault.
    log().warn({ errorDetails: info }, "client request error");
    res.status(clientStatus).json({ error: "Invalid request" });
    return;
  }

  // Unexpected server error: log the category + safe details, return a generic
  // message. No name, message, or stack is ever sent to the client.
  log().error({ errorDetails: info }, "unhandled request error");
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
