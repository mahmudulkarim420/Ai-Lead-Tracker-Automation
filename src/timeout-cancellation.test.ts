/**
 * Focused integration test: does a timed-out Ollama call actually CANCEL the
 * underlying HTTP request, or does the code merely surface a timeout error?
 *
 * Why this test exists
 * --------------------
 * The unit tests in ./services/lead-analyzer.test.ts only verify the shape of
 * OllamaTimeoutError and a re-implemented detection predicate. They never
 * exercise a real socket, so they cannot prove that the in-flight upstream
 * request is genuinely aborted. This test closes that gap.
 *
 * How it works
 * ------------
 * `analyzeLead()` builds `new Ollama({ fetch: fetchWithTimeout })` with the
 * library's default host, which ollama-js 0.6.x hard-codes to
 * `http://127.0.0.1:11434` (it ignores OLLAMA_HOST). To point that fixed URL at
 * our own server we install a thin `globalThis.fetch` shim that rewrites the
 * host to a local mock server while PRESERVING `init.signal` (which carries our
 * injected AbortSignal.timeout()). The mock server receives the request and
 * then never responds, simulating a hung Ollama. If cancellation works, the
 * client socket is torn down and the mock observes the abort.
 *
 * Assertions
 * ----------
 *   1. the mock upstream received the chat request (routing works), and
 *   2. the mock upstream observed the client disconnecting (real cancellation), and
 *   3. the API returned 504 with the safe timeout body.
 *
 * Run: pnpm test
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Configure env BEFORE importing app/lead-analyzer (module-level config).
// ---------------------------------------------------------------------------
process.env["LOG_LEVEL"] = "info";
process.env["RATE_LIMIT_MAX"] = "1000"; // keep the limiter out of the way
process.env["RATE_LIMIT_WINDOW_MS"] = "60000";
// A short but non-zero timeout: long enough that the loopback connection
// establishes, short enough to keep the test fast.
process.env["OLLAMA_TIMEOUT_MS"] = "200";

const require = createRequire(import.meta.url);
/** ollama-js hard-codes this host; keep it in sync with the rewrite below. */
const OLLAMA_DEFAULT_ORIGIN = "http://127.0.0.1:11434";
const ollamaVersion = (require("ollama/package.json") as { version: string }).version;

// ---------------------------------------------------------------------------
// Local mock "Ollama" upstream: accepts connections, reads the request, then
// deliberately never writes a response (a hung server).
// ---------------------------------------------------------------------------
interface Observed {
  requests: number;
  cancelled: boolean;
  path: string | null;
}

const observed: Observed = { requests: 0, cancelled: false, path: null };

function markCancelled(): void {
  observed.cancelled = true;
}

const mockServer = http.createServer((req, res) => {
  // A tiny liveness endpoint so we can prove the fetch shim routes correctly.
  if (req.url === "/__ping") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("pong");
    return;
  }

  observed.requests += 1;
  observed.path = req.url ?? null;

  // The upstream is "hung": hold the socket open and never respond.
  // Cancellation is observable either as a request 'aborted' event or as the
  // response 'close' event firing without the response ever having finished.
  req.on("aborted", markCancelled);
  res.on("close", markCancelled);
});

await new Promise<void>((resolve) => {
  mockServer.listen(0, "127.0.0.1", () => resolve());
});
const mockPort = (mockServer.address() as AddressInfo).port;

// ---------------------------------------------------------------------------
// Fetch shim: rewrite the SDK's fixed Ollama origin to our mock port, keeping
// every other RequestInit field (notably `signal`) intact.
// ---------------------------------------------------------------------------
const originalFetch = globalThis.fetch;

(globalThis as { fetch: typeof fetch }).fetch = ((
  input: RequestInfo | URL,
  init?: RequestInit,
) => {
  const target =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const mapped = target.replace(
    OLLAMA_DEFAULT_ORIGIN,
    `http://127.0.0.1:${mockPort}`,
  );
  return originalFetch(mapped, init);
}) as typeof fetch;

// Import the app only after the shim and mock are in place.
const { default: app } = await import("./app.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function post(
  port: number,
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk: Buffer) => {
          raw += chunk.toString();
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: raw });
          }
        });
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
let appServer: http.Server;
let appPort: number;

describe("Ollama timeout cancels the underlying HTTP request", () => {
  before(async () => {
    await new Promise<void>((resolve) => {
      appServer = app.listen(0, "127.0.0.1", () => {
        appPort = (appServer.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      appServer.close((err) => (err ? reject(err) : resolve())),
    );
    appServer.closeAllConnections();
  });

  it("routes the SDK's fixed Ollama origin to the mock upstream (sanity check)", async () => {
    const res = await fetch(`${OLLAMA_DEFAULT_ORIGIN}/__ping`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "pong");
  });

  it("aborts the in-flight upstream socket and returns 504 when OLLAMA_TIMEOUT_MS elapses", async () => {
    observed.requests = 0;
    observed.cancelled = false;
    observed.path = null;

    const res = await post(appPort, "/api/leads/analyze", {
      message: "Please build me an online store.",
    });

    // (3) API contract: safe 504 timeout response.
    assert.equal(res.status, 504, `expected 504, got ${res.status}`);
    assert.deepEqual(res.body, { error: "Lead analysis timed out" });

    // (1) The upstream actually received the chat request.
    assert.ok(
      observed.requests >= 1,
      "mock upstream should have received the /api/chat request",
    );
    assert.equal(observed.path, "/api/chat");

    // (2) The client socket was genuinely torn down (real cancellation), not
    //     merely surfaced as a timeout error while the request ran on.
    await waitFor(() => observed.cancelled);
    assert.ok(
      observed.cancelled,
      "expected the upstream request socket to be aborted by the timeout",
    );
  });
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------
after(async () => {
  (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
  mockServer.closeAllConnections();
  await new Promise<void>((resolve) => mockServer.close(() => resolve()));
});
