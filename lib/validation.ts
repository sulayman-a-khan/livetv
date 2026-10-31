/**
 * The shape every admin form's answer takes, and the small readers that turn a
 * payload into one.
 *
 * These live apart from the forms themselves because two unrelated tiers use them:
 * the premium tier's channel and provider forms, and the match cards the Direct
 * HLS panel writes. Nothing here knows what it is reading — only how.
 */

export interface Validation<T> {
  value: Partial<T>;
  errors: string[];
}

/** True when the URL is something a browser or a fetch can actually reach. */
export function isHttpUrl(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(url);
}

export function toBool(raw: unknown, fallback: boolean): boolean {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw === "boolean") return raw;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

/**
 * Whole numbers only, and never outside the range the admin form itself offers,
 * so a hand-crafted request cannot store a value the panel then cannot display.
 */
export function toIntInRange(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
  label: string,
  errors: string[]
): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    errors.push(`${label} must be a whole number between ${min} and ${max}`);
    return fallback;
  }
  return n;
}

/** A trimmed string, refused when it is longer than the field on screen. */
export function toText(
  raw: unknown,
  label: string,
  errors: string[],
  options: { required?: boolean; max: number; fallback?: string }
): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    if (options.required) errors.push(`${label} is required`);
    return options.fallback ?? "";
  }
  if (value.length > options.max) {
    errors.push(`${label} must be ${options.max} characters or fewer`);
    return "";
  }
  return value;
}

/** An optional URL field: empty is allowed, a non-empty value must be http(s). */
export function toOptionalUrl(raw: unknown, label: string, errors: string[]): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) return "";
  if (!isHttpUrl(value) || value.length > 2048) {
    errors.push(`${label} must be a valid http(s) URL`);
    return "";
  }
  return value;
}
