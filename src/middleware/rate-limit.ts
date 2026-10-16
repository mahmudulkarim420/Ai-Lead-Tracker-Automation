import type { Express } from "express";
import { rateLimit } from "express-rate-limit";

// ---------------------------------------------------------------------------
// Environment-variable helpers (same validated-parse pattern as lead-analyzer)
// ---------------------------------------------------------------------------

/**
 * Parse a positive-integer env var.
 * Returns `defaultValue` when the var is absent or empty.
 * Throws at startup when the value is present but invalid.
 */
function parsePositiveInt(name: string, raw: string | undefined, defaultValue: number): number {
  if (raw === undefined || raw === "") return defaultValue;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid ${name} value "${raw}": must be a positive integer.`,
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Rate-limit configuration
// ---------------------------------------------------------------------------

/**
 * RATE_LIMIT_WINDOW_MS
 * Length of each rate-limit window in milliseconds.
 * Default: 60 000 ms (1 minute).
 */
const RATE_LIMIT_WINDOW_MS = parsePositiveInt(
  "RATE_LIMIT_WINDOW_MS",
  process.env["RATE_LIMIT_WINDOW_MS"],
  60_000,
);

/**
 * RATE_LIMIT_MAX
 * Maximum number of requests allowed per IP within one window.
 * Default: 20 – generous for a local LLM API; tighten in production.
 */
const RATE_LIMIT_MAX = parsePositiveInt(
  "RATE_LIMIT_MAX",
  process.env["RATE_LIMIT_MAX"],
  20,
);

/**
 * Parse RATE_LIMIT_TRUST_PROXY into an explicit number of trusted proxy hops.
 * `0` means "do not trust any proxy" (the secure default for direct deploys).
 *
 * Accepted values:
 *   unset / "" / "0" / "false"  → 0   (trust disabled)
 *   a positive integer, e.g. "1" → N   (trust exactly N hops)
 *
 * Open-ended values such as "true" are deliberately rejected. Express treats
 * `trust proxy: true` specially by trusting the entire X-Forwarded-For chain,
 * which lets any client spoof `req.ip` and bypass IP-based rate limiting when
 * the server is publicly reachable. Trust must therefore be an explicit hop
 * count that matches the actual deployment topology.
 */
function parseTrustProxy(raw: string | undefined): number {
  if (raw === undefined || raw === "" || raw === "0" || raw === "false") return 0;
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0) return n; // "1", "2", … (explicit hop count)
  throw new Error(
    `Invalid RATE_LIMIT_TRUST_PROXY value "${raw}": use "0"/"false" to disable, ` +
    `or a positive integer hop-count ("1", "2", …). Open-ended trust ` +
    `(e.g. "true") is refused because it permits client IP spoofing.`,
  );
}

/**
 * RATE_LIMIT_TRUST_PROXY
 * Number of trusted reverse-proxy hops. Defaults to 0 (proxy trust disabled),
 * which is the correct, secure setting for a directly-exposed server: the
 * X-Forwarded-For header is ignored and `req.ip` is the socket peer address.
 *
 * Only set a positive hop count when this service sits behind that many known
 * reverse proxies (nginx, Cloudflare, AWS ALB, …) and NOTHING else can reach it.
 */
const RATE_LIMIT_TRUST_PROXY = parseTrustProxy(process.env["RATE_LIMIT_TRUST_PROXY"]);

/**
 * Apply the configured proxy-trust setting to the Express application.
 *
 * Must be called exactly once, before the app starts handling requests (i.e.
 * before `app.listen`). When RATE_LIMIT_TRUST_PROXY is 0 this is a no-op, so
 * Express's secure default (`trust proxy` disabled) is preserved and
 * X-Forwarded-For is never trusted.
 */
export function configureTrustProxy(app: Express): void {
  if (RATE_LIMIT_TRUST_PROXY > 0) {
    app.set("trust proxy", RATE_LIMIT_TRUST_PROXY);
  }
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Express middleware that rate-limits requests by client IP.
 *
 * Apply this only to routes that should be limited (e.g. /api/leads/analyze).
 * Do NOT apply it globally so that /health remains unrestricted.
 *
 * Defaults:
 *   - Window : 60 s  (RATE_LIMIT_WINDOW_MS)
 *   - Max    : 20 req / window / IP  (RATE_LIMIT_MAX)
 *   - Proxy  : off  (RATE_LIMIT_TRUST_PROXY)
 */
export const apiRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,

  // Use the IETF-standard RateLimit-* response headers (draft-8).
  // legacyHeaders: false disables the older X-RateLimit-* headers.
  standardHeaders: "draft-8",
  legacyHeaders: false,

  // Proxy trust is applied explicitly via configureTrustProxy(app) in app.ts,
  // which sets app.set("trust proxy", <hop count>) only when configured.
  // express-rate-limit's own trust-proxy check would otherwise warn about the
  // mismatch, so we suppress it *only* when proxy trust is actually enabled.
  // With the default (0), validation stays on so any accidental trust
  // configuration is surfaced rather than silently accepted.
  ...(RATE_LIMIT_TRUST_PROXY > 0
    ? { validate: { trustProxy: false } }
    : {}),

  // Safe, consistent JSON error response matching the project's { error: "..." } convention.
  // Does not expose internal details, stack traces, or rate-limit internals.
  handler: (_req, res) => {
    res.status(429).json({
      error: "Too many requests, please try again later.",
    });
  },

  // Count every request (including 4xx/5xx) against the limit. This is the safe
  // default: an attacker cannot spend the quota on cheap invalid requests and
  // then flood valid ones, and successful lookups are not under-counted.
  skipFailedRequests: false,
});

// Export parsed config for testing.
export { RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX, RATE_LIMIT_TRUST_PROXY };
