import type { ClaudeState } from './types.js';

export class ClaudePtyError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ClaudePtyError';
  }
}

export class StartupTimeoutError extends ClaudePtyError {
  constructor() {
    super(
      'Claude CLI did not become ready within timeout',
      'STARTUP_TIMEOUT',
    );
    this.name = 'StartupTimeoutError';
  }
}

export class ResponseTimeoutError extends ClaudePtyError {
  constructor() {
    super('Response did not complete within timeout', 'RESPONSE_TIMEOUT');
    this.name = 'ResponseTimeoutError';
  }
}

export class NotReadyError extends ClaudePtyError {
  constructor(state: ClaudeState) {
    super(`Cannot send: Claude is in state ${state}, expected IDLE`, 'NOT_READY');
    this.name = 'NotReadyError';
  }
}

export class ProcessExitedError extends ClaudePtyError {
  constructor(code: number, signal?: number) {
    super(
      `Claude process exited with code ${code}${signal ? `, signal ${signal}` : ''}`,
      'PROCESS_EXITED',
    );
    this.name = 'ProcessExitedError';
  }
}

export class SendInProgressError extends ClaudePtyError {
  constructor() {
    super('Another send() is already in progress', 'SEND_IN_PROGRESS');
    this.name = 'SendInProgressError';
  }
}
