import { fileURLToPath, pathToFileURL } from "node:url";
import { isAbsolute } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
let options = { enabled: true };
if (args.length === 1 && args[0] === "--jev") {
  options = { enabled: true, backend: "jev", classifierTimeoutMs: 10000 };
} else if (args.length) {
  if (args.length !== 2 || args[0] !== "--monitor-credentials" || !isAbsolute(args[1]))
    throw new Error(
      "Usage: config:print [--jev | --monitor-credentials /absolute/private/run.credentials.json]",
    );
  options = {
    enabled: true,
    backend: "agent_monitor",
    monitorCredentials: args[1],
    apiTimeoutMs: 5000,
  };
}
process.stdout.write(
  JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      plugins: [{ package: pathToFileURL(root).href, options }],
    },
    null,
    2,
  ) + "\n",
);
