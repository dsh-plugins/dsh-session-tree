import { defineConfig } from 'tsdown';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';

export default defineConfig({
  entry: { client: './src/client/index.tsx' },
  outDir: './lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  plugins: [{
    name: 'session-tree-style',
    resolveId(source, importer) {
      if (source.endsWith('.css') && importer) {
        return `\0style-text:${resolve(dirname(importer), source)}.js`;
      }
    },
    async load(id) {
      if (id.startsWith('\0style-text:')) {
        return { code: `export default ${JSON.stringify(await readFile(id.slice(12, -3), 'utf8'))};`, moduleType: 'js' };
      }
    },
  }],
  external: ['react', 'react-dom', 'react/jsx-runtime', '@dsh-plugin/dsh-loader/client'],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "@dsh-plugin/dsh-session-tree", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
});
