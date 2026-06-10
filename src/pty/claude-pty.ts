import { EventEmitter } from 'events';
import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';
import { TerminalParser } from './terminal-parser.js';
import { StateDetector } from './state-detector.js';
import {
  TranscriptReader,
  transcriptPathFor,
  type TranscriptLine,
} from './transcript-reader.js';
import { stripInjectedContext } from '../util/context.js';
import type {
  ClaudePtyOptions,
  SendOptions,
  SendResult,
  TurnUsage,
  ToolUseInfo,
  PipeResult,
  PromptOptions,
  StreamEvent} from './types.js';
import {
  ClaudeState
} from './types.js';
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  DEFAULT_SCROLLBACK,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_STARTUP_TIMEOUT_MS,
  DEFAULT_RESPONSE_TIMEOUT_MS,
  DEFAULT_CLOSE_TIMEOUT_MS,
  DEFAULT_PERMISSION_MODE,
} from './constants.js';
import {
  StartupTimeoutError,
  ResponseTimeoutError,
  NotReadyError,
  ProcessExitedError,
  SendInProgressError,
} from './errors.js';

export interface ClaudePtyEventMap {
  stateChange: [state: ClaudeState, previousState: ClaudeState];
  data: [chunk: string];
  content: [delta: string];
  response: [fullResponse: string];
  toolUse: [info: ToolUseInfo];
  streamEvent: [event: StreamEvent];
  transcriptLine: [line: TranscriptLine];
  error: [error: Error];
  exit: [code: number, signal?: number];
}

export class ClaudePty extends EventEmitter {
  private ptyProcess: pty.IPty | null = null;
  private parser: TerminalParser;
  private detector: StateDetector;
  private transcriptReader: TranscriptReader | null = null;
  private turnTranscript: TranscriptLine[] = [];
  private turnPrompt: string | null = null;
  private turnUserSeen = false;
  readonly sessionId: string;
  private transcriptEnabled: boolean;
  private passSessionIdArg: boolean;
  private disposed = false;

  private pendingResolve: ((result: SendResult) => void) | null = null;
  private pendingReject: ((error: Error) => void) | null = null;
  private responseTimer: ReturnType<typeof setTimeout> | null = null;
  private contentPollTimer: ReturnType<typeof setTimeout> | null = null;
  private turnStartLine = 0;
  private turnToolsUsed: ToolUseInfo[] = [];
  private turnStartTime = 0;
  private autoApprovePermissions = false;
  private contentBlockIndex = 0;

  private opts: Required<
    Pick<
      ClaudePtyOptions,
      | 'claudePath'
      | 'cwd'
      | 'args'
      | 'cols'
      | 'rows'
      | 'env'
      | 'idleTimeoutMs'
      | 'startupTimeoutMs'
      | 'responseTimeoutMs'
      | 'permissionMode'
      | 'scrollback'
    >
  > &
    Pick<ClaudePtyOptions, 'model' | 'systemPrompt'>;

  constructor(options: ClaudePtyOptions = {}) {
    super();
    this.opts = {
      claudePath: options.claudePath ?? 'claude',
      cwd: options.cwd ?? process.cwd(),
      args: options.args ?? [],
      cols: options.cols ?? DEFAULT_COLS,
      rows: options.rows ?? DEFAULT_ROWS,
      env: options.env ?? {},
      idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      startupTimeoutMs: options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      responseTimeoutMs:
        options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS,
      permissionMode: options.permissionMode ?? DEFAULT_PERMISSION_MODE,
      scrollback: options.scrollback ?? DEFAULT_SCROLLBACK,
      model: options.model,
      systemPrompt: options.systemPrompt,
    };
    this.transcriptEnabled = options.transcript !== false;
    this.passSessionIdArg = options.passSessionIdArg !== false;
    this.sessionId = options.sessionId ?? randomUUID();

    this.parser = new TerminalParser(
      this.opts.cols,
      this.opts.rows,
      this.opts.scrollback,
    );

    this.detector = new StateDetector(
      this.opts.idleTimeoutMs,
      this.parser,
      (newState, oldState) => this.handleStateChange(newState, oldState),
    );
  }

