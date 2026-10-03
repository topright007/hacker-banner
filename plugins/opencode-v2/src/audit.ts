import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClassifierRequest, Native } from "./protocol.js";

export class AuditLog {
  private queue: Promise<void> = Promise.resolve();
  constructor(readonly directory: string) {}

  async start(): Promise<void> {
    await mkdir(join(this.directory, "requests"), { recursive: true, mode: 0o700 });
  }

  async request(request: ClassifierRequest): Promise<void> {
    // Plugin-generated UUID, never a path supplied by model/tool output.
    if (!/^req_[a-f0-9-]+$/.test(request.request_id))
      throw new Error("Invalid local audit request id");
    await writeFile(
      join(this.directory, "requests", `${request.request_id}.json`),
      JSON.stringify(request, null, 2) + "\n",
      {
        flag: "wx",
        mode: 0o600,
      },
    );
  }

  decision(entry: Native): Promise<void> {
    const bytes = JSON.stringify(entry) + "\n";
    const next = this.queue.then(() =>
      appendFile(join(this.directory, "decisions.jsonl"), bytes, { mode: 0o600 }),
    );
    this.queue = next.catch(() => undefined);
    return next;
  }

  async flush(): Promise<void> {
    await this.queue;
  }
}
