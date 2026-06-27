type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel(): Level {
  const lvl = (process.env.LOG_LEVEL ?? "info") as Level;
  return lvl in ORDER ? lvl : "info";
}

function emit(level: Level, msg: string, meta?: unknown): void {
  if (ORDER[level] < ORDER[currentLevel()]) return;
  const prefix = `[${level.toUpperCase()}]`;
  if (meta !== undefined) {
    // eslint-disable-next-line no-console
    console.log(prefix, msg, meta);
  } else {
    // eslint-disable-next-line no-console
    console.log(prefix, msg);
  }
}

/** Minimal leveled logger. Swappable for pino/winston later without touching callers. */
export const logger = {
  debug: (msg: string, meta?: unknown) => emit("debug", msg, meta),
  info: (msg: string, meta?: unknown) => emit("info", msg, meta),
  warn: (msg: string, meta?: unknown) => emit("warn", msg, meta),
  error: (msg: string, meta?: unknown) => emit("error", msg, meta),
};
