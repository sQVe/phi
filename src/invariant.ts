// An assertion signature needs an explicit type annotation on an arrow function.
export const invariant: (condition: unknown, message: string) => asserts condition = (
  condition,
  message,
) => {
  const holds = Boolean(condition);

  if (!holds) {
    throw new Error(message);
  }
};
