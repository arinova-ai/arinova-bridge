import fs from "node:fs";
import path from "node:path";

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

// File logger — writes all log lines to ~/.arinova-bridge/logs/bridge.log
const logDir = path.join(process.env.HOME ?? "/tmp", ".arinova-bridge", "logs");
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, "bridge.log");
const logStream = fs.createWriteStream(logFile, { flags: "a" });

function writeToFile(line: string) {
  logStream.write(line + "\n");
}

export function createLogger(prefix = "bridge"): Logger {
  return {
    info: (msg: string) => {
      const line = `${ts()} [INFO] [${prefix}] ${msg}`;
      console.log(line);
      writeToFile(line);
    },
    warn: (msg: string) => {
      const line = `${ts()} [WARN] [${prefix}] ${msg}`;
      console.warn(line);
      writeToFile(line);
    },
    error: (msg: string) => {
      const line = `${ts()} [ERROR] [${prefix}] ${msg}`;
      console.error(line);
      writeToFile(line);
    },
  };
}
