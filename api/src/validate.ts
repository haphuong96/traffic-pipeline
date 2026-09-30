// Validation for POST /readings.
//
// Rule: if any reading in the batch is invalid, the whole batch is rejected
// with 400. That keeps the contract simple for devices: a batch is either
// fully stored or not stored at all, never "half".

export const MAX_BATCH = 500;
export const CLOCK_SKEW_MS = 5_000;
// Postgres `int` is 32-bit signed. A bigger value would fail in the database,
// which would return 500, which would make the device retry forever.
const MAX_INT = 2 ** 31 - 1;

// Strict UTC-only ISO 8601: "2026-09-30T11:00:45Z" with optional fraction.
// Offsets such as "+02:00" are rejected on purpose: devices must speak UTC.
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export interface Reading {
  deviceId: string;
  intervalStart: Date;
  vehicles: number;
}

export type ValidationResult =
  | { ok: true; readings: Reading[] }
  | { ok: false; error: { index: number | null; reason: string } };

/**
 * @param body     parsed JSON request body (anything)
 * @param devices  deviceId -> interval_seconds, loaded once at startup
 * @param now      current time in ms (injectable so tests are deterministic)
 */
export function validateBatch(body: unknown, devices: Map<string, number>, now = Date.now()): ValidationResult {
  if (!Array.isArray(body)) {
    return fail(null, 'body must be a JSON array of readings');
  }
  if (body.length < 1 || body.length > MAX_BATCH) {
    return fail(null, `batch must contain 1-${MAX_BATCH} readings, got ${body.length}`);
  }

  const readings: Reading[] = [];
  for (let i = 0; i < body.length; i++) {
    const result = validateOne(body[i], devices, now);
    if (typeof result === 'string') return fail(i, result);
    readings.push(result);
  }
  return { ok: true, readings };
}

/** Returns the parsed reading, or a string describing what is wrong. */
function validateOne(item: unknown, devices: Map<string, number>, now: number): Reading | string {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    return 'reading must be an object';
  }
  const { deviceId, intervalStart, intervalSeconds, vehicles } = item as Record<string, unknown>;

  if (typeof deviceId !== 'string') return 'deviceId must be a string';
  const expectedInterval = devices.get(deviceId);
  if (expectedInterval === undefined) return `unknown deviceId "${deviceId}"`;

  if (intervalSeconds !== expectedInterval) {
    return `intervalSeconds must be ${expectedInterval} for ${deviceId}, got ${JSON.stringify(intervalSeconds)}`;
  }

  if (typeof intervalStart !== 'string' || !ISO_UTC.test(intervalStart)) {
    return 'intervalStart must be an ISO 8601 UTC timestamp like "2026-09-30T11:00:45Z"';
  }
  const ms = Date.parse(intervalStart);
  // Date.parse happily rolls "2026-02-30" over to March 2nd. Round-tripping
  // the date part catches impossible calendar dates.
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== intervalStart.slice(0, 10)) {
    return 'intervalStart must be an ISO 8601 UTC timestamp like "2026-09-30T11:00:45Z" (invalid date)';
  }
  // The Unix epoch starts on a whole minute, so "aligned to the interval" is
  // simply "milliseconds since epoch is a multiple of the interval length".
  // This covers both rules: :00/:15/:30/:45 for 15 s devices, :00 for 60 s.
  if (ms % (expectedInterval * 1000) !== 0) {
    return `intervalStart ${intervalStart} is not aligned to a ${expectedInterval}s boundary`;
  }
  if (ms > now + CLOCK_SKEW_MS) {
    return `intervalStart ${intervalStart} is in the future`;
  }

  if (typeof vehicles !== 'number' || !Number.isInteger(vehicles) || vehicles < 0 || vehicles > MAX_INT) {
    return `vehicles must be a non-negative integer, got ${JSON.stringify(vehicles)}`;
  }

  return { deviceId, intervalStart: new Date(ms), vehicles };
}

function fail(index: number | null, reason: string): ValidationResult {
  return { ok: false, error: { index, reason } };
}
