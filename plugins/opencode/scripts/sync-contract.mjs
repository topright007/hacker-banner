import { copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = process.argv[2] ?? resolve(root, "../../contracts/classifier/opencode-1.18.11");
for (const file of ["request.schema.json", "response.schema.json"]) {
  await copyFile(join(source, file), join(root, "src/contracts", file));
}
process.stdout.write("Contract schemas synchronized. Rebuild the plugin before use.\n");
