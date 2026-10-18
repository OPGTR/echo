import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'app',
  base: './',
  plugins: [react()],
  build: { outDir: '../www', emptyOutDir: false, target: 'chrome100', chunkSizeWarningLimit: 1500 },
})
