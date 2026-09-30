import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const OUTBOX_LIMIT = 50;

// Local development and tests only: messages go to a JSON file instead of
// being sent. It lives in the OS temp directory unless
// FLOWCHAIN_MAIL_OUTBOX_PATH names another file; never inside the repository.
export function defaultOutboxPath(env = process.env) {
  return String(env.FLOWCHAIN_MAIL_OUTBOX_PATH || "").trim() || join(tmpdir(), "flowchain-mail-outbox.json");
}

export async function readOutbox(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return Array.isArray(parsed?.messages) ? parsed.messages : [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export function createOutboxMailer({ path, now = () => new Date() }) {
  let queue = Promise.resolve();
  return {
    provider: "outbox",
    path,
    send({ to, subject, text, html, tag }) {
      const entry = { id: randomUUID(), provider: "outbox", to, subject, text, html, tag: tag || null, createdAt: now().toISOString() };
      // Writes are serialized so concurrent sends never lose a message.
      const write = queue.then(async () => {
        const messages = [...(await readOutbox(path)), entry].slice(-OUTBOX_LIMIT);
        await mkdir(dirname(path), { recursive: true });
        const temporary = `${path}.${process.pid}.${entry.id}.tmp`;
        await writeFile(temporary, JSON.stringify({ messages }, null, 2));
        await rename(temporary, path);
        return { provider: "outbox", messageId: entry.id };
      });
      queue = write.catch(() => {});
      return write;
    },
  };
}
