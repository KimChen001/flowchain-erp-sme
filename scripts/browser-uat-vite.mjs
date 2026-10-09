import { createServer } from 'vite'

const appPort = Number(process.env.PLAYWRIGHT_APP_PORT || 15173)
const apiPort = process.env.PLAYWRIGHT_API_PORT || '18787'

process.env.SCM_API_PROXY_TARGET = `http://127.0.0.1:${apiPort}`

const server = await createServer({
  configFile: 'vite.config.mjs',
  server: {
    // walkthrough-local.mjs --lan sets 0.0.0.0 so a phone on the same network can open the app.
    host: process.env.PLAYWRIGHT_APP_HOST || '127.0.0.1',
    port: appPort,
    strictPort: true,
  },
})

await server.listen()
server.printUrls()

const close = async () => {
  await server.close()
  process.exit(0)
}

process.once('SIGINT', close)
process.once('SIGTERM', close)
