const port = process.env.PLAYWRIGHT_API_PORT || '18787'

process.env.SCM_API_PORT = port
process.env.FLOWCHAIN_ALLOW_TEST_IDENTITY_HEADERS = 'true'

await import('../server/index.mjs')
