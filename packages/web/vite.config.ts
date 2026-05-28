import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
        target: 'http://127.0.0.1:8000',
      },
    },
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
})
