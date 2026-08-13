import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { runTests } from "@vscode/test-electron";

async function main() {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, "../../..");
    const extensionTestsPath = path.resolve(__dirname, "./suite/index");
    // A scratch workspace + dedicated user-data dir avoid the VS Code
    // "path argument must be of type string" error when none is provided.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prts-vscode-test-"));
    const workspace = path.join(tmpRoot, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    const userDataDir = path.join(tmpRoot, "user-data");

    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        workspace,
        "--user-data-dir", userDataDir,
        "--disable-workspace-trust",
        // --disable-gpu keeps the test instance stable on headless CI
        // (xvfb) where GL contexts are unavailable.
        "--disable-gpu",
      ],
    });
  } catch (err) {
    console.error("Failed to run tests:", err);
    process.exit(1);
  }
}

main();
