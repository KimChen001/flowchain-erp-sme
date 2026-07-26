import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalArtifactStorage, createArtifactStorageFromEnv } from "../storage/artifact-storage.mjs";

test("local artifact storage uses generated keys and blocks path traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "flowchain-intake-storage-"));
  try {
    const storage = new LocalArtifactStorage({ rootDirectory: root, maximumBytes: 16 });
    const stored = await storage.put({ bytes: Buffer.from("safe") });
    assert.match(stored.key, /^intake\/[a-f0-9-]{36}$/);
    assert.deepEqual(await storage.getBytes(stored.key), Buffer.from("safe"));
    await assert.rejects(() => storage.put({ key: "../escape", bytes: Buffer.from("bad") }), error => error.code === "ARTIFACT_STORAGE_KEY_INVALID");
    await assert.rejects(() => storage.put({ bytes: Buffer.alloc(17) }), error => error.code === "INTAKE_ARTIFACT_SIZE_LIMIT");
    assert.deepEqual(await storage.delete(stored.key), { deleted: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local artifact storage requires explicit test or development mode", () => {
  assert.equal(createArtifactStorageFromEnv({ NODE_ENV: "test" }), null);
  assert.throws(
    () => createArtifactStorageFromEnv({ NODE_ENV: "production", FLOWCHAIN_INTAKE_LOCAL_STORAGE_DIR: "C:\\unsafe" }),
    error => error.code === "ARTIFACT_STORAGE_LOCAL_FORBIDDEN",
  );
});
