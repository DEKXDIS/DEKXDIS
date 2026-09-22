import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    watch: {
      ignored: ['**/src-tauri/**', '**/release/**']
    },
    proxy: {
      '/cow-api': {
        target: 'https://api.cow.fi',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/cow-api/, '')
      }
    }
  }
})
