import app from "./app.js";

const PORT = Number(process.env["PORT"] ?? 3000);

// Network binding: omitted host → listen on ALL interfaces (0.0.0.0). This is
// the service's default and is intentionally kept: the deployment platform
// (Render) expects the process to bind to an externally reachable interface and
// to serve on $PORT.
//
// Exposure implication: the port is reachable via every host interface (the
// LAN, and the public internet if the host firewall allows it). The only route
// is a health probe, which exposes no data; there is no authentication, so
// operators should still restrict access with a host firewall or a reverse
// proxy when the machine is not fully trusted.
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
