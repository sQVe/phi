import { dlopen, FFIType, read } from 'bun:ffi';

import { invariant } from '../invariant.ts';

type FlockResult = { kind: 'locked' } | { kind: 'held' } | { kind: 'failed'; errno: number };

// The glibc name, which Linux distributions with glibc share.
const libcName = 'libc.so.6';

// LOCK_EX and LOCK_NB.
const exclusiveFlag = 2;

const nonBlockingFlag = 4;

// EWOULDBLOCK on Linux: another open file holds the lock.
const wouldBlock = 11;

const loadLibc = () =>
  dlopen(libcName, {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    __errno_location: { args: [], returns: FFIType.ptr },
  }).symbols;

let libc: ReturnType<typeof loadLibc> | undefined;

// Takes an exclusive flock on the file without waiting. The kernel releases it when the file is
// closed or the process exits.
export const lockExclusive = (fileDescriptor: number): FlockResult => {
  libc ??= loadLibc();

  if (libc.flock(fileDescriptor, exclusiveFlag | nonBlockingFlag) === 0) {
    return { kind: 'locked' };
  }

  // oxlint-disable-next-line eslint/no-underscore-dangle -- glibc names the symbol.
  const errnoPointer = libc.__errno_location();

  invariant(errnoPointer !== null, 'libc returned no errno location.');

  const errno = read.i32(errnoPointer, 0);

  if (errno === wouldBlock) {
    return { kind: 'held' };
  }

  return { kind: 'failed', errno };
};
