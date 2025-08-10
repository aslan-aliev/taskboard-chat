// client/vite.config.js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Ничего лишнего. В dev можно держать server.host/allowedHosts,
  // но для prod это не нужно.
})
