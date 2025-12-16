/**
 * Configuration merging utilities
 *
 * Provides deep merge functionality for configuration inheritance.
 * Arrays are replaced (not merged) to allow clean overrides.
 */

import { mergeWith, isPlainObject } from 'lodash-es';

/**
 * Custom merge function that replaces arrays instead of merging them
 */
function customMerge(objValue: unknown, srcValue: unknown): unknown {
  // Replace arrays instead of merging
  if (Array.isArray(objValue)) {
    return srcValue;
  }
  // Let lodash handle the rest
  return undefined;
}

/**
 * Deep merge multiple objects, with later objects taking precedence
 * Arrays are replaced, not concatenated
 */
export function deepMerge<T>(...objects: Partial<T>[]): T {
  return mergeWith({}, ...objects, customMerge) as T;
}

/**
 * Merge a base config with overrides
 */
export function mergeConfig<T extends object>(base: T, overrides: Partial<T>): T {
  return deepMerge<T>(base, overrides);
}

/**
 * Check if a value is a plain object (not an array, null, etc.)
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value);
}

/**
 * Get a nested value from an object using dot notation
 * @example getValue(obj, 'a.b.c') => obj.a.b.c
 */
export function getValue<T = unknown>(obj: object, path: string): T | undefined {
  const keys = path.split('.');
  let current: unknown = obj;

  for (const key of keys) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return current as T;
}

/**
 * Set a nested value in an object using dot notation
 * Creates intermediate objects as needed
 * @example setValue(obj, 'a.b.c', value) => obj.a.b.c = value
 */
export function setValue<T extends object>(obj: T, path: string, value: unknown): T {
  const keys = path.split('.');
  let current: Record<string, unknown> = obj as Record<string, unknown>;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!(key in current) || !isObject(current[key])) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }

  current[keys[keys.length - 1]] = value;
  return obj;
}

/**
 * Remove undefined values from an object (shallow)
 */
export function removeUndefined<T extends object>(obj: T): T {
  const result = { ...obj };
  for (const key of Object.keys(result)) {
    if ((result as Record<string, unknown>)[key] === undefined) {
      delete (result as Record<string, unknown>)[key];
    }
  }
  return result;
}

/**
 * Deep remove undefined values from an object
 */
export function deepRemoveUndefined<T>(obj: T): T {
  if (!isObject(obj)) {
    return obj;
  }

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) {
      continue;
    }
    if (isObject(value)) {
      result[key] = deepRemoveUndefined(value);
    } else if (Array.isArray(value)) {
      result[key] = value.map(deepRemoveUndefined);
    } else {
      result[key] = value;
    }
  }

  return result as T;
}
