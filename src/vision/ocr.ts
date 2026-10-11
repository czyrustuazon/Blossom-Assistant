import { execFile } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Optional dark-UI preprocess (invert + autocontrast) via Python/Pillow.
 * Soft-fails to the original path when Pillow is missing.
 */
async function tryPreprocessForOcr(filePath: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "blossom-ocr-"));
  const outPath = path.join(dir, `prep${path.extname(filePath) || ".png"}`);
  const script = [
    "from PIL import Image, ImageOps",
    "import sys",
    "src, dst = sys.argv[1], sys.argv[2]",
    "img = Image.open(src).convert('L')",
    "img = ImageOps.invert(img)",
    "img = ImageOps.autocontrast(img)",
    "img.save(dst)",
  ].join("; ");
  try {
    await execFileAsync("python", ["-c", script, filePath, outPath], {
      timeout: 15_000,
      windowsHide: true,
    });
    await fs.access(outPath);
    return outPath;
  } catch {
    try {
      await execFileAsync("python3", ["-c", script, filePath, outPath], {
        timeout: 15_000,
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
    const { stdout, stderr } = await execFileAsync(
      command,
      [prepared, "stdout", "-l", "eng", "--psm", "6"],
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
