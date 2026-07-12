import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // Default 3000 (the documented demo origin). Override locally when :3000 is
    // taken, e.g. `DEMO_WEB_PORT=3010 pnpm dev` — keep Core's mpp.cors.allowed_origins
    // in sync with whatever port you serve on.
    port: Number(process.env.DEMO_WEB_PORT) || 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
