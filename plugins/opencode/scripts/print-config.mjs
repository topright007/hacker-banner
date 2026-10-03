import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
process.stdout.write(
  JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      plugin: [[pathToFileURL(resolve(root, "dist/index.js")).href, { openBrowser: true }]],
    },
    null,
    2,
  ) + "\n",
);
