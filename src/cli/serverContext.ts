import type { BuildVersion } from '../protocol/protocol.ts';
import type { Environment } from './environment.ts';

export interface ServerContext {
  json: boolean;
  socketPath: string;
  logPath: string;
  version: BuildVersion;
  environment: Environment;
}

const millisecondsPerSecond = 1000;

export const pollIntervalMs = 25;

export const seconds = (milliseconds: number): number => milliseconds / millisecondsPerSecond;

export const poll = async <Value>(
  attempt: () => Promise<Value | undefined> | Value | undefined,
  timeoutMs: number,
): Promise<Value | undefined> => {
  const deadline = performance.now() + timeoutMs;

  while (performance.now() < deadline) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each attempt must follow the last wait.
    const value = await attempt();

    if (value !== undefined) {
      return value;
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- each attempt must follow the last wait.
    await Bun.sleep(pollIntervalMs);
  }

  return undefined;
};
