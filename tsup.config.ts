import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'tsup';

const publicAssets = ['index.html', 'app.webmanifest', 'icon.svg', 'sw.js'];

export default defineConfig([
  {
    entry: ['src/cli.ts'],
    format: ['esm'],
    target: 'node22',
    clean: true,
    banner: { js: '#!/usr/bin/env node' },
    async onSuccess() {
      const destDir = join('dist', 'public');
      if (!existsSync(destDir)) {
        mkdirSync(destDir, { recursive: true });
      }

      for (const file of publicAssets) {
        const src = join('public', file);
        if (existsSync(src)) {
          copyFileSync(src, join(destDir, file));
        }
      }
    },
  },
  {
    entry: {
      'public/web-app': 'src/web-app.ts',
    },
    format: ['esm'],
    target: 'es2022',
    platform: 'browser',
    outDir: 'dist',
    clean: false,
    dts: false,
    minify: false,
  },
]);
