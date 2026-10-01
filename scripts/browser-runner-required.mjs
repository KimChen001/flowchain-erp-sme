// Default web server for `playwright test` when no PLAYWRIGHT_*_DB variable
// picks a database-backed API. The runtime is PostgreSQL-only, so there is no
// server to start without one: say how to run the specs instead of letting the
// API exit with FLOWCHAIN_DATABASE_URL_REQUIRED.
console.error(`
Browser specs need a database-backed API, and none was selected.

Run a suite through its npm script, which starts embedded PostgreSQL and seeds it:
  npm run test:browser:product-recovery   (US walkthrough data)
  npm run test:browser:<suite>            (see "test:browser:*" in package.json)

To run a single spec against the walkthrough data:
  PLAYWRIGHT_PRODUCT_RECOVERY_DB=true npx playwright test tests/browser/<name>.spec.ts
`);
process.exit(1);
