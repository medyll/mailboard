export interface Logger {
  log: (...values: unknown[]) => void;
  warn: (...values: unknown[]) => void;
  error: (...values: unknown[]) => void;
}
export const stderrLogger: Logger = {
  log: (...values) => console.error(...values),
  warn: (...values) => console.error(...values),
  error: (...values) => console.error(...values),
};