  async start(): Promise<void> {
    if (this.ptyProcess) {
      throw new Error('Already started');
    }

    const cliArgs = this.buildArgs();

    if (this.transcriptEnabled) {
      this.transcriptReader = new TranscriptReader(
        transcriptPathFor(this.opts.cwd, this.sessionId),
      );
      this.transcriptReader.on('line', (line: TranscriptLine) => {
        this.emit('transcriptLine', line);
        // Gate on our own user-prompt line before collecting assistant
        // lines: stray turns (e.g. a SessionStart/resume hook producing
        // "No response requested.") can flush to the transcript after
        // send() cleared the buffer and would otherwise contaminate the
        // turn. If the prompt line never matches, the turn falls back
        // to screen extraction — safe.
        if (
          !this.turnUserSeen &&
          line.type === 'user' &&
          typeof line.message?.content === 'string' &&
          this.turnPrompt !== null &&
          line.message.content === this.turnPrompt
        ) {
          this.turnUserSeen = true;
          return;
        }
        if (this.turnUserSeen && line.type === 'assistant' && !line.isSidechain) {
          this.turnTranscript.push(line);
        }
      });
      this.transcriptReader.start();
    }

    this.ptyProcess = pty.spawn(this.opts.claudePath, cliArgs, {
      name: 'xterm-256color',
      cols: this.opts.cols,
      rows: this.opts.rows,
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env } as Record<string, string>,
    });

    this.ptyProcess.onData((data: string) => {
      this.parser.write(data);
      this.detector.feedRawData(data);
      this.emit('data', data);
      this.scheduleContentPoll();
    });

    this.ptyProcess.onExit(
      ({ exitCode, signal }: { exitCode: number; signal?: number }) => {
        this.detector.notifyExit(exitCode, signal);
        this.emit('exit', exitCode, signal);

        if (this.pendingReject) {
          this.pendingReject(new ProcessExitedError(exitCode, signal));
          this.pendingResolve = null;
          this.pendingReject = null;
          this.clearResponseTimer();
        }
      },
    );

    this.setupStartupInterceptor();

    await this.waitForState(
      ClaudeState.IDLE,
      this.opts.startupTimeoutMs,
      () => new StartupTimeoutError(),
    );

