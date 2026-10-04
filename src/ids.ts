export type PaneId = `pane-${number}` & { readonly brand: 'PaneId' };
export type ClientId = `client-${number}` & { readonly brand: 'ClientId' };

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: the brand exists only in the type.
export const paneId = (number: number): PaneId => `pane-${number}` as PaneId;

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: the brand exists only in the type.
export const clientId = (number: number): ClientId => `client-${number}` as ClientId;
