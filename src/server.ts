import app from "./app.js";

const PORT = Number(process.env["PORT"] ?? 3000);

// Network binding: omitted host → listen on ALL interfaces (0.0.0.0), which is
// this service's default and is intentionally NOT changed to 127.0.0.1.
//
// Rationale: the n8n Docker container reaches the host API through
// `host.docker.internal:3000` (see docker-compose.yml, extra_hosts →
// host-gateway). The container connects to the host across the Docker bridge,
// so it originates from outside the host's loopback interface. An API bound
// only to 127.0.0.1 would refuse that connection and break the workflow.
//
// Exposure implication: the port is reachable via every host interface (the
// LAN, and the public internet if the host firewall allows it). There is no
// authentication on the endpoints, so operators must restrict access with a
// host firewall or a reverse proxy when the machine is not fully trusted.
const server = app.listen(PORT, () => {
  console.log(`🚀 AI Integration API  →  http://localhost:${PORT}`);
  console.log(`   Health check        →  http://localhost:${PORT}/health`);
  console.log(`   Environment         →  ${process.env["NODE_ENV"] ?? "development"}`);
});

function shutdown(signal: string): void {
  console.log(`\n⛔ Received ${signal}. Shutting down gracefully…`);
  server.close(() => {
    console.log("✅ Server closed.");
    process.exit(0);
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
