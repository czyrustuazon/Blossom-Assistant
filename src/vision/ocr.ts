import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Dark-UI preprocess for IDE toasts (R2): invert, autocontrast, 2× upscale,
 * optional bottom-right crop heuristic, then threshold. Soft-fails to original.
 */
async function tryPreprocessForOcr(filePath: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "blossom-ocr-"));
  const outPath = path.join(dir, `prep${path.extname(filePath) || ".png"}`);
  const script = `
from PIL import Image, ImageOps, ImageEnhance
import sys
src, dst = sys.argv[1], sys.argv[2]
img = Image.open(src).convert("RGB")
w, h = img.size
# Prefer bottom-right toast region when the frame looks like a full IDE shot
if w >= 640 and h >= 400:
    left = int(w * 0.45)
    top = int(h * 0.55)
    img = img.crop((left, top, w, h))
img = img.convert("L")
img = ImageOps.invert(img)
img = ImageOps.autocontrast(img, cutoff=2)
img = img.resize((img.width * 2, img.height * 2), Image.Resampling.LANCZOS)
img = ImageEnhance.Contrast(img).enhance(1.4)
# Soft threshold — keep gray anti-aliased text readable
img = img.point(lambda p: 255 if p > 140 else (0 if p < 90 else p))
img.save(dst)
`.trim();
  try {
    await execFileAsync("python", ["-c", script, filePath, outPath], {
      timeout: 20_000,
      windowsHide: true,
    });
    await fs.access(outPath);
    return outPath;
  } catch {
    try {
      await execFileAsync("python3", ["-c", script, filePath, outPath], {
        timeout: 20_000,
        windowsHide: true,
      });
      await fs.access(outPath);
      return outPath;
    } catch {
      return filePath;
    }
  }
}

/**
 * Local Tesseract OCR. Requires `tesseract` on PATH (or configured command).
 */
export async function runLocalOcr(
  filePath: string,
  opts: { command?: string; signal?: AbortSignal } = {}
): Promise<string> {
  const command = (opts.command || "tesseract").trim() || "tesseract";
  const prepared = await tryPreprocessForOcr(filePath);
  try {
    // PSM 6 = assume a uniform block of text (toasts/dialogs).
    const { stdout, stderr } = await execFileAsync(
      command,
      [
        prepared,
        "stdout",
        "-l",
        "eng",
        "--psm",
        "6",
        "-c",
        "preserve_interword_spaces=1",
      ],
      {
        timeout: 30_000,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
      }
    );
    const text = String(stdout || "").trim();
    if (!text && stderr) {
      throw new Error(String(stderr).trim().slice(0, 400));
    }
    return text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOENT|not found|is not recognized/i.test(msg)) {
      throw new Error(
        `OCR command not found ("${command}"). Install Tesseract or set blossom.vision.caption.ocrCommand.`
      );
    }
    throw err instanceof Error ? err : new Error(msg);
  } finally {
    if (prepared !== filePath) {
      try {
        await fs.rm(path.dirname(prepared), { recursive: true, force: true });
      } catch {
        // temp cleanup best-effort
      }
    }
  }
}
