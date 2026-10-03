import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
process.stdout.write(
  JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      plugins: [
        { package: pathToFileURL(root).href, options: { enabled: true, openBrowser: true } },
      ],
    },
    null,
    2,
  ) + "\n",
);
