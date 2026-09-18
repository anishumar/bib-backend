
/**
 * Which calendar this firm's days are cut on (0071).
 *
 * A sweep has no caller to send its day, and the server's UTC day is
 * yesterday in India until 05:30 — a T-X task raised five and a half hours
 * late, a rung fired a day late. "Today" for a firm's own sweep is the day in
 * the firm's zone, the same answer the per-period spawn and the chaser give.
 * Structural: satisfied by `PostgresFirmTimeZone` and `FakeFirmTimeZone`.
 */
export interface FirmTimeZone {
  timeZoneFor(tenantId: string): Promise<string>;
}
