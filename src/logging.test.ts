/**
 * Focused tests for structured logging + request-ID tracing.
 *
 * Covers:
 *   - X-Request-ID generation, echoing, and safe validation of inbound ids
 *   - exactly one completion log per request (no duplicates)
 *   - health checks are not logged at the default `info` level
 *   - safe log content: no secrets and no stack traces
 *   - logger JSON shape + defensive redaction
 *
 * Run: pnpm test
 *
 * Env vars are set BEFORE importing app/logger so module-level config picks
 * them up. (Node's test runner executes each test file in its own process.)
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Configure env before any import that reads it at module load time.
// ---------------------------------------------------------------------------
process.env["LOG_LEVEL"] = "info";

// ---------------------------------------------------------------------------
// Imports (after env is set)
// ---------------------------------------------------------------------------
import type { CapturedLog } from "./lib/logger.js";

const { default: app } = await import("./app.js");
const { setLogSink, errorInfo, logger, LOG_LEVEL } = await import("./lib/logger.js");
const { REQUEST_ID_HEADER } = await import("./middleware/request-context.js");

// ---------------------------------------------------------------------------
// Capture logs instead of writing to stdout.
// ---------------------------------------------------------------------------
let captured: CapturedLog[] = [];

before(() => {
  setLogSink((record) => {
    captured.push(record);
  });
});

after(() => {
  setLogSink(undefined);
});

beforeEach(() => {
  captured = [];
});

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function request(
  port: number,
  opts: { method: string; path: string; headers?: Record<string, string>; body?: unknown },
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
          ...(opts.headers ?? {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk: Buffer) => {
          raw += chunk.toString();
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw), headers: res.headers });
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

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

function completionLogs(): CapturedLog[] {
  return captured.filter((r) => r["msg"] === "request completed");
}

// ---------------------------------------------------------------------------
// Shared server
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Request-ID behaviour
// ---------------------------------------------------------------------------
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("Request ID tracing", () => {
  it("generates a UUID and returns it in the X-Request-ID header", async () => {
    const res = await request(port, { method: "GET", path: "/does-not-exist" });
    const header = res.headers[REQUEST_ID_HEADER.toLowerCase()];
    assert.equal(typeof header, "string");
    assert.match(String(header), UUID_V4);

    await waitFor(() => completionLogs().length >= 1);
    const log = completionLogs()[0];
    assert.ok(log, "expected a completion log");
    assert.equal(log["requestId"], header, "log requestId must match response header");
  });

  it("honours a valid inbound X-Request-ID and echoes it", async () => {
    const res = await request(port, {
      method: "GET",
      path: "/does-not-exist",
      headers: { [REQUEST_ID_HEADER]: "upstream-trace-123" },
    });
    assert.equal(res.headers[REQUEST_ID_HEADER.toLowerCase()], "upstream-trace-123");

    await waitFor(() => completionLogs().length >= 1);
    assert.equal(completionLogs()[0]?.["requestId"], "upstream-trace-123");
  });

  it("ignores an invalid inbound X-Request-ID and generates a safe one", async () => {
    const bad = "bad id with spaces!";
    const res = await request(port, {
      method: "GET",
      path: "/does-not-exist",
      headers: { [REQUEST_ID_HEADER]: bad },
    });
    const header = String(res.headers[REQUEST_ID_HEADER.toLowerCase()]);
    assert.notEqual(header, bad);
    assert.match(header, UUID_V4);

    await waitFor(() => completionLogs().length >= 1);
    assert.equal(completionLogs()[0]?.["requestId"], header);
  });

  it("emits exactly one completion log per request", async () => {
    await request(port, { method: "GET", path: "/does-not-exist" });
    await waitFor(() => completionLogs().length >= 1);
    await new Promise((r) => setTimeout(r, 50)); // allow any (erroneous) extra log to flush
    assert.equal(completionLogs().length, 1, "expected exactly one request log");
  });

  it("logs method, route, status and a numeric duration", async () => {
    await request(port, { method: "GET", path: "/does-not-exist" });
    await waitFor(() => completionLogs().length >= 1);
    const log = completionLogs()[0];
    assert.equal(log?.["method"], "GET");
    assert.equal(log?.["status"], 404);
    assert.equal(log?.["route"], "/does-not-exist");
    assert.equal(typeof log?.["durationMs"], "number");
  });
});

// ---------------------------------------------------------------------------
// Health-check noise control
// ---------------------------------------------------------------------------
describe("Health check logging", () => {
  it("does not log /health at the default info level but still responds 200", async () => {
    const res = await request(port, { method: "GET", path: "/health" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: "ok" });

    await new Promise((r) => setTimeout(r, 50));
    const health = captured.filter((r) => r["route"] === "/health");
    assert.equal(health.length, 0, "/health must not be logged at info level");
  });

  it("still sets the X-Request-ID header on /health", async () => {
    const res = await request(port, { method: "GET", path: "/health" });
    assert.match(String(res.headers[REQUEST_ID_HEADER.toLowerCase()]), UUID_V4);
  });
});

// ---------------------------------------------------------------------------
// Logger unit behaviour
// ---------------------------------------------------------------------------
describe("logger configuration & content", () => {
  it("uses the configured LOG_LEVEL", () => {
    assert.equal(LOG_LEVEL, "info");
  });

  it("emits valid structured JSON with time, level and msg", async () => {
    captured = [];
    logger.info({ route: "/x", status: 200 }, "hello");
    await new Promise((r) => setTimeout(r, 10));
    const rec = captured.find((r) => r["msg"] === "hello");
    assert.ok(rec, "expected the log record");
    assert.equal(typeof rec?.["time"], "number");
    assert.equal(typeof rec?.["level"], "number");
    assert.equal(rec?.["route"], "/x");
  });

  it("redacts secret-bearing keys", async () => {
    captured = [];
    logger.info({ password: "hunter2", token: "abc123" }, "secrets");
    await new Promise((r) => setTimeout(r, 10));
    const rec = captured.find((r) => r["msg"] === "secrets");
    assert.equal(rec?.["password"], "[REDACTED]");
    assert.equal(rec?.["token"], "[REDACTED]");
  });

  it("redacts a top-level raw `message` payload (defence in depth)", async () => {
    captured = [];
    logger.info({ message: "raw lead text" }, "payload");
    await new Promise((r) => setTimeout(r, 10));
    const rec = captured.find((r) => r["msg"] === "payload");
    assert.equal(rec?.["message"], "[REDACTED]");
  });
});

describe("errorInfo()", () => {
  it("extracts name, message and default category from an Error", () => {
    const info = errorInfo(new TypeError("fetch failed"));
    assert.deepEqual(info, {
      name: "TypeError",
      message: "fetch failed",
      category: "unknown",
    });
  });

  it("respects an explicit category", () => {
    assert.equal(errorInfo(new Error("boom"), "validation_error").category, "validation_error");
  });

  it("handles a thrown string", () => {
    assert.equal(errorInfo("nope").message, "nope");
  });

  it("handles a thrown non-error value without exposing internals", () => {
    const info = errorInfo(42);
    assert.equal(info.name, "number");
    assert.equal(info.message, "Non-error value thrown");
  });
});
