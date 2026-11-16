import { defineConfig } from 'vitest/config';
import path from 'path';

const targetAppDir = process.env.TARGET_APP_DIR
  ? path.resolve(process.env.TARGET_APP_DIR)
  : path.resolve(__dirname, '../../ARCH PROJECT copy');

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      '@target': targetAppDir,
    },
  },
});
