// Wide terminal so the CLI's own word-wrap doesn't split long response
// lines (it wraps at the PTY-reported width). Hard-wrapped rows beyond
// this are rejoined via xterm's isWrapped in TerminalParser.readAllLines.
export const DEFAULT_COLS = 800;
export const DEFAULT_ROWS = 50;
export const DEFAULT_SCROLLBACK = 10000;
export const DEFAULT_IDLE_TIMEOUT_MS = 3000;
export const DEFAULT_STARTUP_TIMEOUT_MS = 60000;
export const DEFAULT_RESPONSE_TIMEOUT_MS = 300000;
export const DEFAULT_CLOSE_TIMEOUT_MS = 5000;
export const DEFAULT_PERMISSION_MODE = 'acceptEdits';

// First-message protection: the CLI repaints for a while after the prompt
// box first appears (MCP/server init) and can swallow input written into
// that window. Settle after startup, then verify the prompt actually
// echoed in the input box before pressing Enter — rewriting once if not.
export const STARTUP_SETTLE_MS = 500;
export const PROMPT_ECHO_TIMEOUT_MS = 2000;
export const PROMPT_ECHO_POLL_MS = 50;
export const PROMPT_WRITE_ATTEMPTS = 2;

export const RAW_BUFFER_MAX_LENGTH = 65536;

export const BOX_DRAWING_CHARS = /[─│┌┐└┘├┤┬┴┼╭╮╰╯]/;
export const BOX_DRAWING_LINE = /^[\s─│┌┐└┘├┤┬┴┼╭╮╰╯]+$/;

export const TOOL_NAMES = [
  'Bash',
  'Read',
  'Edit',
  'Write',
  'Agent',
  'Search',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'NotebookEdit',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
];
