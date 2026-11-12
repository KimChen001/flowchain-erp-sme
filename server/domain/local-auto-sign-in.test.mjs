import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// The local walkthrough signs the local administrator in by itself (owner
// 11/11: signing in each time was a chore). It must stay a local-development
// convenience: it rides on the local mail outbox, which only answers when
// local development is on, and it is off unless the launcher turns it on.

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')

test('the switch is reported only by the local development status route, and only when the launcher sets it', async () => {
  const routes = await read('server/bootstrap/runtime-routes.mjs')
  const status = routes.slice(routes.indexOf('localDevelopment: true'), routes.indexOf('/api/dev/sign-in-links'))
  assert.match(status, /autoSignIn: env\.FLOWCHAIN_LOCAL_AUTO_SIGN_IN === "true"/)
  // Both routes answer 404 when local development is off.
  const guards = routes.match(/if \(!localDevelopmentEnabled\(env\)\) \{\s*send\(res, 404/g) || []
  assert.ok(guards.length >= 2, 'the status route and the outbox route are both local-only')
  const launcher = await read('scripts/walkthrough-local.mjs')
  assert.match(launcher, /FLOWCHAIN_LOCAL_AUTO_SIGN_IN: process\.argv\.includes\("--no-auto-sign-in"\) \? "false" : "true"/)
})

test('the sign-in page signs in through the local-only direct route, which production never has', async () => {
  const page = await read('src/app/SignInScreens.tsx')
  const helper = page.slice(page.indexOf('async function signInLocally'), page.indexOf('// In local development the outbox holds the email'))
  // The direct route: no email link, so no email-link rate limit.
  assert.match(helper, /apiJson<\{ token: string; user: WorkspaceUser \}>\("\/api\/auth\/login"/)
  const routes = await read('server/bootstrap/session-routes.mjs')
  assert.match(routes, /url\.pathname === "\/api\/auth\/login"\) \{\s*if \(!directEmailLoginEnabled\(env\)\) \{\s*send\(res, 404/)
  const contract = await read('server/domain/local-development-contract.mjs')
  assert.match(contract, /if \(String\(env\.FLOWCHAIN_DEPLOYMENT_PROFILE \|\| ''\)\.trim\(\)\.toLowerCase\(\) === 'production'\) return false/)
  // Only when the local status says so, and not right after a sign-out.
  assert.match(page, /const quickSignIn = Boolean\(localStatus\?\.autoSignIn && onSignedIn\);/)
  assert.match(page, /if \(quickSignIn && !justSignedOut && first && autoState === "idle"\)/)
  const app = await read('src/app/FlowChainApp.tsx')
  assert.match(app, /sessionStorage\.setItem\(LOCAL_SIGNED_OUT_KEY, "true"\)/)
  assert.match(app, /<LoginScreen localStatus=\{localStatus\} onSignedIn=\{handleLogin\} \/>/)
})