    this.detector.setInterceptCallback(null);
  }

  async send(prompt: string, options?: SendOptions): Promise<SendResult> {
    if (this.detector.getState() !== ClaudeState.IDLE) {
      throw new NotReadyError(this.detector.getState());
    }
    if (this.pendingResolve) {
      throw new SendInProgressError();
    }

    this.autoApprovePermissions = options?.autoApprovePermissions ?? false;
    this.turnStartLine = this.parser.getTotalLines();
    this.turnToolsUsed = [];
    this.turnTranscript = [];
    this.turnPrompt = prompt;
    this.turnUserSeen = false;
    this.turnStartTime = Date.now();
    this.parser.resetTurnTracking();
    this.parser.resetTurnUsage();

    this.parser.setLastSentPrompt(prompt);
    await this.writePrompt(prompt);
    this.detector.notifyInputSent();

    const timeoutMs = options?.timeoutMs ?? this.opts.responseTimeoutMs;

    return new Promise<SendResult>((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;

      this.responseTimer = setTimeout(() => {
        if (this.pendingReject) {
          this.pendingReject(new ResponseTimeoutError());
          this.pendingResolve = null;
          this.pendingReject = null;
        }
      }, timeoutMs);
    });
  }

  writeRaw(data: string): void {
    this.ptyProcess?.write(data);
  }

  private writePrompt(prompt: string): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(() => {
        this.ptyProcess!.write(prompt);
        setTimeout(() => {
          this.ptyProcess!.write('\r');
          resolve();
        }, 50);
      }, 100);
    });
  }

  approvePermission(): void {
    this.ptyProcess?.write('y\r');
  }

  denyPermission(): void {
    this.ptyProcess?.write('n\r');
  }

  async close(timeoutMs?: number): Promise<void> {
    if (!this.ptyProcess) return;

    const timeout = timeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.ptyProcess.write('\x1b');
    this.ptyProcess.write('/exit\r');

    await Promise.race([
      this.waitForState(ClaudeState.EXITED, timeout, () => null),
      new Promise<void>((resolve) => setTimeout(resolve, timeout)),
    ]);

    if (this.detector.getState() !== ClaudeState.EXITED) {
      this.kill();
    }
  }

  kill(signal?: string): void {
    this.ptyProcess?.kill(signal);
  }

  get isReady(): boolean {
    return this.detector.getState() === ClaudeState.IDLE;
  }

  get state(): ClaudeState {
    return this.detector.getState();
  }

  getScreenContent(): string[] {
    return this.parser.readAllLines();
  }

  getAllTurns(): Array<{ prompt: string; response: string }> {
    return this.parser.extractAllTurns();
  }

  getLastUsage(): TurnUsage | undefined {
    return this.parser.getTurnUsage();
  }

  /** Transcript lines collected during the current/most recent turn. */
  getTurnTranscript(): TranscriptLine[] {
    return [...this.turnTranscript];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearResponseTimer();
    this.clearContentPollTimer();
    this.transcriptReader?.dispose();
    this.detector.dispose();
    this.parser.dispose();
    this.ptyProcess?.kill();
    this.removeAllListeners();
  }

  private scheduleContentPoll(): void {
    const state = this.detector.getState();
    if (state !== ClaudeState.RESPONDING && state !== ClaudeState.TOOL_USE) return;
    if (this.contentPollTimer) return;

    this.contentPollTimer = setTimeout(() => {
      this.contentPollTimer = null;
      const delta = this.parser.extractStreamingDelta();
      if (delta) {
        this.emit('content', delta);
        this.emit('streamEvent', {
          type: 'content_block_delta',
          index: this.contentBlockIndex,
          delta: { type: 'text_delta', text: delta },
        });
      }
    }, 200);
  }

  private clearContentPollTimer(): void {
    if (this.contentPollTimer) {
      clearTimeout(this.contentPollTimer);
      this.contentPollTimer = null;
    }
  }

  private setupStartupInterceptor(): void {
    let trustDialogHandled = false;
    this.detector.setInterceptCallback((rawBuffer: string) => {
      if (trustDialogHandled) return;
      // eslint-disable-next-line no-control-regex -- strips ANSI CSI escape sequences
      const stripped = rawBuffer.replace(/\x1b\[[^a-zA-Z]*[a-zA-Z]/g, ' ');
      if (/trust this folder/i.test(stripped) && /Yes.*trust/i.test(stripped)) {
        trustDialogHandled = true;
        this.ptyProcess?.write('\r');
      }
    });
  }

  private buildArgs(): string[] {
    const args: string[] = [];

    if (this.transcriptEnabled && this.passSessionIdArg) {
      args.push('--session-id', this.sessionId);
    }
    args.push('--permission-mode', this.opts.permissionMode);

    if (this.opts.model) {
      args.push('--model', this.opts.model);
    }

    if (this.opts.systemPrompt) {
      args.push('--system-prompt', this.opts.systemPrompt);
    }

    args.push(...this.opts.args);

    return args;
  }

  private handleStateChange(
    newState: ClaudeState,
    oldState: ClaudeState,
  ): void {
    this.emit('stateChange', newState, oldState);
    this.emit('streamEvent', { type: 'state', state: newState, previous_state: oldState });

    if (newState === ClaudeState.RESPONDING && oldState === ClaudeState.IDLE) {
      this.parser.resetStreamingState();
      this.contentBlockIndex = 0;
    }

    if (newState === ClaudeState.TOOL_USE && oldState !== ClaudeState.TOOL_USE) {
      const info = this.extractToolInfo();
      this.turnToolsUsed.push(info);
      this.emit('toolUse', info);
      this.emit('streamEvent', { type: 'tool_use', tool_name: info.toolName, summary: info.summary });
      this.contentBlockIndex++;
    }

    if (newState === ClaudeState.PERMISSION_PROMPT && this.autoApprovePermissions) {
      this.approvePermission();
    }

    if (newState === ClaudeState.IDLE && (oldState === ClaudeState.RESPONDING || oldState === ClaudeState.TOOL_USE)) {
      this.clearContentPollTimer();
      this.resolveCurrentSend();
    }
  }

  private extractToolInfo(): ToolUseInfo {
    const bottomLines = this.parser.readBottomLines(15);
    for (const line of bottomLines) {
      const toolMatch = line.match(/(?:⏺|⎿)\s*(Bash|Read|Edit|Write|Agent|Grep|Glob|WebFetch|WebSearch|NotebookEdit)\b(.*)/);
      if (toolMatch) {
        return { toolName: toolMatch[1], summary: toolMatch[2]?.trim() ?? '' };
      }
    }
    return { toolName: 'unknown', summary: '' };
  }

  // Distill the turn's transcript lines into response text, tool calls,
  // and usage. Unlike `claude -p` (which returns only the final
  // message's text), the bridge keeps ALL assistant text blocks joined —
  // narration before tool calls is conversationally meaningful in chat,
  // and this matches what the screen-scrape path has always produced.
  private extractTranscriptTurn(): {
    text: string;
    toolsUsed: ToolUseInfo[];
    usage: Partial<TurnUsage>;
  } | null {
    const msgs = this.turnTranscript.filter(
      (l) => Array.isArray(l.message?.content),
    );
    if (msgs.length === 0) return null;

    const textParts: string[] = [];
    const toolsUsed: ToolUseInfo[] = [];
    // The transcript writes one line per content block; blocks of the
    // same API message repeat the same message.id and usage. Dedupe by
    // id so each iteration's tokens are counted once (last line wins).
    const usageByMessageId = new Map<string, NonNullable<TranscriptLine['message']>>();
    let model: string | undefined;

    for (const m of msgs) {
      for (const b of m.message!.content as Array<{ type: string; text?: string; name?: string; input?: unknown }>) {
        if (b.type === 'text' && b.text) {
          textParts.push(b.text);
        } else if (b.type === 'tool_use') {
          let summary = '';
          try {
            summary = JSON.stringify(b.input ?? {}).slice(0, 200);
          } catch { /* unserializable input */ }
          toolsUsed.push({ toolName: b.name ?? 'unknown', summary });
        }
      }
      if (m.message!.id) usageByMessageId.set(m.message!.id, m.message!);
      model = m.message!.model ?? model;
    }

    let inputTokens = 0;
    let outputTokens = 0;
    for (const msg of usageByMessageId.values()) {
      inputTokens += msg.usage?.input_tokens ?? 0;
      outputTokens += msg.usage?.output_tokens ?? 0;
    }

    return {
      text: stripInjectedContext(textParts.join('\n\n')).trim(),
      toolsUsed,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        model,
      },
    };
  }

  private resolveCurrentSend(): void {
    if (!this.pendingResolve) return;

    // Final synchronous drain — the turn's last assistant line is on
    // disk before the idle prompt box repaints, but the 200ms poll may
    // not have picked it up yet.
    this.transcriptReader?.poll();
    const transcript = this.extractTranscriptTurn();

    const durationMs = Date.now() - this.turnStartTime;
    const screenUsage = this.parser.getTurnUsage();

    let text: string;
    let result: SendResult;
    if (transcript) {
      text = transcript.text;
      result = {
        response: text,
        durationMs,
        toolsUsed: transcript.toolsUsed.length > 0 ? transcript.toolsUsed : this.turnToolsUsed,
        // Transcript usage is authoritative (real token counts); keep
        // statusline-derived fields (ctx%, rate limits, cost) it can't
        // know.
        usage: { ...screenUsage, ...transcript.usage },
        source: 'transcript',
      };
    } else {
      text = this.parser.extractResponseContent(this.turnStartLine).text;
      result = {
        response: text,
        durationMs,
        toolsUsed: this.turnToolsUsed,
        usage: screenUsage,
        source: 'screen',
      };
    }
    const usage = result.usage;

    this.emit('streamEvent', { type: 'content_block_stop', index: this.contentBlockIndex });
    this.emit('streamEvent', {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    });
    this.emit('streamEvent', {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: text,
      duration_ms: durationMs,
      num_turns: 1,
      tools_used: result.toolsUsed,
      stop_reason: 'end_turn',
      session_id: this.sessionId,
      usage,
    });

    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    this.pendingReject = null;
    this.clearResponseTimer();
    this.autoApprovePermissions = false;

    this.parser.setLastSentPrompt('');
    resolve(result);
    this.emit('response', text);
  }

  private clearResponseTimer(): void {
    if (this.responseTimer !== null) {
      clearTimeout(this.responseTimer);
      this.responseTimer = null;
    }
  }

  private waitForState(
    targetState: ClaudeState,
    timeoutMs: number,
    makeError: () => Error | null,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.detector.getState() === targetState) {
        resolve();
        return;
      }

      const timer = setTimeout(() => {
        this.removeListener('stateChange', handler);
        const err = makeError();
        if (err) reject(err);
        else resolve();
      }, timeoutMs);

      const handler = (state: ClaudeState) => {
        if (state === targetState) {
          clearTimeout(timer);
          this.removeListener('stateChange', handler);
          resolve();
        }
      };

      this.on('stateChange', handler);
    });
  }

  static async prompt(prompt: string, options?: PromptOptions): Promise<PipeResult> {
    const startTime = Date.now();
    const instance = new ClaudePty({
      claudePath: options?.claudePath,
      cwd: options?.cwd,
      model: options?.model,
      systemPrompt: options?.systemPrompt,
      permissionMode: options?.permissionMode ?? 'default',
      responseTimeoutMs: options?.timeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS,
      args: options?.args,
      env: options?.env,
    });

    try {
      await instance.start();
      const result = await instance.send(prompt);
      const pipeResult: PipeResult = {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: result.response,
        duration_ms: Date.now() - startTime,
        num_turns: 1,
        tools_used: result.toolsUsed,
        stop_reason: 'end_turn',
      };
      try { await instance.close(); } catch { instance.kill(); }
      instance.dispose();
      return pipeResult;
    } catch (err) {
      const isTimeout = err instanceof ResponseTimeoutError;
      const pipeResult: PipeResult = {
        type: 'result',
        subtype: 'error',
        is_error: true,
        result: '',
        error: err instanceof Error ? err.message : String(err),
        duration_ms: Date.now() - startTime,
        num_turns: 0,
        tools_used: [],
        stop_reason: isTimeout ? 'timeout' : 'error',
      };
      try { instance.kill(); } catch { /* ignore */ }
      instance.dispose();
      return pipeResult;
    }
  }
}
