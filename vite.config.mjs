import { defineConfig } from 'vite'
import path from 'path'
import { fileURLToPath } from 'url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function figmaAssetResolver() {
  return {
    name: 'figma-asset-resolver',
    resolveId(id) {
      if (id.startsWith('figma:asset/')) {
        const filename = id.replace('figma:asset/', '')
        return path.resolve(__dirname, 'src/assets', filename)
      }
    },
  }
}

// The sign-in confirm page carries a single-use token in its address; the
// production static server sends the same header (server/bootstrap/static-assets.mjs).
function signInConfirmReferrerPolicy() {
  return {
    name: 'sign-in-confirm-referrer-policy',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (String(req.url || '').split('?')[0] === '/sign-in/confirm') res.setHeader('Referrer-Policy', 'no-referrer')
        next()
      })
    },
  }
}

export default defineConfig({
  plugins: [
    signInConfirmReferrerPolicy(),
    figmaAssetResolver(),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      '/api': process.env.SCM_API_PROXY_TARGET || 'http://127.0.0.1:8787',
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('recharts') || id.includes('d3-')) return 'vendor-charts'
          return 'vendor'
        },
      },
    },
  },
  assetsInclude: ['**/*.svg', '**/*.csv'],
})
