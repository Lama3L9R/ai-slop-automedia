import tailwind from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

export default defineConfig({
  plugins: [solid(), tailwind()],
  server: {
    port: 5173,
    // 开发时前端单独起，/api 转给后端
    proxy: { '/api': `http://localhost:${process.env.AUTOMEDIA_PORT || 8686}` },
  },
})
