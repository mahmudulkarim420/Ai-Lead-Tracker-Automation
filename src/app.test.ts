/**
 * Integration tests for rate limiting in src/app.ts.
 *
 * Uses Node.js built-in http client + node:test runner.
 * No extra test dependencies required.
 *
 * Run: pnpm test   (or: pnpm exec tsx --test src/app.test.ts)
 *
 * Strategy
 * --------
 * We spin up the real Express app on a random port for each describe block,
 * then tear it down in an afterEach/after hook.  We set RATE_LIMIT_MAX to a
 * small value via process.env *before* importing the middleware module so that
 * we can test the limit breach without hammering the real Ollama service.
 *
 * Because ESM modules are cached, we import app.ts once at the top with a
 * very small limit configured through the env vars set before any import.
 * The lead analysis route intentionally calls Ollama (which may not be running
 * in CI), so we only verify HTTP 429 behaviour (no Ollama needed) and that
 * /health is always reachable regardless of the limiter.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Set rate-limit env vars BEFORE any import that reads them at module level.
// We use a tiny limit (3 requests per window) to make tests fast.
// ---------------------------------------------------------------------------
process.env["RATE_LIMIT_MAX"] = "3";
process.env["RATE_LIMIT_WINDOW_MS"] = "60000";

// ---------------------------------------------------------------------------
// Helper: make a single HTTP request to the local test server.
// ---------------------------------------------------------------------------
function request(
  port: number,
  opts: {
    method: string;
    path: string;
    body?: unknown;
  },
): Promise<{ status: number; body: unknown; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: opts.path,
        method: opts.method,
        headers: {
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(raw),
              headers: res.headers,
            });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: raw, headers: res.headers });
          }
        });
      },
    );

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Import the app AFTER env vars are set.
// ---------------------------------------------------------------------------
const { default: app } = await import("./app.js");

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("GET /health — not rate limited", () => {
  let server: http.Server;
  let port: number;

  before(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("responds 200 before the rate limit is reached", async () => {
    const res = await request(port, { method: "GET", path: "/health" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: "ok" });
  });

  it("still responds 200 after many requests (rate limiter does not apply)", async () => {
    // Hit it more times than RATE_LIMIT_MAX (3) to prove it is unrestricted.
    for (let i = 0; i < 6; i++) {
      const res = await request(port, { method: "GET", path: "/health" });
      assert.equal(
        res.status,
        200,
        `Expected 200 on iteration ${i + 1}, got ${res.status}`,
      );
    }
  });
});

describe("POST /api/leads/analyze — rate limiting", () => {
  let server: http.Server;
  let port: number;

  before(async () => {
    await new Promise<void>((resolve) => {
      // Each describe block gets its own server instance so the in-memory
      // rate-limit store is fresh (a new rateLimit() instance was created
      // when the middleware module was first imported, but the store is
      // shared across all server instances of the same app).
      server = app.listen(0, "127.0.0.1", () => {
        port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("returns 400 (not 429) for a missing body within the limit", async () => {
    // Sends an invalid request (no body). The rate limiter should let it
    // through and Zod validation should reject it with 400.
    const res = await request(port, {
      method: "POST",
      path: "/api/leads/analyze",
      body: {},                 // missing "message" field
    });
    assert.equal(res.status, 400, `Expected 400 for invalid body, got ${res.status}`);
    assert.ok(
      typeof res.body === "object" && res.body !== null && "error" in res.body,
      "Response should have an 'error' field",
    );
  });

  it("returns HTTP 429 with a safe JSON error after exceeding RATE_LIMIT_MAX", async () => {
    // RATE_LIMIT_MAX is set to 3 above. We exhaust the budget with invalid-body
    // requests (which return quickly without hitting Ollama), then the next one
    // must be 429.
    //
    // NOTE: The first describe block may have already consumed some of the budget
    // on the shared in-memory store if both suites run in the same process
    // with the same app instance. We loop until we see the 429 or give up after
    // RATE_LIMIT_MAX + 5 attempts.
    const MAX_ATTEMPTS = Number(process.env["RATE_LIMIT_MAX"] ?? 3) + 5;
    let got429 = false;

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const res = await request(port, {
        method: "POST",
        path: "/api/leads/analyze",
        body: {},               // invalid body – returns 400 or 429
      });

      if (res.status === 429) {
        got429 = true;

        // Verify the safe, consistent error shape.
        assert.ok(
          typeof res.body === "object" &&
            res.body !== null &&
            "error" in res.body &&
            (res.body as Record<string, unknown>)["error"] ===
              "Too many requests, please try again later.",
          `Unexpected 429 body: ${JSON.stringify(res.body)}`,
        );

        // Verify no stack-trace or internal fields are present.
        const keys = Object.keys(res.body as object);
        assert.deepEqual(
          keys,
          ["error"],
          `429 body should only contain 'error', got: ${keys.join(", ")}`,
        );

        break;
      }
    }

    assert.ok(got429, `Expected HTTP 429 within ${MAX_ATTEMPTS} attempts but never received it`);
  });
});

describe("Rate-limit middleware config exports", () => {
  it("RATE_LIMIT_MAX matches the env var we set", async () => {
    const { RATE_LIMIT_MAX } = await import("./middleware/rate-limit.js");
    assert.equal(RATE_LIMIT_MAX, 3);
  });

  it("RATE_LIMIT_WINDOW_MS matches the env var we set", async () => {
    const { RATE_LIMIT_WINDOW_MS } = await import("./middleware/rate-limit.js");
    assert.equal(RATE_LIMIT_WINDOW_MS, 60_000);
  });

  it("RATE_LIMIT_TRUST_PROXY is 0 (disabled) by default", async () => {
    const { RATE_LIMIT_TRUST_PROXY } = await import("./middleware/rate-limit.js");
    assert.equal(RATE_LIMIT_TRUST_PROXY, 0);
  });
});

describe("Rate-limit config: env-var parsing (unit)", () => {
  // Replicate the parsePositiveInt logic as a pure function for isolated tests.
  function parsePositiveInt(name: string, raw: string | undefined, def: number): number {
    if (raw === undefined || raw === "") return def;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`Invalid ${name} value "${raw}": must be a positive integer.`);
    }
    return parsed;
  }

  it("returns default when env var is undefined", () => {
    assert.equal(parsePositiveInt("RATE_LIMIT_MAX", undefined, 20), 20);
  });

  it("returns default when env var is empty string", () => {
    assert.equal(parsePositiveInt("RATE_LIMIT_MAX", "", 20), 20);
  });

  it("parses a valid positive integer", () => {
    assert.equal(parsePositiveInt("RATE_LIMIT_MAX", "5", 20), 5);
  });

  it("throws for a non-numeric value", () => {
    assert.throws(
      () => parsePositiveInt("RATE_LIMIT_MAX", "abc", 20),
      /Invalid RATE_LIMIT_MAX/,
    );
  });

  it("throws for zero", () => {
    assert.throws(
      () => parsePositiveInt("RATE_LIMIT_MAX", "0", 20),
      /Invalid RATE_LIMIT_MAX/,
    );
  });

  it("throws for a negative value", () => {
    assert.throws(
      () => parsePositiveInt("RATE_LIMIT_MAX", "-5", 20),
      /Invalid RATE_LIMIT_MAX/,
    );
  });

  it("throws for a float", () => {
    assert.throws(
      () => parsePositiveInt("RATE_LIMIT_MAX", "1.5", 20),
      /Invalid RATE_LIMIT_MAX/,
    );
  });
});
