import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import { AuditLogger, type AuditEntry } from "../src/observability/auditLog.js";

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port assigned");
  return address.port;
}

function sampleEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    timestamp: new Date().toISOString(),
    method: "GET",
    path: "/v1/orders",
    clientIp: "203.0.113.5",
    apiKeyId: "key-1",
    role: "reader",
    routeId: "r1",
    allowed: true,
    stage: null,
    statusCode: 200,
    durationMs: 12,
    ...overrides,
  };
}

test("record: always logs locally, even with forwarding disabled", () => {
  const logger = new AuditLogger(null, "token");
  const originalLog = console.log;
  const logged: string[] = [];
  console.log = (msg: string) => logged.push(msg);
  try {
    logger.record(sampleEntry());
  } finally {
    console.log = originalLog;
  }
  assert.equal(logged.length, 1);
  assert.match(logged[0] ?? "", /"routeId":"r1"/);
});

test("flush: does nothing when forwarding is disabled", async () => {
  const logger = new AuditLogger(null, "token");
  logger.record(sampleEntry());
  await assert.doesNotReject(() => logger.flush());
});

test("flush: posts the buffered batch to /internal/audit with the bearer token", async () => {
  let received: unknown;
  let authHeader: string | undefined;
  const server = http.createServer((req, res) => {
    authHeader = req.headers.authorization;
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      received = JSON.parse(body);
      res.writeHead(200);
      res.end();
    });
  });
  const port = await listen(server);

  const originalLog = console.log;
  console.log = () => {};
  try {
    const logger = new AuditLogger(`http://127.0.0.1:${port}`, "secret-token");
    logger.record(sampleEntry({ routeId: "r1" }));
    logger.record(sampleEntry({ routeId: "r2" }));
    await logger.flush();
  } finally {
    console.log = originalLog;
    server.close();
  }

  assert.equal(authHeader, "Bearer secret-token");
  const body = received as { entries: AuditEntry[] };
  assert.equal(body.entries.length, 2);
  assert.equal(body.entries[0]?.routeId, "r1");
});

test("flush: clears the buffer even when the request fails", async () => {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    // Nothing listens on port 1: the fetch will fail.
    const logger = new AuditLogger("http://127.0.0.1:1", "token");
    logger.record(sampleEntry());
    await logger.flush();
    // A second flush should be a no-op (buffer already drained), not throw.
    await assert.doesNotReject(() => logger.flush());
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
});

test("record: auto-flushes once the batch size limit is reached", async () => {
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    requestCount += 1;
    req.on("data", () => {});
    req.on("end", () => res.end());
  });
  const port = await listen(server);

  const originalLog = console.log;
  console.log = () => {};
  try {
    const logger = new AuditLogger(`http://127.0.0.1:${port}`, "token", 5000, 3);
    logger.record(sampleEntry());
    logger.record(sampleEntry());
    logger.record(sampleEntry()); // hits maxBatchSize=3, triggers an async flush
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    console.log = originalLog;
    server.close();
  }
  assert.equal(requestCount, 1);
});
