const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

if (process.platform !== "win32") {
  console.log("windows helper: skipped on non-Windows platform");
  process.exit(0);
}

const root = path.resolve(__dirname, "..");
const source = path.join(root, "src", "native", "windows", "NeteaseController.cs");
const output = path.join(root, "src", "native", "windows", "NeteaseController.exe");
const frameworkRoots = [
  path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319"),
  path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework", "v4.0.30319")
];
const compilerRoot = frameworkRoots.find((candidate) =>
  fs.existsSync(path.join(candidate, "csc.exe"))
);

if (!compilerRoot) {
  console.error("windows helper: .NET Framework C# compiler was not found");
  process.exit(1);
}

function findFrameworkAssembly(name) {
  const assemblyName = path.parse(name).name;
  const roots = [
    path.join(
      process.env.WINDIR || "C:\\Windows",
      "Microsoft.NET",
      "assembly",
      "GAC_MSIL",
      assemblyName
    ),
    path.join(
      process.env.WINDIR || "C:\\Windows",
      "assembly",
      "GAC_MSIL",
      assemblyName
    )
  ];
  for (const assemblyRoot of roots) {
    if (!fs.existsSync(assemblyRoot)) continue;
    for (const version of fs.readdirSync(assemblyRoot, { withFileTypes: true })) {
      if (!version.isDirectory()) continue;
      const candidate = path.join(assemblyRoot, version.name, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

const automationClient = findFrameworkAssembly("UIAutomationClient.dll");
const automationTypes = findFrameworkAssembly("UIAutomationTypes.dll");
const windowsBase = findFrameworkAssembly("WindowsBase.dll");
const accessibility = path.join(compilerRoot, "Accessibility.dll");
if (
  !automationClient ||
  !automationTypes ||
  !windowsBase ||
  !fs.existsSync(accessibility)
) {
  console.error("windows helper: Windows UI Automation assemblies were not found");
  process.exit(1);
}

const result = spawnSync(
  path.join(compilerRoot, "csc.exe"),
  [
    "/nologo",
    "/target:exe",
    "/optimize+",
    `/out:${output}`,
    `/reference:${automationClient}`,
    `/reference:${automationTypes}`,
    `/reference:${windowsBase}`,
    `/reference:${accessibility}`,
    source
  ],
  { cwd: root, encoding: "utf8" }
);

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) process.exit(result.status || 1);

console.log(`windows helper: built ${path.relative(root, output)}`);
