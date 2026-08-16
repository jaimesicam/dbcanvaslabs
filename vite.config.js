import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    port: 5174,
    proxy: {
      // Real backend (server/) — Docker/k3d/CNPG/SeaweedFS orchestration + grading.
      '/api': {
        target: 'http://127.0.0.1:8090',
        ws: true,
      },
    },
  },
})
