// The Kafka message format shared with the API (see the Phase 2 spec).
//
// Key:   deviceId (so one device's readings always land on one partition, in order)
// Value: JSON { deviceId, intervalStart, vehicles, receivedAt }

export interface Reading {
  deviceId: string;
  intervalStart: Date;
  vehicles: number;
}

export interface ParsedMessage extends Reading {
  /** When the API accepted the reading; used to measure end-to-end delay. */
  receivedAt: Date;
}

/**
 * Parses one message value. The API already validated it, so this is only a
 * safety net against corrupted or foreign messages: returns null instead of
 * throwing, so one bad message can't stop the consumer.
 */
export function parseMessage(value: Buffer | null | undefined): ParsedMessage | null {
  if (!value) return null;
  let v: unknown;
  try {
    v = JSON.parse(value.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null) return null;
  const { deviceId, intervalStart, vehicles, receivedAt } = v as Record<string, unknown>;
  if (typeof deviceId !== 'string' || typeof intervalStart !== 'string' || typeof receivedAt !== 'string') return null;
  if (typeof vehicles !== 'number' || !Number.isInteger(vehicles) || vehicles < 0) return null;
  const start = new Date(intervalStart);
  const received = new Date(receivedAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(received.getTime())) return null;
  return { deviceId, intervalStart: start, vehicles, receivedAt: received };
}
