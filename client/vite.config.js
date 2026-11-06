import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // Dev convenience: /api* and /v1* etc. go to the API on :4000.
      '/auth': 'http://localhost:4000',
      '/api-keys': 'http://localhost:4000',
      '/endpoints': 'http://localhost:4000',
      '/events': 'http://localhost:4000',
      '/deliveries': 'http://localhost:4000',
      '/stats': 'http://localhost:4000',
      '/v1': 'http://localhost:4000',
    },
  },
});
