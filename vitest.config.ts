import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.toml' },
    miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations('./migrations') } },
  })],
  test: {
    include: ['src/**/*.test.ts'],
    coverage: {
      enabled: true,
      provider: 'istanbul',
      include: ['src/lib/crypto.ts', 'src/lib/tokens.ts'],
      reporter: ['text'],
      thresholds: { 100: true, perFile: true },
    },
  },
});
