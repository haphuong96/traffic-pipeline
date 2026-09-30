// A simple, believable traffic model:
//   vehicles = base rate × time-of-day factor, scaled to the interval, plus noise.

/** A bell curve centred on `center` hours with width `width` hours; 1 at the centre. */
const bump = (hour: number, center: number, width: number) => Math.exp(-0.5 * ((hour - center) / width) ** 2);

/**
 * Traffic intensity for a given hour of day (0-24, fractional), roughly 0-1:
 * a low overnight floor, a broad daytime level, and two rush-hour peaks
 * (07:30-09:00 and 17:00-18:30).
 */
export function timeOfDayFactor(hour: number): number {
  return (
    0.05 + // overnight floor: a few vehicles even at 3 am
    0.35 * bump(hour, 13, 4) + // daytime
    0.6 * bump(hour, 8.25, 0.75) + // morning rush, centred on 08:15
    0.6 * bump(hour, 17.75, 0.75) // evening rush, centred on 17:45
  );
}

/** A standard normal random number (Box-Muller), from uniform [0, 1) draws. */
export function gaussian(random: () => number): number {
  const u1 = 1 - random(); // (0, 1]: avoids log(0)
  const u2 = random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Vehicles counted in one interval.
 *
 * @param baseRatePerMinute vehicles/minute this device sees at factor 1.0
 * @param at                when the interval started (local time of day is used)
 */
export function vehicleCount(baseRatePerMinute: number, at: Date, intervalSeconds: number, random: () => number): number {
  const hour = at.getHours() + at.getMinutes() / 60;
  const mean = baseRatePerMinute * timeOfDayFactor(hour) * (intervalSeconds / 60);
  // Real counts behave roughly like a Poisson process, whose spread grows
  // with the square root of the mean. A normal approximation is good enough.
  const noisy = mean + gaussian(random) * Math.sqrt(mean);
  return Math.max(0, Math.round(noisy));
}
