/**
 * Integration tests for the Express app (src/app.ts).
 *
 * After lead analysis moved into the n8n workflow (Gemini → Google Sheets), the
 * Express backend is health-only. These tests pin that contract:
 *   - GET /health responds 200 { status: "ok" } and is unrestricted;
 *   - the former AI endpoint POST /api/leads/analyze is gone (404);
 *   - unknown routes return 404.
 *
 * Uses Node.js built-in http client + node:test runner.
 * No extra test dependencies required.
 *
 * Run: pnpm test   (or: pnpm exec tsx --test src/app.test.ts)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

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
// Import the app AFTER helpers are defined.
// ---------------------------------------------------------------------------
const { default: app } = await import("./app.js");

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
// Health endpoint contract
// ---------------------------------------------------------------------------
describe("GET /health", () => {
  it("responds 200 with { status: 'ok' }", async () => {
    const res = await request(port, { method: "GET", path: "/health" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: "ok" });
  });

  it("remains reachable across many requests (not rate limited)", async () => {
    for (let i = 0; i < 25; i++) {
      const res = await request(port, { method: "GET", path: "/health" });
      assert.equal(
        res.status,
        200,
        `Expected 200 on iteration ${i + 1}, got ${res.status}`,
      );
    }
  });

  it("echoes an X-Request-ID header", async () => {
    const res = await request(port, { method: "GET", path: "/health" });
    assert.equal(typeof res.headers["x-request-id"], "string");
  });
});

// ---------------------------------------------------------------------------
// The former AI endpoint must be gone.
// ---------------------------------------------------------------------------
describe("Removed AI endpoint", () => {
  it("POST /api/leads/analyze no longer exists (404)", async () => {
    const res = await request(port, {
      method: "POST",
      path: "/api/leads/analyze",
      body: { message: "I need a new online store for my bakery." },
    });
    assert.equal(
      res.status,
      404,
      `Expected 404 for the removed endpoint, got ${res.status}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Unknown routes
// ---------------------------------------------------------------------------
describe("Unknown routes", () => {
  it("returns 404 for an undefined path", async () => {
    const res = await request(port, { method: "GET", path: "/does-not-exist" });
    assert.equal(res.status, 404);
  });
});
