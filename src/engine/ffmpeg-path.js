// The bundled ffmpeg (scripts/build-ffmpeg.sh). Packaged apps carry it in resources/ffmpeg.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const target = () => `${process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux"}-${process.arch}`;

export function ffmpegPath(resourcesPath = process.resourcesPath) {
  const name = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const packaged = resourcesPath && path.join(resourcesPath, "ffmpeg", name);
  if (packaged && existsSync(packaged)) return packaged;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  return path.join(root, "vendor/ffmpeg", target(), name);
}
