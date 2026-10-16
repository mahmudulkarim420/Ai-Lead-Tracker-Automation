# AI Integration Practice — Lead Analysis API

A small **Express + TypeScript** (ESM) service that classifies inbound customer
messages ("leads") using a **local Ollama** model and returns a structured JSON
result. It is designed to be consumed by an **n8n** workflow running in Docker
and to be safe by default: strictly bounded input, IP rate limiting, correlation
IDs, structured logging, and no secrets or stack traces exposed to clients.

---

## Prerequisites

- **Node.js 22+** — the code relies on `AbortSignal.timeout`, `AbortSignal.any`,
  `crypto.randomUUID`, `AsyncLocalStorage`, and the built-in `node:test` runner.
- **pnpm 11** — declared in `package.json` under `devEngines.packageManager`.
- **Ollama** running locally with the model `qwen2.5:3b` pulled.
  The client host is currently hard-coded by the `ollama` library to
  `http://127.0.0.1:11434` (see the note on `OLLAMA_HOST` below).
- *(Optional)* **Docker**, only if you run the companion n8n container.

---

## Setup

```bash
# 1. Install dependencies
pnpm install

# 2. Create your local environment file
cp .env.example .env
#    …then edit .env as needed (see the table below)

# 3. Start Ollama and pull the model (in a separate terminal)
ollama serve
ollama pull qwen2.5:3b

# 4. Run in watch mode
pnpm dev
```

The API then listens on `http://localhost:3000` with a health probe at
`http://localhost:3000/health`.

---

## Environment variables

All variables are optional and validated at startup (an invalid value aborts
startup rather than being silently ignored). See `.env.example` for the
authoritative, commented reference.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | TCP port the API listens on. |
| `LOG_LEVEL` | `info` | Pino log level: `error` \| `warn` \| `info` \| `debug`. |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Length of the rate-limit window in ms. |
| `RATE_LIMIT_MAX` | `20` | Max requests per client IP per window (analyze route only). |
| `RATE_LIMIT_TRUST_PROXY` | `0` | Number of trusted reverse-proxy hops. `0` = trust disabled (secure default). Open-ended values like `true` are rejected on purpose. |
| `OLLAMA_TIMEOUT_MS` | `120000` | Max time to wait for a single Ollama completion. |
| `OLLAMA_HOST` | *(unused today)* | Documented for forward compatibility only; the current `ollama` client ignores it and hard-codes `http://127.0.0.1:11434`. |

---

## Scripts

| Script | Command | Notes |
| --- | --- | --- |
| `pnpm dev` | `tsx watch src/server.ts` | Development with hot reload. |
| `pnpm build` | `tsc -p tsconfig.build.json` | Type-checks and emits ESM to `dist/` (test files excluded). |
| `pnpm start` | `node dist/server.js` | **Production** start. Requires `pnpm build` first. |
| `pnpm test` | `tsx --test src/*.test.ts` | Runs the `node:test` suites with `tsx`. |

`main` in `package.json` points at `dist/server.js`, matching the build output.
The project is ESM (`"type": "module"`) with `module`/`moduleResolution`
`NodeNext`, so the emitted files use `.js` import specifiers and run directly
under Node.

---

## API

### `GET /health`

Liveness probe. Never rate limited. Not logged at the default `info` level.

```jsonc
// 200 OK
{ "status": "ok" }
```

### `POST /api/leads/analyze`

Classifies a single customer message. Rate limited by client IP.

**Request** — `Content-Type: application/json`, body limited to 10 kb:

```jsonc
{ "message": "I need a new online store for my bakery." }
```

`message` is required, trimmed, 1–5000 characters.

**Success** — `200 OK`:

```jsonc
{
  "success": true,
  "data": {
    "category": "ecommerce",        // "ecommerce" | "web_development" | "other"
    "intent": "new_website",        // "new_website" | "redesign" | "other"
    "priority": "high",             // "high" | "medium" | "low"
    "summary": "Customer wants a new e-commerce store."
  }
}
```

### Error shapes

Every error response is JSON with a single `error` string (plus `details` on
validation failures). Internal details and stack traces are never returned.

| Status | Body | When |
| --- | --- | --- |
| `400` | `{ "error": "Invalid request", "details": [ … ] }` | Body fails schema validation (`message` missing/empty/too long). |
| `400` | `{ "error": "Invalid request" }` | Malformed JSON rejected by the body parser. |
| `413` | `{ "error": "Invalid request" }` | Request body exceeds the parser's 10 kb limit. |
| `429` | `{ "error": "Too many requests, please try again later." }` | Client IP exceeded `RATE_LIMIT_MAX` within the window. |
| `502` | `{ "error": "Lead analysis failed" }` | Upstream Ollama/network failure (non-timeout). |
| `504` | `{ "error": "Lead analysis timed out" }` | Ollama did not respond within `OLLAMA_TIMEOUT_MS`; the upstream request is actively aborted. |
| `500` | `{ "error": "Internal server error", "requestId": "…" }` | Any other unexpected/unhandled server error. |

### Request ID

Every response carries an **`X-Request-ID`** header. A valid inbound
`X-Request-ID` (ASCII `[A-Za-z0-9._-]`, ≤ 200 chars) is honored and echoed;
otherwise a UUID is generated. The same id is attached to all server logs for
that request and is included in the `500` error body for support
correlation (the header is present on every response regardless).

---

## n8n integration

The n8n container calls this API through the Docker host gateway, using the
endpoint:

```
POST http://host.docker.internal:3000/api/leads/analyze
```

`docker-compose.yml` maps `host.docker.internal` to `host-gateway` on Linux
(`extra_hosts`). Because that route reaches the host over the Docker bridge
network, **the API must listen on all interfaces** (its default). Binding it to
`127.0.0.1` only would make it unreachable from the container and break the
workflow.

The workflow definition lives in the running n8n instance and is tracked for
version control under [`workflows/`](workflows/README.md). That directory
documents the `Webhook → Prepare Lead → API Request → Priority IF → Google
Sheets` flow, how to export and sanitise the workflow JSON, and the expected
`400`/`429`/`502`/`504` retry behaviour. The live n8n instance and the Google
Sheets configuration are **not** managed from this repository.

---

## Security & exposure notes

- The server binds to **all host interfaces** (Express's default when no host is
  given). This is required for the n8n container to reach it via
  `host.docker.internal`. Operators should treat the API as network-exposed on
  the host (LAN/public if the firewall allows) and restrict it with a firewall
  or put it behind a reverse proxy if the machine is not trusted.
- `RATE_LIMIT_TRUST_PROXY` must stay at `0` unless the service sits behind an
  exact, known number of proxies; otherwise a client can spoof
  `X-Forwarded-For` and bypass the rate limit.
- The analyzer treats the customer message as data, never as instructions, and
  requests JSON-only output, but there is **no authentication** on the endpoint.
