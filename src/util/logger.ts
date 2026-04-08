export interface Logger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

function ts(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

export function createLogger(prefix = "bridge"): Logger {
  return {
    info: (msg: string) => console.log(`${ts()} [INFO] [${prefix}] ${msg}`),
    warn: (msg: string) => console.warn(`${ts()} [WARN] [${prefix}] ${msg}`),
    error: (msg: string) => console.error(`${ts()} [ERROR] [${prefix}] ${msg}`),
  };
}
