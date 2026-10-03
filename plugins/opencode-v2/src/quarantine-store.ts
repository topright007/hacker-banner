import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

const schemaVersion = "1.0.0";
const maxSessionBytes = 1024;
const maxMarkerBytes = 16 * 1024;

function sessionDigest(sessionID: string): string {
  if (
    typeof sessionID !== "string" ||
    sessionID.trim().length === 0 ||
    Buffer.byteLength(sessionID, "utf8") > maxSessionBytes
  ) {
    throw new Error("Invalid quarantine session id");
  }
  return createHash("sha256").update(sessionID).digest("hex");
}

function validateMarker(bytes: Buffer, sessionID: string): void {
  if (bytes.length > maxMarkerBytes) throw new Error("Invalid quarantine marker");
  let marker: unknown;
  try {
    marker = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Invalid quarantine marker");
  }
  if (typeof marker !== "object" || marker === null || Array.isArray(marker)) {
    throw new Error("Invalid quarantine marker");
  }
  const value = marker as Record<string, unknown>;
  const timestamp = typeof value.activated_at === "string" ? Date.parse(value.activated_at) : NaN;
  if (
    value.schema_version !== schemaVersion ||
    value.session_id !== sessionID ||
    value.status !== "quarantined" ||
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== value.activated_at
  ) {
    throw new Error("Invalid quarantine marker");
  }
}

/** Shared workspace state; kept outside per-instance audit directories. */
export class QuarantineStore {
  private readonly active = new Set<string>();

  constructor(readonly directory: string) {}

  async isQuarantined(sessionID: string): Promise<boolean> {
    const digest = sessionDigest(sessionID);
    let bytes: Buffer;
    try {
      // Read on every check so other plugin instances can activate quarantine.
      bytes = await readFile(join(this.directory, `${digest}.json`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return this.active.has(sessionID);
      }
      throw error;
    }
    validateMarker(bytes, sessionID);
    this.active.add(sessionID);
    return true;
  }

  async activate(sessionID: string): Promise<void> {
    const digest = sessionDigest(sessionID);
    // Block concurrent calls immediately, including if persistence later fails.
    this.active.add(sessionID);
    const marker = {
      schema_version: schemaVersion,
      session_id: sessionID,
      status: "quarantined",
      activated_at: new Date().toISOString(),
    };
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = join(this.directory, `${digest}.json`);
    const temporary = join(this.directory, `.${digest}.${randomUUID()}.tmp`);
    let ownsTemporary = false;
    try {
      const file = await open(temporary, "wx", 0o600);
      ownsTemporary = true;
      try {
        await file.writeFile(JSON.stringify(marker) + "\n");
        await file.sync();
      } finally {
        await file.close();
      }
      // Readers see either no marker or a complete, validated JSON document.
      await rename(temporary, destination);
    } finally {
      if (ownsTemporary) await rm(temporary, { force: true });
    }
  }
}
