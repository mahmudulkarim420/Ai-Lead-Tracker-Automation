/**
 * Request-ID + structured request logging middleware.
 *
 * Responsibilities
 * ----------------
 * 1. Resolve a request id for every incoming request:
 *      - accept an inbound `X-Request-ID` only when it passes strict
 *        validation (bounded length, safe charset) so it cannot inject
 *        arbitrary content into logs or response headers;
 *      - otherwise generate a fresh UUID via crypto.randomUUID().
 * 2. Attach the id to the request (`req.id`), the async context (so nested
 *    logs are correlated), and the `X-Request-ID` response header.
 * 3. Emit exactly ONE completion log per request with method, route, status
 *    and duration. Health checks are only logged at `debug` to avoid noise.
 *
 * Deliberately NOT logged: request bodies, raw lead messages, headers,
 * secrets, or full error details.
 */

import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { log } from "../lib/logger.js";
import { runWithRequestContext } from "../lib/logger.js";

// ---------------------------------------------------------------------------
// Express type augmentation: expose the resolved id on the request.
// ---------------------------------------------------------------------------
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Correlation id resolved by the requestContext middleware. */
      id?: string;
    }
  }
}

/** Response header used to echo the request id back to the client. */
export const REQUEST_ID_HEADER = "X-Request-ID";

/**
 * Conservative pattern for an acceptable inbound request id.
 * Only ASCII letters, digits, dash, underscore and dot are allowed, capped at
 * 200 chars. This prevents header/log injection and oversized values.
 */
const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{1,200}$/;

/** Return the inbound id if it is safe to trust, otherwise undefined. */
export function resolveInboundRequestId(req: Request): string | undefined {
  const raw = req.header(REQUEST_ID_HEADER);
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return VALID_REQUEST_ID.test(trimmed) ? trimmed : undefined;
}

/** The route/shape used for log correlation (template when available). */
function routeLabel(req: Request): string {
  // `req.route.path` is the matched template (no user-supplied segments);
  // fall back to the raw path for unmatched requests (e.g. 404).
  const matched = (req.route as { path?: string } | undefined)?.path;
  return matched ?? req.path;
}

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const requestId = resolveInboundRequestId(req) ?? randomUUID();

  req.id = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);

  const startedAt = process.hrtime.bigint();
  const isHealth = req.path === "/health";

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const payload = {
      method: req.method,
      route: routeLabel(req),
      status: res.statusCode,
      durationMs: Math.round(durationMs * 1000) / 1000,
    };

    // Health checks are noisy for liveness probes – only surface them at debug.
    if (isHealth) {
      log().debug(payload, "request completed");
    } else {
      log().info(payload, "request completed");
    }
  });

  // Run the rest of the request inside the async context so any nested log()
  // automatically carries this request id.
  runWithRequestContext({ requestId }, () => {
    next();
  });
}
