import { readdirSync, readFileSync } from 'node:fs';

interface ProcessStat {
  group: number;
  session: number;
}

const numericName = /^\d+$/;

// Reads the process group and session from a /proc/<pid>/stat line. The command name sits in
// parentheses and may hold spaces and ')', so the fields start after the last ')'.
export const parseStat = (line: string): ProcessStat | undefined => {
  const nameEnd = line.lastIndexOf(')');

  if (nameEnd === -1) {
    return undefined;
  }

  // State, parent id, process group, session.
  const fields = line
    .slice(nameEnd + 1)
    .trim()
    .split(' ');

  const group = Number(fields[2]);
  const session = Number(fields[3]);

  if (!Number.isInteger(group) || !Number.isInteger(session)) {
    return undefined;
  }

  return { group, session };
};

const readStat = (processId: string): ProcessStat | undefined => {
  try {
    return parseStat(readFileSync(`/proc/${processId}/stat`, 'utf8'));
  } catch {
    // The process ended during the scan.
    return undefined;
  }
};

// Returns the process groups that have a process in the session. Linux only, since it reads /proc.
export const sessionGroups = (session: number): number[] => {
  const groups = new Set<number>();

  for (const name of readdirSync('/proc')) {
    if (!numericName.test(name)) {
      continue;
    }

    const stat = readStat(name);

    if (stat?.session === session) {
      groups.add(stat.group);
    }
  }

  return [...groups];
};
