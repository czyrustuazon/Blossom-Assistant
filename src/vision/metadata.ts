import * as fs from "fs/promises";
import * as path from "path";

export interface ImageMetadata {
  path: string;
  width?: number;
  height?: number;
  channels?: string;
  meanRgb?: { r: number; g: number; b: number };
  fileSizeBytes: number;
  summary: string;
}

function readU32BE(buf: Buffer, offset: number): number {
  return buf.readUInt32BE(offset);
}

function parsePngDimensions(buf: Buffer): {
  width: number;
  height: number;
  channels: string;
} | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i++) {
    if (buf[i] !== sig[i]) {
      return null;
    }
  }
  if (buf.toString("ascii", 12, 16) !== "IHDR") {
    return null;
  }
  const width = readU32BE(buf, 16);
  const height = readU32BE(buf, 20);
  const colorType = buf[25];
  const channels =
    colorType === 6
      ? "RGBA"
      : colorType === 2
        ? "RGB"
        : colorType === 4
          ? "Grayscale+Alpha"
          : colorType === 0
            ? "Grayscale"
            : colorType === 3
              ? "Indexed"
              : "Unknown";
  return { width, height, channels };
}

function parseJpegDimensions(buf: Buffer): {
  width: number;
  height: number;
  channels: string;
} | null {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) {
    return null;
  }
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      return { width, height, channels: "RGB" };
    }
    i += 2 + len;
  }
  return null;
}

/** Sample mean RGB from uncompressed PNG RGBA IDAT is heavy — skip unless small PNG. */
async function tryPngMeanRgb(
  filePath: string,
  width: number,
  height: number
): Promise<{ r: number; g: number; b: number } | undefined> {
  if (width * height > 256 * 256) {
    return undefined;
  }
  try {
    const script = [
      "import struct, zlib, sys",
      "p=sys.argv[1]",
      "d=open(p,'rb').read()",
      "sig=d[:8]",
      "if sig!=b'\\x89PNG\\r\\n\\x1a\\n': sys.exit(0)",
      "i=8; w=h=ct=0",
      "while i < len(d):",
      "  ln=struct.unpack('>I', d[i:i+4])[0]; i+=4",
      "  tp=d[i:i+4]; i+=4",
      "  if tp==b'IHDR': w,h=struct.unpack('>II', d[i:i+8]); ct=d[i+8]",
      "  if tp==b'IDAT':",
      "    raw=zlib.decompress(d[i:i+ln])",
      "    stride=w*4+1 if ct==6 else w*3+1",
      "    rs=gs=bs=n=0",
      "    off=0",
      "    for y in range(h):",
      "      off+=1",
      "      for x in range(w):",
      "        if ct==6:",
      "          r,g,b,a=raw[off:off+4]; off+=4",
      "        else:",
      "          r,g,b=raw[off:off+3]; off+=3",
      "        rs+=r; gs+=g; bs+=b; n+=1",
      "    if n: print(f'{rs/n/255:.3f},{gs/n/255:.3f},{bs/n/255:.3f}')",
      "    break",
      "  i+=ln+4",
    ].join("\n");
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const exec = promisify(execFile);
    const { stdout } = await exec("python", ["-c", script, filePath], {
      timeout: 8000,
      windowsHide: true,
    });
    const parts = String(stdout || "")
      .trim()
      .split(",")
      .map(Number);
    if (parts.length === 3 && parts.every((n) => !Number.isNaN(n))) {
      return { r: parts[0], g: parts[1], b: parts[2] };
    }
  } catch {
    // optional enrichment
  }
  return undefined;
}

export async function analyzeImage(filePath: string): Promise<ImageMetadata> {
  const stat = await fs.stat(filePath);
  const head = Buffer.alloc(512);
  const fh = await fs.open(filePath, "r");
  try {
    await fh.read(head, 0, 512, 0);
  } finally {
    await fh.close();
  }

  const ext = path.extname(filePath).toLowerCase();
  let width: number | undefined;
  let height: number | undefined;
  let channels: string | undefined;

  if (ext === ".png") {
    const dim = parsePngDimensions(head);
    if (dim) {
      width = dim.width;
      height = dim.height;
      channels = dim.channels;
    }
  } else if (ext === ".jpg" || ext === ".jpeg") {
    const dim = parseJpegDimensions(head);
    if (dim) {
      width = dim.width;
      height = dim.height;
      channels = dim.channels;
    }
  } else {
    channels = "Unknown";
  }

  let meanRgb: { r: number; g: number; b: number } | undefined;
  if (ext === ".png" && width && height && channels === "RGBA") {
    meanRgb = await tryPngMeanRgb(filePath, width, height);
  }

  const sizePart =
    width && height ? `${width}×${height}` : "unknown dimensions";
  const chPart = channels ?? "?";
  const meanPart = meanRgb
    ? `mean_rgb: ${meanRgb.r.toFixed(2)}, ${meanRgb.g.toFixed(2)}, ${meanRgb.b.toFixed(2)}${
        meanRgb.r < 0.08 && meanRgb.g < 0.08 && meanRgb.b < 0.08
          ? " (alpha-only text chrome suspected)"
          : ""
      }`
    : "";
  const summary = [
    `path: ${filePath}`,
    `size: ${sizePart}`,
    `channels: ${chPart}`,
    meanPart,
    `file_size_bytes: ${stat.size}`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    path: filePath,
    width,
    height,
    channels,
    meanRgb,
    fileSizeBytes: stat.size,
    summary,
  };
}

export async function buildImageMetadataLine(
  filePath: string
): Promise<ImageMetadata> {
  return analyzeImage(filePath);
}
