import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

export interface MediaTools {
  ffmpeg: string;
  ffprobe: string;
}

const PACKAGES = ["@ffmpeg-installer/ffmpeg@1.1.0", "@ffprobe-installer/ffprobe@2.1.2"];

function execute(command: string, args: string[], cwd?: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      shell: cwd !== undefined && process.platform === "win32",
      stdio: "ignore"
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        resolve(false);
      } else {
        reject(error);
      }
    });
    child.once("close", (code) => resolve(code === 0));
  });
}

async function availableCommand(command: string): Promise<string | undefined> {
  return (await execute(command, ["-version"])) ? command : undefined;
}

async function installedCommand(storagePath: string, packageName: string): Promise<string | undefined> {
  try {
    const installer = require(path.join(storagePath, "node_modules", packageName)) as { path: string };
    await fs.access(installer.path);
    return (await execute(installer.path, ["-version"])) ? installer.path : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveAvailableMediaTools(storagePath: string): Promise<Partial<MediaTools>> {
  return {
    ffmpeg: await availableCommand("ffmpeg") ?? await installedCommand(storagePath, "@ffmpeg-installer/ffmpeg"),
    ffprobe: await availableCommand("ffprobe") ?? await installedCommand(storagePath, "@ffprobe-installer/ffprobe")
  };
}

export async function ensureMediaTools(storagePath: string): Promise<MediaTools | undefined> {
  const available = await resolveAvailableMediaTools(storagePath);
  if (available.ffmpeg && available.ffprobe) {
    return { ffmpeg: available.ffmpeg, ffprobe: available.ffprobe };
  }

  const missing = [!available.ffmpeg && "FFmpeg", !available.ffprobe && "FFprobe"].filter(Boolean).join(" and ");
  const choice = await vscode.window.showWarningMessage(
    `${missing} ${missing.includes(" and ") ? "are" : "is"} required for transcription. Download portable FFmpeg and FFprobe binaries into CMSIS-Dev extension storage? This uses npm and does not modify your system PATH.`,
    { modal: true },
    "Install"
  );
  if (choice !== "Install") {
    return undefined;
  }

  await fs.mkdir(storagePath, { recursive: true });
  const installed = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "Installing FFmpeg and FFprobe for transcription"
  }, () => execute(process.platform === "win32" ? "npm.cmd" : "npm", [
    "install", "--ignore-scripts", "--no-save", "--no-package-lock", "--no-audit", "--no-fund", "--prefix", ".", ...PACKAGES
  ], storagePath));
  if (!installed) {
    throw new Error("Could not install FFmpeg and FFprobe. Install npm or FFmpeg and FFprobe manually, then make both available on PATH.");
  }

  const resolved = await resolveAvailableMediaTools(storagePath);
  if (!resolved.ffmpeg || !resolved.ffprobe) {
    throw new Error("FFmpeg and FFprobe installation completed but the binaries could not be run. Install them manually and add both to PATH.");
  }
  return { ffmpeg: resolved.ffmpeg, ffprobe: resolved.ffprobe };
}