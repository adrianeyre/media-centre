import { createServer } from "node:net";
import type { AddressInfo } from "node:net";

/** A port nothing is listening on right now, for a test that must name one. */
export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => {
        resolve(port);
      });
    });
  });
