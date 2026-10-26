import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

let certificate: Promise<{ key: string; cert: string }> | undefined;

/**
 * A self-signed certificate for the fake TV's secure control socket, as a real
 * TV has one of Samsung's. It is made with `openssl` the first time a fake TV
 * starts, kept in memory only, and shared by every fake TV in the process.
 */
export const selfSignedCertificate = (): Promise<{ key: string; cert: string }> => {
  certificate ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), "fake-samsung-tv-"));
    try {
      const key = join(dir, "key.pem");
      const cert = join(dir, "cert.pem");
      await promisify(execFile)("openssl", [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-subj",
        "/CN=fake-samsung-tv",
        "-days",
        "2",
        "-keyout",
        key,
        "-out",
        cert,
      ]);
      return { key: await readFile(key, "utf8"), cert: await readFile(cert, "utf8") };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })();
  return certificate;
};
