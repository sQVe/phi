export interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

const detachedSize: TerminalSize = { columns: 80, rows: 24 };
const statusBarRows = 1;

export const paneSize = (client: TerminalSize | undefined): TerminalSize => {
  if (client === undefined) {
    return detachedSize;
  }

  return {
    columns: Math.max(1, client.columns),
    rows: Math.max(1, client.rows - statusBarRows),
  };
};
