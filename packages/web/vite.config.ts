import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const workerProxyTarget = process.env.FILESQL_WORKER_PROXY_TARGET ?? 'http://127.0.0.1:8000'

// https://vite.dev/config/
export default defineConfig({
  base: process.env.FILESQL_BASE_PATH ?? '/',
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
        target: workerProxyTarget,
      },
    },
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
})
