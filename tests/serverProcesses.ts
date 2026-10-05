import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const commandLineOf = (processId: string): string | undefined => {
  try {
    return readFileSync(join('/proc', processId, 'cmdline'), 'utf8').replaceAll('\0', ' ');
  } catch {
    return undefined;
  }
};

// Finds servers by the socket path on their command line, so a test can find its own servers
// before it reads their pids.
export const serverProcessesIn = (directory: string): number[] =>
  readdirSync('/proc')
    .filter((name) => {
      const commandLine = commandLineOf(name);

      return commandLine?.includes(`server run --socket ${directory}/`) === true;
    })
    .map(Number);

export const isRunning = (processId: number): boolean => {
  try {
    process.kill(processId, 0);

    return true;
  } catch {
    return false;
  }
};

export const waitFor = async (condition: () => boolean, timeoutMs = 10_000): Promise<boolean> => {
  const deadline = performance.now() + timeoutMs;

  while (!condition()) {
    if (performance.now() > deadline) {
      return false;
    }

    await Bun.sleep(20);
  }

  return true;
};

// Ends every server with a socket in the directory and waits for it to exit, since a stopping server
// still writes its log after it removes the socket.
export const endServersIn = async (directory: string): Promise<void> => {
  const servers = serverProcessesIn(directory);

  for (const server of servers) {
    process.kill(server, 'SIGTERM');
  }

  const ended = await waitFor(() => servers.every((server) => !isRunning(server)));

  if (ended) {
    return;
  }

  for (const server of servers.filter((candidate) => isRunning(candidate))) {
    process.kill(server, 'SIGKILL');
  }
};
