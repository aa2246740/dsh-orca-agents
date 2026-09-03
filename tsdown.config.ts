import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: 'src/dsh-orca-agents.ts',
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: true,
  sourcemap: true,
  fixedExtension: false,
  deps: {
    neverBundle: (specifier: string) => specifier.startsWith('@deepseek-ai/'),
  },
})
