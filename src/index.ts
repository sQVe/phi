import { runCli } from './cli/cli.ts';

// oxlint-disable-next-line node/no-process-env -- the command line is where the environment enters.
process.exitCode = await runCli(Bun.argv.slice(2), process.env);
