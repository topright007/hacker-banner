import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const destination = resolve(
  process.argv[2] ?? join(root, "release", `opencode-sensor-v2-${pkg.version}`),
);
await mkdir(destination, { recursive: true });
await writeFile(
  join(destination, "index.js"),
  'export { default } from "./opencode-sensor-v2.mjs";\n',
);
await copyFile(join(root, "dist/index.js"), join(destination, "opencode-sensor-v2.mjs"));
await writeFile(
  join(destination, "package.json"),
  JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      private: true,
      type: "module",
      exports: "./opencode-sensor-v2.mjs",
    },
    null,
    2,
  ) + "\n",
);
await copyFile(join(root, "README.md"), join(destination, "INSTALL.md"));
await copyFile(join(root, "validation-report.json"), join(destination, "validation-report.json"));
for (const file of ["request.schema.json", "response.schema.json"]) {
  await copyFile(join(root, "src/contracts", file), join(destination, file));
}
await writeFile(
  join(destination, "opencode.config.example.json"),
  JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      plugins: [
        {
          package: `/ABSOLUTE/PATH/opencode-sensor-v2-${pkg.version}`,
          options: { enabled: true },
        },
      ],
    },
    null,
    2,
  ) + "\n",
);
const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
const changes = spawnSync(
  "git",
  ["status", "--porcelain", "--", ".", "../../contracts/classifier/opencode-v2"],
  { cwd: root, encoding: "utf8" },
);
const bundle = await readFile(join(destination, "opencode-sensor-v2.mjs"));
await writeFile(
  join(destination, "BUILD.json"),
  JSON.stringify(
    {
      package: pkg.name,
      version: pkg.version,
      harness: "OpenCode 2.0.22",
      classifier_contract: "2.3.0",
      classifier_contracts: { stub: "2.3.0", jev: "2.3.0", agent_monitor: "2.2.0" },
      monitor_protocol: 1,
      classifier:
        "default local always-deny stub; optional Eliza/JEV or Agent Monitor HTTP backend",
      approval_ui:
        "stub/jev: native OpenCode session forms; agent_monitor: trusted service operator CLI while exact call waits",
      source_commit: commit.status === 0 ? commit.stdout.trim() : null,
      source_dirty: changes.status === 0 ? changes.stdout.trim().length > 0 : null,
      bundle_sha256: createHash("sha256").update(bundle).digest("hex"),
      built_at: new Date().toISOString(),
    },
    null,
    2,
  ) + "\n",
);
const files = [
  "index.js",
  "package.json",
  "opencode-sensor-v2.mjs",
  "INSTALL.md",
  "validation-report.json",
  "request.schema.json",
  "response.schema.json",
  "opencode.config.example.json",
  "BUILD.json",
];
const checksums = await Promise.all(
  files.map(
    async (file) =>
      `${createHash("sha256")
        .update(await readFile(join(destination, file)))
        .digest("hex")}  ${file}`,
  ),
);
await writeFile(join(destination, "SHA256SUMS"), checksums.join("\n") + "\n");
const archive = `${destination}.zip`;
const result = spawnSync("zip", ["-q", "-j", archive, ...files, "SHA256SUMS"], {
  cwd: destination,
  encoding: "utf8",
});
if (result.status !== 0)
  throw new Error(`Release files saved to ${destination}; zip failed: ${result.stderr}`);
process.stdout.write(`${archive}\n`);
