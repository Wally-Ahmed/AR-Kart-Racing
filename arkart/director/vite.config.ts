import { defineConfig } from 'vite';

// AR Kart director screen. Served on the laptop next to `spacetime start`.
export default defineConfig({
  server: {
    port: 5173,
    host: true, // reachable from the LAN (judges' laptop / second screen)
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
    // Two pages, one dev server: the director wall display and the phone pilot cockpit.
    // The dev server serves both from the project root with no config at all; this entry list is
    // only what makes `vite build` emit pilot.html as well as index.html.
    rollupOptions: {
      input: {
        director: 'index.html',
        pilot: 'pilot.html',
      },
    },
  },
});
