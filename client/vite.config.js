import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  // читаем VITE_API_URL, чтобы проксировать /uploads на бэкенд
  const env = loadEnv(mode, process.cwd(), '')
  const API = env.VITE_API_URL || 'http://localhost:4000'

  return {
    plugins: [react()],
    server: {
      host: true,
      port: 5173,
      // оставляем ngrok-хост (можно массивом)
      allowedHosts: ['.ngrok-free.app'],
      // проксируем статику картинок/видео на API
      proxy: {
        '/uploads': {
          target: API,
          changeOrigin: true,
          secure: false,
        },
      },
    },
  }
})
