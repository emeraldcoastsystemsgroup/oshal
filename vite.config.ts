/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Vite config for chat module bundling
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Aligned standalone chat bundle output to /src/api/dist/chat-ui.js (ES module)
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added multi-entry browser bundling so /ui can mount the React debug window alongside the standalone chat bundle
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added the response-renderer entry so browser surfaces can import the shared block renderer as an ES module from /dist/response-renderer.js
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Added the surface-bridge entry (same precedent) so the cockpit relay imports the REAL contract (normalizeSurfaceEvent/resolveRelayTarget + zod schemas) as an ES module from /dist/surface-bridge.js — no hand-ported browser twin to drift.
 */

import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  build: {
    outDir: path.resolve(__dirname, 'src/api/dist'),
    emptyOutDir: false,
    sourcemap: true,
    rollupOptions: {
      input: {
        'chat-ui': path.resolve(__dirname, 'src/pages/chat/ui/chat-app.ts'),
        'ui-chat-window': path.resolve(__dirname, 'src/api/chat-ui.jsx'),
        'response-renderer': path.resolve(__dirname, 'src/shared/ui/response-renderer/index.ts'),
        'surface-bridge': path.resolve(__dirname, 'src/features/surface-bridge/index.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        format: 'es',
      },
      preserveEntrySignatures: 'exports-only',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
});
