import { transform, type Plugin } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { compile, compileModule } from 'svelte/compiler';

// Compiles .svelte components and .svelte.ts state modules for esbuild. Svelte strips
// `lang="ts"` types in components itself; state modules are stripped by esbuild first.
// Component styles are injected at runtime; shared styles stay in ui/style.css.
export const svelte: Plugin = {
  name: 'svelte',
  setup(build) {
    // Svelte packages such as @iris/svelte-ui export their components under the "svelte" condition.
    build.initialOptions.conditions = [...(build.initialOptions.conditions ?? []), 'svelte'];
    build.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
      const { code } = await transform(await readFile(path, 'utf8'), { loader: 'ts', sourcefile: path });
      const { js } = compileModule(code, { filename: path, generate: 'client' });
      return { contents: js.code, loader: 'js', resolveDir: dirname(path) };
    });
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
