import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/chat': { target: 'http://localhost:3000', rewrite: (p) => p },
      '/api/pods': { target: 'http://localhost:3000', rewrite: (p) => p.replace('/api', '') },
      '/api/metrics': { target: 'http://localhost:3000', rewrite: (p) => p.replace('/api', '') },
      '/executions': 'http://localhost:3000',
      '/cancel': 'http://localhost:3000',
      '/chats': 'http://localhost:3000',
      '/approve': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
})
