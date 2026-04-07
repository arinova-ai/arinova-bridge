export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

function ts(): string {
  return new Date().toISOString().slice(11, 23); // HH:mm:ss.SSS
}

export function createLogger(prefix = "bridge"): Logger {
  return {
    info: (msg: string) => console.log(`${ts()} [INFO] [${prefix}] ${msg}`),
    warn: (msg: string) => console.warn(`${ts()} [WARN] [${prefix}] ${msg}`),
    error: (msg: string) => console.error(`${ts()} [ERROR] [${prefix}] ${msg}`),
  };
}
