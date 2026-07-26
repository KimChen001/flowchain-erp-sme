import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { IntakeError, INTAKE_LIMITS } from "../domain/intake-contracts.mjs";

const STORAGE_KEY = /^intake\/[a-f0-9-]{36}$/;

function storageError(code, message, status = 400) {
  return new IntakeError(code, message, status);
}

export class ArtifactStorage {
  async put() { throw storageError("ARTIFACT_STORAGE_NOT_IMPLEMENTED", "Artifact storage put is not implemented.", 501); }
  async head() { throw storageError("ARTIFACT_STORAGE_NOT_IMPLEMENTED", "Artifact storage head is not implemented.", 501); }
  async getMetadata() { throw storageError("ARTIFACT_STORAGE_NOT_IMPLEMENTED", "Artifact storage metadata is not implemented.", 501); }
  async delete() { throw storageError("ARTIFACT_STORAGE_NOT_IMPLEMENTED", "Artifact storage delete is not implemented.", 501); }
}

export class LocalArtifactStorage extends ArtifactStorage {
  constructor({ rootDirectory, maximumBytes = INTAKE_LIMITS.maximumArtifactSizeBytes } = {}) {
    super();
    if (!rootDirectory) throw storageError("ARTIFACT_STORAGE_ROOT_REQUIRED", "Local artifact storage root is required.", 500);
    this.rootDirectory = resolve(rootDirectory);
    this.maximumBytes = maximumBytes;
    this.provider = "local-development";
  }

  generateKey() {
    return `intake/${randomUUID()}`;
  }

  pathFor(key) {
    if (!STORAGE_KEY.test(String(key || ""))) throw storageError("ARTIFACT_STORAGE_KEY_INVALID", "Artifact storage key is invalid.", 422);
    const path = resolve(this.rootDirectory, ...key.split("/"));
    if (!path.startsWith(`${this.rootDirectory}${sep}`)) throw storageError("ARTIFACT_STORAGE_PATH_TRAVERSAL", "Artifact storage path is outside the configured root.", 422);
    return path;
  }

  async put({ key = this.generateKey(), bytes }) {
    const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
    if (content.byteLength > this.maximumBytes) throw storageError("INTAKE_ARTIFACT_SIZE_LIMIT", "Artifact exceeds the supported size limit.", 413);
    const path = this.pathFor(key);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, content, { flag: "wx" });
    return { provider: this.provider, key, sizeBytes: content.byteLength };
  }

  async head(key) {
    try {
      const info = await stat(this.pathFor(key));
      return { exists: info.isFile(), sizeBytes: info.size };
    } catch (error) {
      if (error?.code === "ENOENT") return { exists: false, sizeBytes: 0 };
      throw error;
    }
  }

  async getMetadata(key) {
    const info = await this.head(key);
    return { provider: this.provider, key, ...info };
  }

  async getBytes(key) {
    return readFile(this.pathFor(key));
  }

  async delete(key) {
    await rm(this.pathFor(key), { force: true });
    return { deleted: true };
  }
}

export function createArtifactStorageFromEnv(env = process.env) {
  const rootDirectory = String(env.FLOWCHAIN_INTAKE_LOCAL_STORAGE_DIR || "").trim();
  if (!rootDirectory) return null;
  if (!["test", "development"].includes(String(env.NODE_ENV || "").trim().toLowerCase())) {
    throw storageError("ARTIFACT_STORAGE_LOCAL_FORBIDDEN", "Local artifact storage is restricted to tests and development.", 500);
  }
  return new LocalArtifactStorage({ rootDirectory });
}
