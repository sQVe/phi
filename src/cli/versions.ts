import packageJson from '../../package.json' with { type: 'json' };
import type { BuildVersion } from '../protocol/protocol.ts';
import { createTerminal, ghosttyCommit } from '../vt/vt.ts';

type VersionsResult = { ok: true; versions: BuildVersion } | { ok: false; message: string };

const statusQuery = new TextEncoder().encode('\u001B[5n');
const statusReply = '\u001B[0n';

const probeColumns = 80;
const probeRows = 24;
const probeScrollbackBytes = 0;

// Loads the terminal library and parses a query with it, so the versions printed are the ones that
// work in this binary.
export const readVersions = (): VersionsResult => {
  const created = createTerminal(probeColumns, probeRows, probeScrollbackBytes);

  if (!created.ok) {
    const detail = created.reason === 'library-missing' ? `: ${created.detail}` : '';

    return {
      ok: false,
      message: `cannot load the terminal library (${created.reason})${detail}`,
    };
  }

  using terminal = created.terminal;
  const reply = terminal.write(statusQuery);
  const replyText = reply === undefined ? '' : new TextDecoder().decode(reply);

  if (replyText !== statusReply) {
    return { ok: false, message: 'the terminal library did not answer a status query.' };
  }

  const commit = ghosttyCommit();

  if (!commit.ok) {
    return { ok: false, message: `cannot load the terminal library: ${commit.detail}` };
  }

  return { ok: true, versions: { version: packageJson.version, ghostty: commit.commit } };
};
