import * as https from "https";
import * as http from "http";
import { URL } from "url";

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function httpRequest(
  url: string,
  opts: { method?: string; body?: string; timeoutMs?: number } = {}
): Promise<{ status: number; body: string; finalUrl: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "http:" ? http : https;
    const method = opts.method ?? "GET";
    const body = opts.body;
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "http:" ? 80 : 443),
        path: u.pathname + u.search,
        method,
        headers: {
          "User-Agent": UA,
          Accept: "text/html,application/xhtml+xml",
          ...(body
            ? {
                "Content-Type": "application/x-www-form-urlencoded",
                "Content-Length": Buffer.byteLength(body),
              }
            : {}),
        },
        timeout: opts.timeoutMs ?? 20_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (
            status >= 300 &&
            status < 400 &&
            res.headers.location &&
            typeof res.headers.location === "string"
          ) {
            const next = new URL(res.headers.location, url).toString();
            httpRequest(next, { ...opts, method: "GET", body: undefined })
              .then(resolve)
              .catch(reject);
            return;
          }
          resolve({
            status,
            body: Buffer.concat(chunks).toString("utf8"),
            finalUrl: url,
          });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("web_search timed out"));
    });
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16))
    );
}

function stripTags(s: string): string {
  return decodeHtml(s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function unwrapDdgUrl(href: string): string {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    const uddg = u.searchParams.get("uddg");
    if (uddg) {
      return decodeURIComponent(uddg);
    }
    if (u.hostname.includes("duckduckgo.com") && u.pathname === "/l/") {
      const q = u.searchParams.get("uddg");
      if (q) {
        return decodeURIComponent(q);
      }
    }
    return u.toString();
  } catch {
    return href;
  }
}

function parseDdgHtml(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  // Classic HTML endpoint: result__a + nearby result__snippet
  const blockRe =
    /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]*class="[^"]*result__a|<\/div>\s*<\/div>\s*<\/div>|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null && hits.length < 10) {
    const url = unwrapDdgUrl(decodeHtml(m[1]));
    const title = stripTags(m[2]);
    const rest = m[3] || "";
    const snipMatch =
      /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(rest) ||
      /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\//i.exec(rest);
    const snippet = snipMatch ? stripTags(snipMatch[1]) : "";
    if (title && url && /^https?:\/\//i.test(url)) {
      hits.push({ title, url, snippet });
    }
  }

  if (hits.length === 0) {
    // Fallback: any result links
    const linkRe =
      /<a[^>]+href="(https?:\/\/[^"]+|\/\/duckduckgo\.com\/l\/[^"]+)"[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = linkRe.exec(html)) !== null && hits.length < 10) {
      const url = unwrapDdgUrl(decodeHtml(m[1].startsWith("//") ? `https:${m[1]}` : m[1]));
      const title = stripTags(m[2]);
      if (title && url && /^https?:\/\//i.test(url)) {
        hits.push({ title, url, snippet: "" });
      }
    }
  }

  return hits;
}

export async function webSearch(
  query: string,
  maxResults = 8
): Promise<{ ok: boolean; content: string }> {
  const q = (query || "").trim();
  if (!q) {
    return { ok: false, content: "web_search requires query." };
  }
  const limit = Math.max(1, Math.min(maxResults, 12));
  const body = `q=${encodeURIComponent(q)}`;
  try {
    const res = await httpRequest("https://html.duckduckgo.com/html/", {
      method: "POST",
      body,
      timeoutMs: 25_000,
    });
    if (res.status < 200 || res.status >= 400) {
      return {
        ok: false,
        content: `web_search HTTP ${res.status}. Try a different query or fetch_url if you have a link.`,
      };
    }
    const hits = parseDdgHtml(res.body).slice(0, limit);
    if (hits.length === 0) {
      return {
        ok: false,
        content:
          "web_search returned no parseable results (page layout may have changed, or query was empty of hits). Refine the query or ask the user for a URL.",
      };
    }
    const lines = [
      `Web search: ${q}`,
      `Results (${hits.length}):`,
      ...hits.map(
        (h, i) =>
          `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ""}`
      ),
      "",
      "Next: fetch_url on a highly relevant link, refine web_search, or stop and answer.",
    ];
    return { ok: true, content: lines.join("\n") };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, content: `web_search failed: ${msg}` };
  }
}
