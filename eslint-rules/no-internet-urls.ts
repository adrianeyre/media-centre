import type { Rule } from "eslint";

/**
 * NFR-3: the Hub, the Remote and the Player work with the internet
 * disconnected. So their code names no address on the internet: no CDN, web
 * font or analytics. An Appliance's address is never written in the code
 * either; it comes from the Hub's database. The one exception, disabled where
 * it is, is the Hub's check for the latest version (FR-61), which works on
 * without an answer.
 *
 * A URL whose host is filled in at run time, as in `http://${host}/`, is
 * allowed, and so are the local hosts below.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "hub"]);

const URL_PATTERN = /\b(?:https?|wss?):\/\/(\[[^\]]*\]|[^\s/:?#'"`]*)/gi;

export const noInternetUrls: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "Disallow URLs on the internet: everything must work offline (NFR-3)" },
    messages: {
      internet: "{{url}} is on the internet, but media-centre must work with the internet disconnected (NFR-3).",
    },
    schema: [],
  },
  create(context) {
    const check = (node: Rule.Node, text: string): void => {
      for (const [url, host = ""] of text.matchAll(URL_PATTERN)) {
        if (host !== "" && !LOCAL_HOSTS.has(host.toLowerCase())) {
          context.report({ node, messageId: "internet", data: { url } });
        }
      }
    };
    return {
      Literal(node) {
        if (typeof node.value === "string") check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.raw);
      },
    };
  },
};
