import { parseArgs } from 'node:util';

import packageJson from '../package.json' with { type: 'json' };
import type { BuildVersion } from './protocol/protocol.ts';
import { createTerminal, ghosttyCommit } from './vt/vt.ts';

type VersionsResult = { ok: true; versions: BuildVersion } | { ok: false; message: string };

const usage = 'Usage: phi --version [--json]';

const statusQuery = new TextEncoder().encode('\u001B[5n');

const statusReply = '\u001B[0n';

const probeColumns = 80;

const probeRows = 24;

const probeScrollbackBytes = 0;

// Loads the terminal library and parses a query with it, so the versions printed are the ones that
// work in this binary.
const readVersions = (): VersionsResult => {
  const created = createTerminal(probeColumns, probeRows, probeScrollbackBytes);

  if (!created.ok) {
    const detail = created.reason === 'library-missing' ? `: ${created.detail}` : '';

    return {
      ok: false,
      message: `phi: cannot load the terminal library (${created.reason})${detail}`,
    };
  }

  using terminal = created.terminal;
  const reply = terminal.write(statusQuery);
  const replyText = reply === undefined ? '' : new TextDecoder().decode(reply);

  if (replyText !== statusReply) {
    return { ok: false, message: 'phi: the terminal library did not answer a status query.' };
  }

  const commit = ghosttyCommit();

  if (!commit.ok) {
    return { ok: false, message: `phi: cannot load the terminal library: ${commit.detail}` };
  }

  return { ok: true, versions: { version: packageJson.version, ghostty: commit.commit } };
};

const parseArguments = () => {
  try {
    const { values } = parseArgs({
      args: Bun.argv.slice(2),
      options: { version: { type: 'boolean' }, json: { type: 'boolean' } },
      strict: true,
    });

    return values;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const main = (): number => {
  const options = parseArguments();

  if (typeof options === 'string') {
    process.stderr.write(`phi: ${options}\n${usage}\n`);

    return 2;
  }

  if (options.version !== true) {
    process.stderr.write(`${usage}\n`);

    return 2;
  }

  const result = readVersions();

  if (!result.ok) {
    process.stderr.write(`${result.message}\n`);

    return 1;
  }

  const { version, ghostty } = result.versions;

  const output =
    options.json === true
      ? JSON.stringify({ version, ghostty })
      : `phi ${version} (ghostty ${ghostty})`;

  process.stdout.write(`${output}\n`);

  return 0;
};

process.exitCode = main();
