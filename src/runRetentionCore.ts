import * as fs from "node:fs/promises";
import * as path from "node:path";

export function getRelatedRunFilePaths(outputPath: string): string[] {
  return [outputPath, `${outputPath}.reasoning.md`, `${outputPath}.meta.json`];
}

export async function pruneRunFiles(runsDirPath: string, limit: number, pendingOutputs: ReadonlySet<string> = new Set()): Promise<void> {
  const entries = await fs.readdir(runsDirPath, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const outputs = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !entry.name.endsWith(".reasoning.md") && !pendingOutputs.has(path.join(runsDirPath, entry.name)))
    .map(async (entry) => {
      const outputPath = path.join(runsDirPath, entry.name);
      const modifiedAt = (await fs.stat(outputPath)).mtimeMs;
      return { outputPath, modifiedAt };
    }));
  outputs.sort((left, right) => right.modifiedAt - left.modifiedAt || path.basename(left.outputPath).localeCompare(path.basename(right.outputPath)));
  for (const output of outputs.slice(limit)) {
    await Promise.all(getRelatedRunFilePaths(output.outputPath).map((filePath) => fs.rm(filePath, { force: true })));
  }
}