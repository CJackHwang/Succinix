// invariant: plugin shell assertions (DSH J6).

export class InvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvariantError';
  }
}

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InvariantError(message);
}

export function invariantString(value: unknown, name: string): asserts value is string {
  invariant(typeof value === 'string' && value.length > 0, `${name} must be a non-empty string`);
}

export function invariantNumber(value: unknown, name: string): asserts value is number {
  invariant(typeof value === 'number' && Number.isFinite(value), `${name} must be a finite number`);
}

export function invariantObject(value: unknown, name: string): asserts value is Record<string, unknown> {
  invariant(value !== null && typeof value === 'object' && !Array.isArray(value), `${name} must be an object`);
}
