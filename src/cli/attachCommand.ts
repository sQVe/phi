import { connectAttach } from '../client/client.ts';
import type { BuildVersion } from '../protocol/protocol.ts';
import { resolveSocketPath } from './environment.ts';
import type { Environment } from './environment.ts';
import type { Outcome } from './output.ts';
import type { AttachCommand } from './parse.ts';

const defaultColumns = 80;

const defaultRows = 24;

export const runAttachCommand = async (
  command: AttachCommand,
  version: BuildVersion,
  environment: Environment,
): Promise<Outcome> => {
  const socketPath = resolveSocketPath(command.socket, environment);

  const size = {
    columns: process.stdout.columns || defaultColumns,
    rows: process.stdout.rows || defaultRows,
  };

  const result = await connectAttach(socketPath, version, size);

  if (!result.ok) {
    if (result.reason === 'refused') {
      const { client, server } = result;

      return {
        ok: false,
        message:
          `CLI ${client.version} (ghostty ${client.ghostty}) cannot connect to server ` +
          `${server.version} (ghostty ${server.ghostty}). Run phi server stop followed by phi ` +
          'to restart the server. This ends every pane.',
      };
    }

    const message =
      result.reason === 'noServer'
        ? `No server is listening on ${socketPath}.`
        : `The server on ${socketPath} did not complete the attach handshake.`;

    return { ok: false, message };
  }

  try {
    const { runAttach } = await import('../ui/ui.tsx');

    const reason = await runAttach(result.session);

    if (reason === 'connectionFailed') {
      return { ok: false, message: `The connection to the server on ${socketPath} failed.` };
    }
  } finally {
    result.session.close();
  }

  return { ok: true };
};
