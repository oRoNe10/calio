import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// PWA = Progressive Web App.
// זה מה שמאפשר למשתמש "להוריד" את CAL.IO ישירות מהדפדפן,
// בלי חנות אפליקציות - בדיוק כמו שביקשת.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'CAL.IO',
        short_name: 'CAL.IO',
        description: 'עוקב מאזן תזונתי חכם',
        theme_color: '#1e293b',
        background_color: '#ffffff',
        display: 'standalone',
        icons: [
          {
            src: 'icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
  },
})
