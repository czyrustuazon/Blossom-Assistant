import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import type { Browser, BrowserContext, ElementHandle, Page } from "playwright-core";
import { getConfig } from "../config";

type Channel = "chrome" | "msedge";

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;
const refMap = new Map<string, ElementHandle>();

function clearRefs(): void {
  for (const h of refMap.values()) {
    void h.dispose().catch(() => undefined);
  }
  refMap.clear();
}

export async function closeBrowserSession(): Promise<void> {
  clearRefs();
  const b = browser;
  const c = context;
  browser = null;
  context = null;
  page = null;
  try {
    await c?.close();
  } catch {
    /* ignore */
  }
  try {
    await b?.close();
  } catch {
    /* ignore */
  }
}

async function launchWithChannel(channel: Channel, headless: boolean): Promise<Browser> {
  // Lazy require so extension loads without playwright until web is used.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { chromium } = require("playwright-core") as typeof import("playwright-core");
  return chromium.launch({ channel, headless });
}

async function ensurePage(): Promise<Page> {
  if (page) {
    return page;
  }
  const cfg = getConfig().web.browser;
  const preferred = cfg.channel;
  const headless = cfg.headless;
  const order: Channel[] =
    preferred === "msedge" ? ["msedge", "chrome"] : ["chrome", "msedge"];
  let lastErr: unknown;
  for (const ch of order) {
    try {
      browser = await launchWithChannel(ch, headless);
      context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      });
      page = await context.newPage();
      return page;
    } catch (err) {
      lastErr = err;
      await closeBrowserSession();
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(
    `[WEB ROADBLOCK — local] Playwright could not launch Chrome or Edge (channel=${preferred}). ` +
      `Install Google Chrome or Microsoft Edge, or set blossom.web.browser.channel. ` +
      `Blossom uses playwright-core with the system browser — it does not download Chromium. Detail: ${msg}`
  );
}

