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
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | JVV-007: vendor the lock-pinned mermaid ESM runtime (entry + every lazily imported chunk, no source maps) into <outDir>/vendor/mermaid at the end of the build, so Jarvis loads diagrams same-origin from /dist/vendor/mermaid instead of a floating jsDelivr import. The Dockerfile's existing `npm run build:chat` runs it before devDependencies are pruned.
 */

import { defineConfig, type Plugin } from 'vite';
import fs from 'fs';
import path from 'path';

const OUT_DIR = path.resolve(__dirname, 'src/api/dist');
const MERMAID_DIST = path.resolve(__dirname, 'node_modules/mermaid/dist');
const MERMAID_ENTRY = 'mermaid.esm.min.mjs';
const MERMAID_CHUNKS = path.join('chunks', 'mermaid.esm.min');

/**
 * @description Copy the installed (package-lock pinned) mermaid ESM runtime into
 * `<outDir>/vendor/mermaid`: the entry module plus every `.mjs` chunk it can import, and a
 * VERSION file naming the exact package version. The target directory is rebuilt from scratch so
 * a version bump never leaves stale chunks behind. Throws when the entry or chunk directory is
 * missing, so a broken install fails the build instead of shipping a Jarvis without diagrams.
 * @param outDir - The vite output directory (served at /dist).
 * @param sourceDir - The mermaid package's `dist` directory.
 * @returns The copied file count and the vendored version.
 */
export function vendorMermaidRuntime(
  outDir: string = OUT_DIR,
  sourceDir: string = MERMAID_DIST,
): { files: number; version: string } {
  const target = path.join(outDir, 'vendor', 'mermaid');
  const chunkSource = path.join(sourceDir, MERMAID_CHUNKS);
  if (!fs.existsSync(path.join(sourceDir, MERMAID_ENTRY)) || !fs.existsSync(chunkSource)) {
    throw new Error(`mermaid runtime not found under ${sourceDir}; run npm ci before the build`);
  }
  const version = String(
    (JSON.parse(fs.readFileSync(path.join(sourceDir, '..', 'package.json'), 'utf8')) as { version?: unknown }).version,
  );
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.join(target, MERMAID_CHUNKS), { recursive: true });
  fs.copyFileSync(path.join(sourceDir, MERMAID_ENTRY), path.join(target, MERMAID_ENTRY));
  let files = 1;
  for (const name of fs.readdirSync(chunkSource)) {
    if (!name.endsWith('.mjs')) continue;
    fs.copyFileSync(path.join(chunkSource, name), path.join(target, MERMAID_CHUNKS, name));
    files += 1;
  }
  fs.writeFileSync(path.join(target, 'VERSION'), `${version}\n`);
  return { files, version };
}

/** Build hook: vendor mermaid once the browser bundles are written. */
function vendorMermaidPlugin(): Plugin {
  return {
    name: 'oshal-vendor-mermaid',
    apply: 'build',
    closeBundle() {
      vendorMermaidRuntime();
    },
  };
}

export default defineConfig({
  plugins: [vendorMermaidPlugin()],
  build: {
    outDir: OUT_DIR,
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
