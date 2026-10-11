import * as https from "https";
import * as http from "http";
import { URL } from "url";
import { getConfig } from "../config";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const MAX_BYTES = 2_000_000;

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16))
    );
}

function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|br|hr|section|article|header|footer)>/gi, "\n");
  s = s.replace(/<(br|hr)\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeHtml(s);
  s = s
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return s;
}

function fetchOnce(
  url: string,
  redirectLeft: number,
  timeoutMs: number
): Promise<{ status: number; body: string; contentType: string; finalUrl: string }> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      reject(new Error(`Invalid URL: ${url}`));
      return;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      reject(new Error(`Only http/https URLs are allowed (got ${u.protocol})`));
      return;
    }
    const lib = u.protocol === "http:" ? http : https;
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "http:" ? 80 : 443),
        path: u.pathname + u.search,
        method: "GET",
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml,text/plain,application/json,*/*",
        },
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (
          status >= 300 &&
          status < 400 &&
          res.headers.location &&
          redirectLeft > 0
        ) {
          const next = new URL(String(res.headers.location), url).toString();
          res.resume();
          fetchOnce(next, redirectLeft - 1, timeoutMs).then(resolve, reject);
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (c: Buffer) => {
          total += c.length;
          if (total <= MAX_BYTES) {
            chunks.push(c);
          }
        });
        res.on("end", () => {
          resolve({
            status,
            body: Buffer.concat(chunks).toString("utf8"),
            contentType: String(res.headers["content-type"] || ""),
            finalUrl: url,
          });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("fetch_url timed out"));
    });
    req.end();
  });
}

export async function fetchUrl(
  url: string,
  maxChars?: number
): Promise<{ ok: boolean; content: string }> {
  const raw = (url || "").trim();
  if (!raw) {
    return { ok: false, content: "fetch_url requires url." };
  }
  const cap =
    typeof maxChars === "number" && maxChars > 0
      ? Math.min(maxChars, 100_000)
      : getConfig().web.fetchMaxChars;

  try {
    const res = await fetchOnce(raw, 5, 25_000);
    if (res.status < 200 || res.status >= 400) {
      return {
        ok: false,
        content: `fetch_url HTTP ${res.status} for ${res.finalUrl}`,
      };
    }
    const ct = res.contentType.toLowerCase();
    let text: string;
    if (ct.includes("json") || ct.includes("text/plain")) {
      text = res.body;
    } else if (
      ct.includes("html") ||
      /^\s*</.test(res.body) ||
      !ct
    ) {
      text = htmlToText(res.body);
    } else if (ct.startsWith("text/")) {
      text = res.body;
    } else {
      return {
        ok: false,
        content: `fetch_url unsupported content-type: ${ct || "(unknown)"} at ${res.finalUrl}`,
      };
    }

    const truncated = text.length > cap;
    const body = truncated ? text.slice(0, cap) : text;
    const lines = [
      `Fetched: ${res.finalUrl}`,
      `content-type: ${ct || "(unknown)"}`,
      truncated ? `truncated to ${cap} chars (of ${text.length})` : `chars: ${text.length}`,
      "",
      body,
    ];
    return { ok: true, content: lines.join("\n") };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, content: `fetch_url failed: ${msg}` };
  }
}