async function webDir(): Promise<string> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error("No workspace folder open for browser screenshots.");
  }
  const dir = path.join(folder.uri.fsPath, ".blossom", "web");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function browserNavigate(
  url: string
): Promise<{ ok: boolean; content: string }> {
  const target = (url || "").trim();
  if (!target) {
    return { ok: false, content: "browser_navigate requires url." };
  }
  try {
    const p = await ensurePage();
    clearRefs();
    const res = await p.goto(target, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    const title = await p.title();
    const finalUrl = p.url();
    const status = res?.status() ?? 0;
    return {
      ok: true,
      content: [
        `Navigated: ${finalUrl}`,
        `title: ${title}`,
        status ? `http: ${status}` : "",
        "Next: browser_snapshot to list interactive elements, then click/type as needed.",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, content: `browser_navigate failed: ${msg}` };
  }
}

export async function browserSnapshot(
  maxChars = 12_000
): Promise<{ ok: boolean; content: string }> {
  try {
    const p = await ensurePage();
    clearRefs();
    const title = await p.title();
    const url = p.url();
    const handles = await p.$$(
      'a[href], button, input, textarea, select, [role="button"], [role="link"], [onclick]'
    );
    const lines: string[] = [
      `Page: ${title}`,
      `URL: ${url}`,
      "Interactive elements (use ref with browser_click / browser_type):",
    ];
    let refN = 0;
    for (const h of handles) {
      if (refN >= 80) {
        await h.dispose().catch(() => undefined);
        continue;
      }
      const visible = await h.isVisible().catch(() => false);
      if (!visible) {
        await h.dispose().catch(() => undefined);
        continue;
      }
      const tag = await h.evaluate((el) => el.tagName.toLowerCase()).catch(() => "?");
      const role = await h.getAttribute("role").catch(() => null);
      const type = await h.getAttribute("type").catch(() => null);
      const name =
        (await h.getAttribute("aria-label").catch(() => null)) ||
        (await h.getAttribute("name").catch(() => null)) ||
        (await h.getAttribute("placeholder").catch(() => null)) ||
        (await h.innerText().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 80);
      const href = await h.getAttribute("href").catch(() => null);
      refN += 1;
      const ref = `e${refN}`;
      refMap.set(ref, h);
      const bits = [`[${ref}]`, `<${tag}${type ? ` type=${type}` : ""}${role ? ` role=${role}` : ""}>`];
      if (name) {
        bits.push(name);
      }
      if (href) {
        bits.push(`href=${href.slice(0, 100)}`);
      }
      lines.push(bits.join(" "));
    }

    const bodyText = await p
      .locator("body")
      .innerText({ timeout: 10_000 })
      .catch(() => "");
    const normalizedBody = bodyText.replace(/\s+\n/g, "\n").trim();
    lines.push(
      "",
      "Visible text (truncated):",
      normalizedBody.slice(0, Math.max(500, maxChars - 2000))
    );

    let content = lines.join("\n");
    if (content.length > maxChars) {
      content = content.slice(0, maxChars) + "\n…(truncated)";
    }
    return { ok: true, content };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, content: `browser_snapshot failed: ${msg}` };
  }
}

export async function browserClick(
  ref: string
): Promise<{ ok: boolean; content: string }> {
  const key = (ref || "").trim();
  if (!key) {
    return { ok: false, content: "browser_click requires ref (from browser_snapshot)." };
  }
  try {
    await ensurePage();
    const h = refMap.get(key);
    if (!h) {
      return {
        ok: false,
        content: `Unknown ref "${key}". Call browser_snapshot again and use a listed ref.`,
      };
    }
    await h.click({ timeout: 15_000 });
    clearRefs();
    const p = page!;
    return {
      ok: true,
      content: `Clicked ${key}. URL now: ${p.url()}. Call browser_snapshot for updated elements.`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, content: `browser_click failed: ${msg}` };
  }
}

export async function browserType(
  ref: string,
  text: string,
  submit?: boolean
): Promise<{ ok: boolean; content: string }> {
  const key = (ref || "").trim();
  if (!key) {
    return { ok: false, content: "browser_type requires ref." };
  }
  try {
    await ensurePage();
    const h = refMap.get(key);
    if (!h) {
      return {
        ok: false,
        content: `Unknown ref "${key}". Call browser_snapshot again.`,
      };
    }
    await h.fill(String(text ?? ""), { timeout: 15_000 });
    if (submit) {
      await h.press("Enter");
      clearRefs();
    }
    return {
      ok: true,
      content: submit
        ? `Typed into ${key} and pressed Enter. URL: ${page!.url()}. Call browser_snapshot.`
        : `Typed into ${key}.`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, content: `browser_type failed: ${msg}` };
  }
}

export async function browserScroll(
  direction: string,
  amount?: number
): Promise<{ ok: boolean; content: string }> {
  try {
    const p = await ensurePage();
    const dir = (direction || "down").toLowerCase();
    const px = typeof amount === "number" && amount > 0 ? amount : 600;
    const dy = dir === "up" ? -px : px;
    await p.mouse.wheel(0, dy);
    return { ok: true, content: `Scrolled ${dir === "up" ? "up" : "down"} by ${px}px.` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, content: `browser_scroll failed: ${msg}` };
  }
}

export async function browserScreenshot(
  name?: string
): Promise<{ ok: boolean; content: string }> {
  try {
    const p = await ensurePage();
    const dir = await webDir();
    const safe =
      (name || "shot")
        .replace(/[^\w.-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 40) || "shot";
    const file = path.join(dir, `${safe}-${Date.now()}.png`);
    await p.screenshot({ path: file, fullPage: false });
    const folder = vscode.workspace.workspaceFolders?.[0];
    const rel = folder
      ? path.relative(folder.uri.fsPath, file).replace(/\\/g, "/")
      : file;
    return {
      ok: true,
      content: [
        `Screenshot saved: ${rel}`,
        `URL: ${p.url()}`,
        "Local path only — no cloud vision. Use local caption / OCR if you need text from the image.",
      ].join("\n"),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, content: `browser_screenshot failed: ${msg}` };
  }
}
