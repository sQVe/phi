import { runAttachCommand } from './attachCommand.ts';
import type { Environment } from './environment.ts';
import { print } from './output.ts';
import { runPaneAction } from './paneCommands.ts';
import { parseCommand, usage } from './parse.ts';
import { runServerAction } from './serverCommands.ts';
import { readVersions } from './versions.ts';

const writeError = (message: string, suffix = ''): void => {
  process.stderr.write(`phi: ${message}${suffix}\n`);
};

// Returns the exit code: 0 on success, 1 on failure, and 2 on bad arguments.
export const runCli = async (argv: string[], environment: Environment): Promise<number> => {
  const command = parseCommand(argv);

  if (typeof command === 'string') {
    writeError(command, `\n${usage}`);

    return 2;
  }

  const result = readVersions();

  if (!result.ok) {
    writeError(result.message);

    return 1;
  }

  if (command.kind === 'version') {
    const { version, ghostty } = result.versions;

    print(command.json, {
      json: { version, ghostty },
      text: `phi ${version} (ghostty ${ghostty})`,
    });

    return 0;
  }

  if (command.kind === 'attach') {
    const outcome = await runAttachCommand(command, result.versions, environment);

    if (!outcome.ok) {
      writeError(outcome.message);

      return 1;
    }

    return 0;
  }

  const outcome =
    command.kind === 'pane'
      ? await runPaneAction(command, result.versions, environment)
      : await runServerAction(command, result.versions, environment);

  if (!outcome.ok) {
    writeError(outcome.message);

    return 1;
  }

  return 0;
};
