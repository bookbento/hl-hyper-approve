import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0', // 👈 This line allows network access
    port: 5173,       // Optional: avoid port auto-switching
    proxy: {
      "/api": {
target: "http://localhost:3001",
        changeOrigin: true,
        secure: false,
      },
    },
  },
  build: {
    minify: 'terser',
    sourcemap: false,
    rollupOptions: {
      output: {
        // Ensure the worker file is built as a normal JS file, not an ES module
        assetFileNames: (assetInfo) => {
          if (assetInfo.name && assetInfo.name.includes('pdf.worker')) {
            return 'assets/[name].[hash].js';
          }
          return 'assets/[name].[hash].[ext]';
        },
      }
    }
  },
  esbuild: {
    logOverride: { 'this-is-undefined-in-esm': 'silent' }
  }
});