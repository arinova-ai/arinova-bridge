export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export function createLogger(prefix = "bridge"): Logger {
  return {
    info: (msg: string) => console.log(`[INFO] [${prefix}] ${msg}`),
    warn: (msg: string) => console.warn(`[WARN] [${prefix}] ${msg}`),
    error: (msg: string) => console.error(`[ERROR] [${prefix}] ${msg}`),
  };
}
