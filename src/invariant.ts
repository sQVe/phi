// TypeScript only narrows at a call when the function's name has an explicit type (TS2775), so
// the type sits on the const instead of on the arrow.
export const invariant: (condition: unknown, message: string) => asserts condition = (
  condition,
  message,
) => {
  const holds = Boolean(condition);

  if (!holds) {
    throw new Error(message);
  }
};
