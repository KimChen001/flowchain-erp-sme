import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { contentTypeFor, send, sendText } from "../utils/http.mjs";

const staticAssetPath = pathname =>
  pathname.startsWith("/assets/") ||
  /\.(?:js|css|map|json|png|jpe?g|svg|webp|ico|woff2?|ttf)$/i.test(pathname);

export async function sendStaticAsset({ req, res, url, distDir }) {
  if (!["GET", "HEAD"].includes(req.method))
    return send(res, 404, { error: "Not found" });
  const decodedPath = decodeURIComponent(url.pathname);
  const requested = decodedPath === "/" ? "/index.html" : decodedPath;
  const normalized = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  let filePath = path.join(distDir, normalized);
  if (!filePath.startsWith(distDir)) return sendText(res, 403, "Forbidden");

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = path.join(filePath, "index.html");
  } catch {
    if (staticAssetPath(decodedPath)) {
      res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      return res.end(req.method === "HEAD" ? undefined : "Not found");
    }
    filePath = path.join(distDir, "index.html");
  }

  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentTypeFor(filePath),
      "Cache-Control": filePath.endsWith("index.html")
        ? "no-cache"
        : "public, max-age=31536000, immutable",
    });
    if (req.method === "HEAD") return res.end();
    return res.end(body);
  } catch {
    return sendText(res, 404, "Not found");
  }
}
