// Sentinel gateway entrypoint: starts the config client (which polls the
// control plane and hot-reloads policy) and the HTTP server.

import { ConfigClient } from "./config/configClient.js";
import { createServer } from "./server.js";

const PORT = Number(process.env.PORT ?? 8080);
const CONTROL_PLANE_URL = process.env.SENTINEL_CONTROL_PLANE_URL ?? "http://127.0.0.1:8000";
const INTERNAL_TOKEN = process.env.SENTINEL_INTERNAL_TOKEN ?? "dev-internal-token";
const CONFIG_POLL_MS = Number(process.env.SENTINEL_CONFIG_POLL_MS ?? 5000);

async function main(): Promise<void> {
  const configClient = new ConfigClient(CONTROL_PLANE_URL, INTERNAL_TOKEN, CONFIG_POLL_MS);
  await configClient.start();

  const server = createServer(() => configClient.config);
  server.listen(PORT, () => {
    console.log(
      `sentinel gateway: listening on :${PORT}, control plane at ${CONTROL_PLANE_URL} (poll every ${CONFIG_POLL_MS}ms)`,
    );
  });
}

main().catch((err: unknown) => {
  console.error("sentinel gateway: fatal error during startup:", err);
  process.exit(1);
});
