export type Outcome = { ok: true } | { ok: false; message: string };

interface VersionOutput {
  version: string;
  ghostty: string;
}

interface ServerRunOutput {
  socket: string;
  pid: number;
}

interface ServerStopOutput {
  stopped: true;
}

interface PaneReadOutput {
  pane: string;
  rows: string[];
}

export interface PaneSendOutput {
  sent: true;
}

type CommandJson = VersionOutput | ServerRunOutput | ServerStopOutput | PaneReadOutput;

// The JSON value is a public surface that agents parse.
export interface Output<Json> {
  json: Json;
  text: string;
}

export const print = <Json extends CommandJson>(json: boolean, output: Output<Json>): void => {
  const line = json ? JSON.stringify(output.json) : output.text;

  process.stdout.write(`${line}\n`);
};

export const printJson = (output: PaneSendOutput): void => {
  process.stdout.write(`${JSON.stringify(output)}\n`);
};
