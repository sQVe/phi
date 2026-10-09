import { parseArgs } from 'node:util';

import type { PaneCommand } from '../client/client.ts';

interface CommandOptions {
  json: boolean;
  socket: string | undefined;
}

interface VersionCommand {
  kind: 'version';
  json: boolean;
}

export interface PaneCliCommand extends CommandOptions {
  kind: 'pane';
  pane: PaneCommand;
}

export interface ServerCommand extends CommandOptions {
  kind: 'server';
  action: ServerAction;
}

export type Command = VersionCommand | PaneCliCommand | ServerCommand;

const serverActions = ['run', 'start', 'stop'] as const;

type ServerAction = (typeof serverActions)[number];

export const usage = `Usage:
  phi --version [--json]
  phi server run [--socket <path>] [--json]
  phi server start [--socket <path>] [--json]
  phi server stop [--socket <path>] [--json]
  phi pane read [--socket <path>] [--json]
  phi pane send <text> [--socket <path>] [--json]`;

const isServerAction = (action: string | undefined): action is ServerAction =>
  serverActions.some((serverAction) => serverAction === action);

const parsePaneCommand = (action: string | undefined, rest: string[]): PaneCommand | string => {
  if (action !== 'read' && action !== 'send') {
    return 'Unknown pane command.';
  }

  if (action === 'read' && rest.length === 0) {
    return { action };
  }

  if (action === 'send' && rest.length === 1) {
    return { action, text: rest[0] ?? '' };
  }

  return 'pane read takes no text; pane send takes one text argument.';
};

export const parseCommand = (argv: string[]): Command | string => {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: {
        version: { type: 'boolean' },
        json: { type: 'boolean' },
        socket: { type: 'string' },
      },
      allowPositionals: true,
      strict: true,
    });

    const json = values.json === true;
    const [group, action, ...rest] = positionals;

    if (values.version === true) {
      const hasExtra = positionals.length > 0 || values.socket !== undefined;

      return hasExtra ? '--version takes only --json.' : { kind: 'version', json };
    }

    if (group === 'pane') {
      const pane = parsePaneCommand(action, rest);

      if (typeof pane === 'string') {
        return pane;
      }

      return { kind: 'pane', pane, json, socket: values.socket };
    }

    if (group !== 'server' || !isServerAction(action)) {
      return 'Unknown command.';
    }

    if (rest.length > 0) {
      return `Unexpected argument '${rest.join(' ')}'.`;
    }

    return { kind: 'server', action, json, socket: values.socket };
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};
