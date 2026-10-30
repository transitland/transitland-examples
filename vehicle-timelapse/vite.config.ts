import { defineConfig } from 'vite'

// The app sends its API requests to the dev server, which forwards them to
// Transitland with your key added, so the key never reaches the browser. Both
// come from the shell's environment.
const apiUrl = process.env.TRANSITLAND_API_URL ?? 'https://transit.land/api/v2'
const apiKey = process.env.TRANSITLAND_API_KEY ?? ''

const forward = {
  target: apiUrl,
  changeOrigin: true,
  headers: apiKey ? { apikey: apiKey } : {}
}

export default defineConfig(({ command }) => {
  if (command === 'serve' && !apiKey) {
    console.warn('TRANSITLAND_API_KEY is not set, so the Transitland API will refuse these requests.')
  }
  return {
    // Settings come from the shell alone; Vite reads no .env files.
    envDir: false,
    server: {
      proxy: {
        '/rest': forward,
        '/tiles': forward
      }
    },
    build: {
      // MapLibre alone is about 1 MB.
      chunkSizeWarningLimit: 1500
    }
  }
})
