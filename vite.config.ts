import { format, lint } from '@sqve/seam';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  lint: {
    extends: [lint],
    jsPlugins: ['./scripts/phiPlugin.ts'],
    rules: {
      'phi/module-boundaries': 'error',
      'eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '(^|[/@])node-pty([-/]|$)',
              message: 'Spawn pane processes with `Bun.spawn` and its `terminal` option.',
            },
          ],
        },
      ],
    },
  },
  fmt: {
    ...format,
    // Local agent state is not source and must not be reformatted.
    ignorePatterns: ['bun.lock', '.tau/**'],
  },
  staged: {
    '*.{ts,tsx,js,jsx,mjs,cjs}': [
      'bunx --bun seam',
      'bunx --bun vp fmt --check --no-error-on-unmatched-pattern',
    ],
    '*.{json,md,yaml,yml,css}': 'bunx --bun vp fmt --check --no-error-on-unmatched-pattern',
  },
});
