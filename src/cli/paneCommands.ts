import { runPaneCommand } from '../client/client.ts';
import type { BuildVersion } from '../protocol/protocol.ts';
import { resolveSocketPath } from './environment.ts';
import type { Environment } from './environment.ts';
import { print, printJson } from './output.ts';
import type { Outcome } from './output.ts';
import type { PaneCliCommand } from './parse.ts';

export const runPaneAction = async (
  command: PaneCliCommand,
  version: BuildVersion,
  environment: Environment,
): Promise<Outcome> => {
  const socketPath = resolveSocketPath(command.socket, environment);
  const result = await runPaneCommand(socketPath, version, command.pane);

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

    const messages = {
      noServer: `No server is listening on ${socketPath}.`,
      paneMissing: 'The pane is no longer running.',
      connectionFailed: `The server on ${socketPath} did not complete the pane command.`,
    };

    return { ok: false, message: messages[result.reason] };
  }

  if (result.kind === 'rows') {
    print(command.json, {
      json: { pane: result.paneId, rows: result.rows },
      text: result.rows.join('\n'),
    });
  } else if (command.json) {
    printJson({ sent: true });
  }

  return { ok: true };
};
