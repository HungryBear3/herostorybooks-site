/**
 * A fixture `process.env` carrying ONLY the variables a test names.
 *
 * Next declares `NODE_ENV` as a required member of `NodeJS.ProcessEnv`, so an
 * object literal without one is not a ProcessEnv: the `as NodeJS.ProcessEnv`
 * casts this replaces were asserting a shape the fixture did not have, and the
 * compiler said so. The mode defaults to the runner's own rather than to a
 * constant, so no fixture silently acquires a development or production branch
 * it never asked for; tests that care pass their own.
 */
export function processEnv(
  values: Readonly<Record<string, string | undefined>> = {},
  nodeEnv: NodeJS.ProcessEnv['NODE_ENV'] = process.env.NODE_ENV ?? 'test',
): NodeJS.ProcessEnv {
  return { ...values, NODE_ENV: nodeEnv };
}
