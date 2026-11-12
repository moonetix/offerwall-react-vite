import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

try {
  process.loadEnvFile('.env');
} catch {
  // no .env: use the environment
}
const api = `http://127.0.0.1:${process.env.PORT || 8787}`;

export default defineConfig({
  plugins: [react()],
  // envPrefix stays VITE_: nothing named MOONETIX_* can reach the browser bundle.
  envPrefix: 'VITE_',
  server: {
    proxy: {
      '/api': api,
      '/moonetix': api,
    },
  },
  build: {
    sourcemap: false,
  },
});
