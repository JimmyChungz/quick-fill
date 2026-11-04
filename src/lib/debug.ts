// Legacy call sites deliberately discard unstructured arguments: they can
// include field labels, origins or identity names. Controlled capture tracing
// uses a separate finite event schema, and is off unless explicitly enabled.
export function debug(..._args: unknown[]): void {}
