import { defineConfig } from 'tsup';

export default defineConfig({
  // 1. Entry points: index for the lib, bin for the CLI
  entry: {
    index: 'src/index.ts',
    react: 'src/react/index.ts',
    grpc: 'src/Client/grpc.ts'
  },
  // entry: ['src/index.ts', 'src/react.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  splitting: true,
  sourcemap: false,
  clean: false,
  minify: true,
  treeshake: true,
  external: ['react', 'react-dom'],
  // Shims handles __dirname and __filename in ESM
  shims: true,
  // Ensures the bin file has the #!/usr/bin/env node header
  banner: ({ format }) => {
    if (format === 'cjs') return { js: '/* ZuzFlare Client */' };
    return {};
  },
  onSuccess: async () => {
    console.log('✅ Zuz Flare Client Build Complete');
  }
});