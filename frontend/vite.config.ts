import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // LAN access for QA: open http://<this machine's IP>:5173 from another machine.
    // Only this port needs to be reachable — /api goes through the proxy below.
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
        secure: false,
        // The API's dev CORS allow-list only knows localhost. A page opened as
        // http://172.16.x.x:5173 is same-origin with this proxy, so present it as localhost.
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            if (proxyReq.getHeader("origin")) proxyReq.setHeader("origin", "http://localhost:5173");
          });
        },
      },
    },
  },
  build: {
    minify: 'terser',
    sourcemap: false,
    rollupOptions: {
      output: {
        // React + router change far less often than app code: own chunk = stays cached across deploys.
        manualChunks(id) {
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) {
            return 'react-vendor';
          }
        },
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