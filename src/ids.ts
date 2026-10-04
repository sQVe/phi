export type PaneId = `pane-${number}` & { readonly brand: 'PaneId' };
export type ClientId = `client-${number}` & { readonly brand: 'ClientId' };

// SAFETY: this constructor is the only place that makes a PaneId.
// eslint-disable-next-line typescript/no-unsafe-type-assertion -- A brand exists only through this cast.
export const paneId = (number: number): PaneId => `pane-${number}` as PaneId;

// SAFETY: this constructor is the only place that makes a ClientId.
// eslint-disable-next-line typescript/no-unsafe-type-assertion -- A brand exists only through this cast.
export const clientId = (number: number): ClientId => `client-${number}` as ClientId;
