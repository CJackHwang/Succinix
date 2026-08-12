// invariant: zero-dependency StandardSchema V1 helpers.
import type { StandardSchemaV1 } from '@standard-schema/spec';

export type Issue = StandardSchemaV1.Issue;
export type Schema<T> = StandardSchemaV1<unknown, T>;

export interface ObjectField {
  optional?: boolean;
  validate?: (value: unknown) => string | null;
}

type ObjectShape = Record<string, ObjectField | undefined>;

type IssuePathSegment = string | number | symbol | { key: PropertyKey };

function pathName(path: readonly IssuePathSegment[]): string {
  return path.length
    ? path.map((part) => (typeof part === 'object' && part !== null ? String(part.key) : String(part))).join('.')
    : '(root)';
}

export function objectSchema<T extends Record<string, unknown>>(
  shape: ObjectShape,
  options: { allowUnknown?: boolean } = {}
): Schema<T> {
  const allowUnknown = options.allowUnknown ?? false;
  return {
    '~standard': {
      version: 1,
      vendor: 'succinix',
      validate(value: unknown): StandardSchemaV1.Result<T> {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          return { issues: [{ message: 'expected an object', path: [] }] };
        }
        const record = value as Record<string, unknown>;
        const issues: Issue[] = [];
        for (const [key, field] of Object.entries(shape)) {
          const raw = record[key];
          if (raw === undefined) {
            if (!field?.optional) issues.push({ message: `missing required field: ${key}`, path: [key] });
            continue;
          }
          const error = field?.validate?.(raw);
          if (error) issues.push({ message: error, path: [key] });
        }
        if (!allowUnknown) {
          for (const key of Object.keys(record)) {
            if (!(key in shape)) issues.push({ message: `unknown field: ${key}`, path: [key] });
          }
        }
        if (issues.length) return { issues };
        return { value: record as T };
      },
    },
  };
}

export function optional(validate?: (value: unknown) => string | null): ObjectField {
  return { optional: true, validate };
}

export function required(validate?: (value: unknown) => string | null): ObjectField {
  return { optional: false, validate };
}

export function isString(value: unknown, name: string): string | null {
  return typeof value === 'string' ? null : `${name} must be a string`;
}

export function isNumber(value: unknown, name: string): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? null : `${name} must be a finite number`;
}

export function isBoolean(value: unknown, name: string): string | null {
  return typeof value === 'boolean' ? null : `${name} must be a boolean`;
}

export function isIntegerRange(value: unknown, name: string, min: number, max: number): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    return `${name} must be an integer between ${min} and ${max}`;
  }
  return null;
}

export function isArrayOf(validate: (value: unknown, name: string) => string | null, name: string) {
  return (value: unknown): string | null => {
    if (!Array.isArray(value)) return `${name} must be an array`;
    for (const item of value) {
      const error = validate(item, `${name}[]`);
      if (error) return error;
    }
    return null;
  };
}

export function isEnum(values: readonly string[], name: string) {
  return (value: unknown): string | null => {
    if (typeof value !== 'string' || !values.includes(value)) {
      return `${name} must be one of: ${values.join(', ')}`;
    }
    return null;
  };
}

export function checkSync<T>(schema: Schema<T>, value: unknown): { value: T } | { value: unknown; issues: Issue[] } {
  const result = schema['~standard'].validate(value) as { then?: unknown; value?: T; issues?: Issue[] };
  if (result && typeof result === 'object' && 'then' in result) {
    throw new TypeError('Async config validation is not supported');
  }
  if (result.issues && result.issues.length > 0) return { value, issues: result.issues };
  return { value: result.value ?? (value as T) };
}

export function pathOf(issue: Issue): string {
  return pathName(issue.path ?? []);
}
