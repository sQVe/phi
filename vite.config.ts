import { format, lint, react } from '@sqve/seam';
import { defineConfig } from 'vite-plus';

const effectsMessage = 'Read state with `useSyncExternalStore` and send intents.';

export default defineConfig({
  lint: {
    extends: [lint, react],
    jsPlugins: ['./scripts/phiPlugin.ts'],
    rules: {
      'phi/module-boundaries': 'error',
      'eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(@[^/]+/)?node-pty([-/]|$)',
              message: 'Spawn pane processes with `Bun.spawn` and its `terminal` option.',
            },
          ],
          paths: [
            {
              name: 'react',
              // A default import would let `alias.useEffect` pass the property check below.
              importNames: ['default', 'useEffect', 'useLayoutEffect'],
              message: `${effectsMessage} Import other React hooks by name.`,
            },
          ],
        },
      ],
      'eslint/no-restricted-properties': [
        'error',
        { object: 'React', property: 'useEffect', message: effectsMessage },
        { object: 'React', property: 'useLayoutEffect', message: effectsMessage },
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
