# Proposal: move the browser session into an HttpOnly cookie

Status: proposal only, nothing here is built. Owner decision (pilot item 5):
write the proposal now, build it after the pilot, and remove the CORS `*`
header in the same change. Estimated size: 3 to 4 working days.

## Why

The browser keeps the workspace session token in `localStorage`. Any script
that runs in the page can read it and send it elsewhere. The token is a bearer
credential valid for up to 8 hours, so a single cross-site scripting (XSS) bug
would let an attacker use the account from their own machine until it expires
or the user signs out.

The Content-Security-Policy added with the security headers
(`server/bootstrap/security-headers.mjs`) makes such a bug much harder to
exploit: only scripts from the app's own origin run, and the page can only
connect back to that origin. It does not make the token unreadable. An
`HttpOnly` cookie does: script cannot read it at all, so XSS is limited to
acting inside the open tab while it is open. The two measures complement each
other. The CSP shrinks the chance of XSS, and the cookie limits what XSS can
take.

The cost is a new risk the bearer header does not have. Browsers attach
cookies automatically, so cross-site request forgery (CSRF) has to be handled
(step 3).

## How the session works today

Line numbers are from `main` at 43f415bf.

- The token is `payload.signature`, where the payload is `{sid, iat, exp}`
  (`server/domain/local-signed-session.mjs:18-21`). The session row lives in
  PostgreSQL and is checked on every request (`server/auth/workspace-sessions.mjs`).
- Sign-in returns the token in the JSON body (`signedInPayload`,
  `server/bootstrap/session-routes.mjs:21-29`), from the email-link confirm
  route (`:55-56`) and the local-development login (`:114`).
- A session lasts 8 hours and is not refreshed (`SESSION_TTL_SECONDS`,
  `server/auth/workspace-sessions.mjs:10`). Logout revokes the row
  (`session-routes.mjs:118-124`).
- The server reads the token only from `Authorization: Bearer`
  (`resolveRequestIdentity`, `local-signed-session.mjs:54-65`).
- The SPA stores it under `localStorage['flowchain:auth-token']`
  (`src/lib/api-client.ts:3`) and sends it from `apiJson` (`:48-49`). Other
  readers and writers: `src/app/SignInScreens.tsx:393`,
  `src/app/FlowChainApp.tsx:427, 614, 1156`, `src/i18n/I18n.tsx:851, 863`,
  `src/modules/intake/Page.tsx:183-185`, and
  `src/modules/master-data/DataImportPage.tsx:137-138`.
- Every API answer carries `Access-Control-Allow-Origin: *`
  (`server/utils/http.mjs:14`).
- `readBody` parses any request body as JSON whatever its `Content-Type`
  (`server/utils/http.mjs:1-9`).
- 58 Playwright files under `tests/browser` put the token into
  `localStorage`, and 59 files under `tests` and `scripts` send it as a bearer
  header. `server/domain/frontend-session-contract.test.mjs:7-15` pins the
  storage key and the header.

## Proposed change

1. **Server reads the cookie as a second source.** `resolveRequestIdentity`
   keeps reading `Authorization: Bearer` first. Without one, it reads the
   `__Host-flowchain_session` cookie and passes the value through the same
   `verifyLocalSessionToken` and `sessionStore.resolve` path. Authorization
   rules do not change: the same session row decides the same identity.
2. **Sign-in sets the cookie and logout clears it.** The email-link confirm
   route and the local-development login add
   `Set-Cookie: __Host-flowchain_session=<token>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`.
   `Max-Age` equals `SESSION_TTL_SECONDS`. Logout sends the same cookie with
   `Max-Age=0` as well as revoking the row. The `__Host-` prefix makes the
   browser refuse the cookie unless it is `Secure`, has `Path=/` and has no
   `Domain`, so no other subdomain can set or read it. Chrome and Firefox treat
   `http://localhost` as secure, so local development keeps working there.
   Safari does not, so a non-prefixed name may be needed for local Safari
   testing only.
3. **CSRF check for cookie-authenticated writes.** When the identity came from
   the cookie (not the bearer header) and the method is `POST`, `PATCH`, `PUT`
   or `DELETE`, the request must carry an `Origin` header equal to
   `FLOWCHAIN_PUBLIC_BASE_URL` (the Vite origin in local development).
   Otherwise the server answers `403` with a stable code such as
   `CSRF_ORIGIN_MISMATCH`. `SameSite=Strict` alone is not enough. It does not
   separate sibling subdomains, which count as the same site. And because
   `readBody` accepts a `text/plain` body as JSON, a plain HTML form on another
   site could otherwise post a valid JSON payload. Requiring
   `Content-Type: application/json` for cookie-authenticated writes is a
   reasonable second check.
4. **Remove `Access-Control-Allow-Origin: *`** from `send`
   (`server/utils/http.mjs:14`) and its allow-methods and allow-headers
   companions. The SPA is same-origin and does not need them. The CORS
   preflight answer (`http-request-handler.mjs:35`) can then stay a bare
   `204`.
5. **The SPA stops storing the token.** `apiJson` and the two direct `fetch`
   calls drop the bearer header. Same-origin `fetch` sends the cookie by
   default. The signed-in check uses `CURRENT_USER_KEY`
   (`flowchain:current-user`, which holds no secret) as a hint, and
   `/api/auth/me` decides. A `401` clears the hint and shows sign-in, as today.
   On first load after the release, delete any leftover
   `flowchain:auth-token`, so a token stored before the change does not linger.
   Users signed in at release time sign in again once.
6. **Scripts, smoke tests and mobile clients keep the bearer header.** The
   server keeps reading `Authorization` first, so they need no change. The
   sign-in JSON keeps returning `token` for them. Dropping it from browser
   responses can be decided later.

## Work and size

| Part | Work | Days |
| --- | --- | ---: |
| Server | Cookie read in `resolveRequestIdentity`, `Set-Cookie` on sign-in and logout, Origin check, remove CORS `*`, unit tests | 0.5 |
| SPA | `api-client.ts`, `SignInScreens.tsx`, `FlowChainApp.tsx`, `I18n.tsx`, the two direct `fetch` calls, cleanup of the old key, `frontend-session-contract.test.mjs` | 0.5 |
| Browser tests | Replace the `localStorage` token in the 58 Playwright files with `context.addCookies` (ideally one shared helper), then run the suites | 1.5 to 2 |
| Review and staging check | Sign in, sign out, expiry, two tabs, downloads, a cross-origin form post refused | 0.5 to 1 |

## Risks and checks

- The Origin check must allow the real public origin on Render and the Vite
  origin locally. Requests without an `Origin` header but with the cookie are
  refused for writes. Browsers always send `Origin` on cross-origin and
  same-origin `POST`/`PATCH`/`DELETE` from `fetch`.
- `/sign-in/confirm` posts the single-use token from the page, which keeps
  working. The cookie is set on that response.
- A sign-out in one tab signs out all tabs, as today (the session row is
  revoked).
- The container smoke (`scripts/smoke-production-container.mjs`) talks to
  `http://127.0.0.1`. It keeps using the bearer header, so the `Secure` cookie
  does not affect it.
