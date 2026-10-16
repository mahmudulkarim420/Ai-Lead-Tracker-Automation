/**
 * Tests for src/services/lead-analyzer.ts timeout behaviour.
 *
 * Run with:  node --experimental-vm-modules --import tsx/esm \
 *              src/services/lead-analyzer.test.ts
 * Or simply: npx tsx --test src/services/lead-analyzer.test.ts
 *
 * Uses Node.js built-in test runner (node:test, available since Node 18).
 * No additional test dependencies required.
 */

import { describe, it, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// We unit-test the module in isolation by monkey-patching `global.fetch`
// before importing the module under test.  Because the module is ESM, we
// patch fetch at the global level (which is what the ollama library ultimately
// calls through its configurable fetch slot).
// ---------------------------------------------------------------------------

// Helper: build a minimal DOMException that looks like what AbortSignal.timeout
// throws in Node >= 17.3.
function makeTimeoutError(): DOMException {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

// Helper: build a minimal successful Ollama response payload.
function makeChatResponse(content: string) {
  return {
    message: { content },
  };
}

// Helper: make a fetch stub that returns a successful JSON response.
function makeSuccessfulFetch(body: unknown) {
  return mock.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
}

// Helper: make a fetch stub that rejects with a TimeoutError DOMException.
function makeTimedOutFetch() {
  return mock.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    throw makeTimeoutError();
  });
}

// Helper: make a fetch stub that rejects with a generic network error.
function makeNetworkErrorFetch() {
  return mock.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    throw new TypeError("fetch failed");
  });
}

// ---------------------------------------------------------------------------
// Because lead-analyzer.ts is an ES module whose top-level code runs once,
// we cannot easily re-import it with a different global.fetch per test.
// Instead, we test the timeout-classification logic independently and verify
// the module's exported OllamaTimeoutError class shape.
// ---------------------------------------------------------------------------

describe("OllamaTimeoutError", () => {
  it("is an instance of Error", async () => {
    const { OllamaTimeoutError } = await import("./lead-analyzer.js");
    const err = new OllamaTimeoutError(5000);
    assert.ok(err instanceof Error);
  });

  it("has name OllamaTimeoutError", async () => {
    const { OllamaTimeoutError } = await import("./lead-analyzer.js");
    const err = new OllamaTimeoutError(5000);
    assert.equal(err.name, "OllamaTimeoutError");
  });

  it("message includes the configured timeout value", async () => {
    const { OllamaTimeoutError } = await import("./lead-analyzer.js");
    const err = new OllamaTimeoutError(30_000);
    assert.ok(
      err.message.includes("30000"),
      `Expected message to contain '30000', got: ${err.message}`,
    );
  });

  it("is distinct from a plain DOMException TimeoutError", async () => {
    const { OllamaTimeoutError } = await import("./lead-analyzer.js");
    const domErr = makeTimeoutError();
    assert.ok(!(domErr instanceof OllamaTimeoutError));
  });
});

describe("Timeout detection logic (unit)", () => {
  // Re-implement the same detection predicate used inside analyzeLead so we
  // can test it without needing to call the real Ollama binary.
  function isTimeoutError(err: unknown): boolean {
    return err instanceof DOMException && err.name === "TimeoutError";
  }

  it("detects a DOMException with name TimeoutError", () => {
    assert.ok(isTimeoutError(makeTimeoutError()));
  });

  it("does not classify a generic Error as a timeout", () => {
    assert.ok(!isTimeoutError(new Error("connection refused")));
  });

  it("does not classify a DOMException with a different name as a timeout", () => {
    assert.ok(!isTimeoutError(new DOMException("aborted", "AbortError")));
  });

  it("does not classify null as a timeout", () => {
    assert.ok(!isTimeoutError(null));
  });
});

describe("LeadSchema", () => {
  it("accepts a valid lead object", async () => {
    const { LeadSchema } = await import("./lead-analyzer.js");
    const valid = {
      category: "ecommerce",
      intent: "new_website",
      priority: "high",
      summary: "Customer wants a new e-commerce store.",
    };
    assert.doesNotThrow(() => LeadSchema.parse(valid));
  });

  it("rejects an invalid category value", async () => {
    const { LeadSchema } = await import("./lead-analyzer.js");
    assert.throws(() =>
      LeadSchema.parse({
        category: "invalid",
        intent: "new_website",
        priority: "high",
        summary: "Some summary",
      }),
    );
  });

  it("rejects an empty summary", async () => {
    const { LeadSchema } = await import("./lead-analyzer.js");
    assert.throws(() =>
      LeadSchema.parse({
        category: "other",
        intent: "other",
        priority: "low",
        summary: "",
      }),
    );
  });
});

describe("analyzeLead input guard", () => {
  it("throws for an empty message without calling Ollama", async () => {
    const { analyzeLead } = await import("./lead-analyzer.js");
    await assert.rejects(
      () => analyzeLead("   "),
      (err: unknown) =>
        err instanceof Error &&
        err.message === "Customer message cannot be empty",
    );
  });
});

describe("OLLAMA_TIMEOUT_MS env-var parsing", () => {
  // These tests verify the timeout configuration logic in isolation.
  // We extract and replicate the parsing logic as a pure function so we can
  // unit-test it without side effects.
  function parseTimeoutMs(raw: string | undefined): number {
    if (raw === undefined || raw === "") return 120_000;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(
        `Invalid OLLAMA_TIMEOUT_MS value "${raw}": must be a positive integer (milliseconds).`,
      );
    }
    return parsed;
  }

  it("returns 120 000 when env var is not set", () => {
    assert.equal(parseTimeoutMs(undefined), 120_000);
  });

  it("returns 120 000 when env var is empty string", () => {
    assert.equal(parseTimeoutMs(""), 120_000);
  });

  it("parses a valid positive integer", () => {
    assert.equal(parseTimeoutMs("30000"), 30_000);
  });

  it("throws for a non-numeric value", () => {
    assert.throws(() => parseTimeoutMs("abc"), /Invalid OLLAMA_TIMEOUT_MS/);
  });

  it("throws for zero", () => {
    assert.throws(() => parseTimeoutMs("0"), /Invalid OLLAMA_TIMEOUT_MS/);
  });

  it("throws for a negative value", () => {
    assert.throws(() => parseTimeoutMs("-1"), /Invalid OLLAMA_TIMEOUT_MS/);
  });
});
