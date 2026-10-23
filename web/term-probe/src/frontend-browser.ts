// Browser-safe subset of @tn3270/frontend. The real barrel re-exports tls.js (node:net,
// node:tls, node:fs), so the bundle maps the bare specifier '@tn3270/frontend' to this file.
export * from '../../vendor/tn3270/packages/frontend/src/palette.js';
export * from '../../vendor/tn3270/packages/frontend/src/actions.js';
export type { Action } from '../../vendor/tn3270/packages/frontend/src/actions.js';
