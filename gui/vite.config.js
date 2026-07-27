import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// El wizard se sirve desde `inventos --gui` (servidor local en 127.0.0.1:4747).
// `base: './'` → rutas de assets relativas (funciona servido desde cualquier path).
// El build sale a ../dist-gui (lo que el paquete npm publica y el server sirve).
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: '../dist-gui', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:4747' } },
});
