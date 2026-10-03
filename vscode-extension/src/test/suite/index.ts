import * as path from "path";
import * as fs from "fs";
import Mocha from "mocha";

export async function run(): Promise<void> {
  const mocha = new Mocha({
    ui: "tdd",
    color: true,
    timeout: 20000,
  });

  const testsRoot = path.resolve(__dirname, ".");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".test.js")) files.push(full);
    }
  };
  walk(testsRoot);
  files.forEach((f) => mocha.addFile(f));

  try {
    await new Promise<void>((c, e) => {
      mocha.run((failures: number) => {
        if (failures > 0) e(new Error(`${failures} tests failed.`));
        else c();
      });
    });
  } catch (err) {
    console.error(err);
    throw err;
  }
}
