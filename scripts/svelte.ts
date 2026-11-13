import type { Plugin } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { compile } from 'svelte/compiler';

// Compiles .svelte components for esbuild. Svelte strips `lang="ts"` types itself.
// Component styles are injected at runtime; shared styles stay in ui/style.css.
export const svelte: Plugin = {
  name: 'svelte',
  setup(build) {
    build.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
      const { js, warnings } = compile(await readFile(path, 'utf8'), {
        filename: path,
        generate: 'client',
        css: 'injected',
      });
      return {
        contents: js.code,
        loader: 'js',
        resolveDir: dirname(path),
        warnings: warnings.map((warning) => ({
          text: warning.message,
          location: warning.start && { file: path, line: warning.start.line, column: warning.start.column },
        })),
      };
    });
  },
};
