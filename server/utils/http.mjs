// A body is held in memory while it is read, so every read has a byte cap.
// Routes that take a file as base64 pass a larger one (bodyLimitForFile).
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024

// Base64 is a third larger than the file; the rest of the JSON (file name,
// type, hash) fits in the 256 KB on top.
export const bodyLimitForFile = (fileBytes) => Math.ceil(fileBytes / 3) * 4 + 256 * 1024

// Both errors are named RequestBodyError, so a route's error mapping can pass
// them on with their status and code. A body that is not JSON stays a
// SyntaxError, which some routes map to a code of their own.
const bodyError = (Type, code, message, status, details) =>
  Object.assign(new Type(message), { name: 'RequestBodyError', code, status, ...(details ? { details } : {}) })

const bodyTooLarge = (maxBytes) =>
  bodyError(Error, 'REQUEST_BODY_TOO_LARGE', 'The request body is larger than this endpoint accepts.', 413, { limitBytes: maxBytes })

export async function readBody(req, { maxBytes = DEFAULT_MAX_BODY_BYTES } = {}) {
  if (Object.prototype.hasOwnProperty.call(req, '__flowchainParsedBody')) return req.__flowchainParsedBody
  if (Number(req.headers?.['content-length'] || 0) > maxBytes) throw bodyTooLarge(maxBytes)
  const chunks = []
  let size = 0
  // Leaving a plain for-await early destroys the request, and Node then
  // resets the connection under the client's next keep-alive request.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > maxBytes) break
    chunks.push(chunk)
  }
  if (size > maxBytes) {
    // The rest is drained without being kept.
    req.resume()
    throw bodyTooLarge(maxBytes)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  let parsed
  try {
    parsed = raw ? JSON.parse(raw) : {}
  } catch {
    throw bodyError(SyntaxError, 'REQUEST_BODY_INVALID_JSON', 'The request body must be valid JSON.', 400)
  }
  Object.defineProperty(req, '__flowchainParsedBody', { value: parsed, enumerable: false })
  return parsed
}

export function send(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  })
  res.end(JSON.stringify(payload))
}

export function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': contentType })
  res.end(text)
}

export function contentTypeFor(filePath) {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
  }[ext] || 'application/octet-stream'
}
