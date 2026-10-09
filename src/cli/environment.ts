import { resolve } from 'node:path';

import { invariant } from '../invariant.ts';
import { socketPathFor } from '../server/server.ts';

export type Environment = Record<string, string | undefined>;

export const resolveSocketPath = (
  requested: string | undefined,
  environment: Environment,
): string => {
  const userId = process.getuid?.();

  invariant(userId !== undefined, 'The platform has no user ids.');

  return resolve(socketPathFor(requested, environment.XDG_RUNTIME_DIR, userId));
};
