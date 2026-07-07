const cp = require("node:child_process");
const path = require("node:path");

const packageJson = require(path.join(__dirname, "..", "package.json"));
const npmExecPath = process.env.npm_execpath;

if (!npmExecPath) {
  throw new Error("npm_execpath is not available. Run this script via npm.");
}

const outputFile = `cmsis-dev-${packageJson.version}.vsix`;

cp.execFileSync(
  process.execPath,
  [
    npmExecPath,
    "exec",
    "--yes",
    "--package",
    "@vscode/vsce",
    "--",
    "vsce",
    "package",
    "--out",
    outputFile
  ],
  {
    cwd: path.join(__dirname, ".."),
    stdio: "inherit"
  }
);
