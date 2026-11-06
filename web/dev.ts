// Start the React/Vite development server on loopback.
import { createServer } from "vite";
const server = await createServer();
await server.listen();
server.printUrls();
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void server.close().finally(() => process.exit(0));
  });
