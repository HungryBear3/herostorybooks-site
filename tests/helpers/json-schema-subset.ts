/**
 * A small, strict JSON Schema evaluator for the keywords HSB's generated
 * export schema uses: $ref/$defs (local), type, enum, const, pattern,
 * minLength/maxLength, minimum/maximum, properties/required,
 * additionalProperties, items, minItems/maxItems. Any other keyword is an
 * error, so a schema cannot silently rely on something this does not check.
 */
type Schema = Record<string, unknown>;

const SUPPORTED = new Set([
  '$schema', '$id', 'title', 'description', '$defs', '$ref', 'type', 'enum', 'const', 'pattern',
  'minLength', 'maxLength', 'minimum', 'maximum', 'properties', 'required', 'additionalProperties',
  'items', 'minItems', 'maxItems',
]);

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  return actual === type || (type === 'number' && actual === 'integer');
}

export function validateJsonSchemaSubset(root: Schema, instance: unknown): string[] {
  const issues: string[] = [];
  const resolve = (schema: Schema): Schema => {
    if (typeof schema.$ref !== 'string') return schema;
    const match = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(schema.$ref);
    const defs = root.$defs as Record<string, Schema> | undefined;
    if (!match || !defs?.[match[1]]) throw new Error(`unsupported $ref ${schema.$ref}`);
    return resolve(defs[match[1]]);
  };
  const visit = (raw: Schema, value: unknown, path: string) => {
    const schema = resolve(raw);
    for (const key of Object.keys(schema)) {
      if (!SUPPORTED.has(key)) throw new Error(`unsupported keyword ${key} at ${path}`);
    }
    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type as string[] : [schema.type as string];
      if (!types.some((type) => matchesType(value, type))) { issues.push(`type@${path}`); return; }
    }
    if (schema.const !== undefined && value !== schema.const) issues.push(`const@${path}`);
    if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) issues.push(`enum@${path}`);
    if (typeof value === 'string') {
      if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) issues.push(`pattern@${path}`);
      if (typeof schema.minLength === 'number' && value.length < schema.minLength) issues.push(`minLength@${path}`);
      if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) issues.push(`maxLength@${path}`);
    }
    if (typeof value === 'number') {
      if (typeof schema.minimum === 'number' && value < schema.minimum) issues.push(`minimum@${path}`);
      if (typeof schema.maximum === 'number' && value > schema.maximum) issues.push(`maximum@${path}`);
    }
    if (Array.isArray(value)) {
      if (typeof schema.minItems === 'number' && value.length < schema.minItems) issues.push(`minItems@${path}`);
      if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) issues.push(`maxItems@${path}`);
      if (schema.items) value.forEach((item, index) => visit(schema.items as Schema, item, `${path}[${index}]`));
    }
    if (typeOf(value) === 'object') {
      const record = value as Record<string, unknown>;
      const properties = (schema.properties ?? {}) as Record<string, Schema>;
      for (const key of (schema.required ?? []) as string[]) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) issues.push(`required@${path}`);
      }
      for (const [key, child] of Object.entries(record)) {
        if (Object.prototype.hasOwnProperty.call(properties, key)) visit(properties[key], child, `${path}.${key}`);
        else if (schema.additionalProperties === false) issues.push(`additionalProperties@${path}`);
        else if (typeof schema.additionalProperties === 'object') visit(schema.additionalProperties as Schema, child, `${path}.${key}`);
      }
    }
  };
  visit(root, instance, '$');
  return issues;
}
