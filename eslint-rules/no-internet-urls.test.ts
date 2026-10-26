import { RuleTester } from "eslint";
import { describe, it } from "vitest";

import { noInternetUrls } from "./no-internet-urls.ts";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

new RuleTester().run("no-internet-urls", noInternetUrls, {
  valid: [
    'fetch("/api/hub")',
    'new URL(path, "http://hub")',
    'const url = "http://127.0.0.1:8080/api/hub"',
    'const url = "http://localhost:5173"',
    'console.log("Hub listening on http://0.0.0.0:8080")',
    'const url = "ws://[::1]:8001/api/v2/channels"',
    "const url = `http://${host}:${port}/api/v2/`",
    "const url = `https://${host}:8002`",
    'const text = "no address here"',
  ],
  invalid: [
    { code: 'import "https://cdn.example.com/lib.js"', errors: [{ messageId: "internet" }] },
    { code: 'fetch("https://api.example.com/update")', errors: [{ messageId: "internet" }] },
    { code: 'const font = "https://fonts.googleapis.com/css?family=Roboto"', errors: [{ messageId: "internet" }] },
    { code: "const tv = `http://192.168.1.20:${port}/api/v2/`", errors: [{ messageId: "internet" }] },
    { code: 'const socket = "wss://example.com"', errors: [{ messageId: "internet" }] },
    {
      code: 'const both = "http://localhost/ then http://example.com/"',
      errors: [{ messageId: "internet", data: { url: "http://example.com" } }],
    },
  ],
});
