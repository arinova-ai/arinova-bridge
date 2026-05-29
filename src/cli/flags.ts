export function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  const val = args[idx + 1];
  if (val.startsWith("--")) return undefined;
  return val;
}

export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

export function ipcError(resp: { error: { message: string } }): never {
  console.error(`Error: ${resp.error.message}`);
  process.exit(1);
}
