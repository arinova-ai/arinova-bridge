import { ClaudeState } from './types.js';
import { RAW_BUFFER_MAX_LENGTH } from './constants.js';
import type { TerminalParser } from './terminal-parser.js';

export type StateChangeCallback = (
  newState: ClaudeState,
  oldState: ClaudeState,
) => void;

export type InterceptCallback = (rawBuffer: string) => void;

export class StateDetector {
  private state: ClaudeState = ClaudeState.STARTING;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private rawBuffer = '';
  private onIntercept: InterceptCallback | null = null;

  constructor(
    private idleTimeoutMs: number,
    private parser: TerminalParser,
    private onStateChange: StateChangeCallback,
  ) {}

  setInterceptCallback(cb: InterceptCallback | null): void {
    this.onIntercept = cb;
  }

  feedRawData(data: string): void {
    this.rawBuffer += data;
    if (this.rawBuffer.length > RAW_BUFFER_MAX_LENGTH) {
      this.rawBuffer = this.rawBuffer.slice(-RAW_BUFFER_MAX_LENGTH);
    }

    if (this.state === ClaudeState.EXITED || this.state === ClaudeState.ERROR) {
      return;
    }

    if (this.onIntercept) {
      this.onIntercept(this.rawBuffer);
    }

    this.checkFastPathPatterns(data);
    this.resetIdleTimer();
  }

  notifyInputSent(): void {
    if (this.state === ClaudeState.IDLE) {
      this.transition(ClaudeState.RESPONDING);
    }
  }

  notifyExit(_code: number, _signal?: number): void {
    this.clearIdleTimer();
    this.transition(ClaudeState.EXITED);
  }

  forceState(state: ClaudeState): void {
    this.transition(state);
  }

  getState(): ClaudeState {
    return this.state;
  }

  getRawBuffer(): string {
    return this.rawBuffer;
  }

  dispose(): void {
    this.clearIdleTimer();
  }

  private transition(newState: ClaudeState): void {
    if (newState === this.state) return;
    const oldState = this.state;
    this.state = newState;
    this.onStateChange(newState, oldState);
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => this.onIdleTimeout(), this.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private onIdleTimeout(): void {
    if (this.state === ClaudeState.EXITED || this.state === ClaudeState.ERROR) {
      return;
    }

    const hasPrompt = this.parser.hasPromptBox();

    if (this.state === ClaudeState.STARTING && hasPrompt) {
      this.transition(ClaudeState.IDLE);
      return;
    }

    if (
      this.state === ClaudeState.RESPONDING ||
      this.state === ClaudeState.TOOL_USE ||
      this.state === ClaudeState.PERMISSION_PROMPT
    ) {
      if (hasPrompt) {
        this.transition(ClaudeState.IDLE);
      }
      return;
    }
  }

  private checkFastPathPatterns(data: string): void {
    const stripped = this.stripAnsi(data);

    if (this.state === ClaudeState.RESPONDING) {
      if (this.looksLikeToolUse(stripped)) {
        this.transition(ClaudeState.TOOL_USE);
        return;
      }
    }

    if (this.state === ClaudeState.TOOL_USE || this.state === ClaudeState.RESPONDING) {
      if (this.looksLikePermissionPrompt(stripped)) {
        this.transition(ClaudeState.PERMISSION_PROMPT);
        return;
      }
    }
  }

  private looksLikeToolUse(stripped: string): boolean {
    if (/⏺\s*(Bash|Read|Edit|Write|Agent|Grep|Glob|WebFetch|WebSearch)\b/.test(stripped)) return true;
    if (/⎿/.test(stripped) && !/SessionStart/.test(stripped)) return true;
    return false;
  }

  private looksLikePermissionPrompt(stripped: string): boolean {
    if (/Allow\s+(Bash|Read|Edit|Write|command)/i.test(stripped)) return true;
    if (/\[y\].*\[n\]/i.test(stripped)) return true;
    return false;
  }

  private stripAnsi(data: string): string {
    // eslint-disable-next-line no-control-regex -- strips ANSI CSI escape sequences
    return data.replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, ' ');
  }
}
