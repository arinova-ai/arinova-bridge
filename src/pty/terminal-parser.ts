import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import type { Terminal as TerminalType } from '@xterm/headless';

const _require = createRequire(import.meta.url);
const { Terminal } = _require('@xterm/headless') as { Terminal: new (options?: Record<string, unknown>) => TerminalType };
import { BOX_DRAWING_LINE, TOOL_NAMES } from './constants.js';
import type { TurnUsage } from './types.js';
import { stripInjectedContext, hasUnclosedInjectionBlock } from '../util/context.js';

// Must stay in sync with `~/.arinova-bridge/statusline.sh` and the
// STATUSLINE_SCRIPT template in `src/setup.ts`. Any line containing this
// marker is treated as the bridge HUD status line.
const HUD_SENTINEL = '__BRIDGE_HUD__';

// `⏺ <ToolName>(...)` — Claude CLI's tool-invocation rendering. Tool names
// live in constants.TOOL_NAMES so adding a new tool is a one-place change.
const TOOL_INVOCATION_RE = new RegExp(`^⏺\\s+(${TOOL_NAMES.join('|')})\\(`);

// `⏺ Calling X… (ctrl+o to expand)` / `⏺ Called X (ctrl+o to expand)` —
// MCP tool-call indicator. The `(ctrl+o to expand)` suffix is a stable
// CLI affordance and makes the match robust against assistant text that
// happens to begin with "Calling" or "Called".
const MCP_INVOCATION_RE = /^⏺\s+(Calling|Called)\b.*\(ctrl\+o to expand\)/;

// Set BRIDGE_PTY_DEBUG=1 to dump streaming-delta input/output to a log
// file for diagnostics. Otherwise the function below is a no-op.
const DEBUG_ENABLED = process.env.BRIDGE_PTY_DEBUG === '1';
const DEBUG_LOG_PATH = path.join(homedir(), '.arinova-bridge', 'logs', 'parser-debug.log');
let debugStream: fs.WriteStream | null = null;
function longestCommonPrefix(a: string, b: string): number {
  const min = Math.min(a.length, b.length);
  let i = 0;
  while (i < min && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

function debugDump(label: string, payload: Record<string, unknown>): void {
  if (!DEBUG_ENABLED) return;
  if (!debugStream) {
    fs.mkdirSync(path.dirname(DEBUG_LOG_PATH), { recursive: true });
    debugStream = fs.createWriteStream(DEBUG_LOG_PATH, { flags: 'a' });
  }
  const ts = new Date().toISOString();
  debugStream.write(`\n===== ${ts} ${label} =====\n`);
  for (const [k, v] of Object.entries(payload)) {
    if (Array.isArray(v)) {
      debugStream.write(`-- ${k} (${v.length}) --\n`);
      v.forEach((line, idx) => debugStream!.write(`  [${idx}] ${JSON.stringify(line)}\n`));
    } else {
      debugStream.write(`${k}: ${JSON.stringify(v)}\n`);
    }
  }
}

export class TerminalParser {
  private terminal: TerminalType;
  private turnStartLine = 0;
  private lastSentPrompt = '';
  private lastStreamedContent = '';
  private turnUsage: Partial<TurnUsage> = {};

  constructor(cols: number, rows: number, scrollback: number) {
    this.terminal = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
  }

  setLastSentPrompt(prompt: string): void {
    this.lastSentPrompt = prompt;
  }

  write(data: string): void {
    this.terminal.write(data);
  }

  writeAsync(data: string): Promise<void> {
    return new Promise((resolve) => {
      this.terminal.write(data, resolve);
    });
  }

  readAllLines(): string[] {
    const buf = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < buf.length; y++) {
      const line = buf.getLine(y);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines;
  }

  readLines(startLine: number, endLine: number): string[] {
    const buf = this.terminal.buffer.active;
    const lines: string[] = [];
    const end = Math.min(endLine, buf.length);
    for (let y = startLine; y < end; y++) {
      const line = buf.getLine(y);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines;
  }

  readBottomLines(n: number): string[] {
    const buf = this.terminal.buffer.active;
    const cursorAbsolute = buf.baseY + buf.cursorY;
    const end = Math.min(buf.length, cursorAbsolute + 1);
    const start = Math.max(0, end - n);
    return this.readLines(start, end);
  }

  getCursorPosition(): { x: number; y: number } {
    const buf = this.terminal.buffer.active;
    return { x: buf.cursorX, y: buf.cursorY };
  }

  getTotalLines(): number {
    return this.terminal.buffer.active.length;
  }

  getViewportBottomLine(): number {
    const buf = this.terminal.buffer.active;
    return buf.baseY + this.terminal.rows;
  }

  resetTurnTracking(): void {
    this.turnStartLine = this.getTotalLines();
  }

  getTurnStartLine(): number {
    return this.turnStartLine;
  }

  extractResponseContent(_startLine?: number): { text: string; endLine: number } {
    const allLines = this.readAllLines();
    const { userPromptIdx, idlePromptIdx } = this.findPromptBoundaries(allLines);

    if (userPromptIdx === -1 || idlePromptIdx === -1 || idlePromptIdx <= userPromptIdx) {
      return { text: '', endLine: allLines.length };
    }

    const responseStartIdx = this.findResponseStart(allLines, userPromptIdx, idlePromptIdx);
    // Anchor on the first ⏺ — Claude CLI always marks each assistant
    // output block with it. Anything between user-message-tail and the
    // first ⏺ is CLI chrome (status, native model widget, paste hint,
    // spinner) and must be skipped without per-pattern matching.
    const firstAssistantIdx = this.findFirstAssistantMarker(allLines, responseStartIdx, idlePromptIdx);
    if (firstAssistantIdx === -1) {
      return { text: '', endLine: allLines.length };
    }

    const contentLines = this.collectAssistantText(allLines, firstAssistantIdx, idlePromptIdx);

    while (contentLines.length > 0 && contentLines[0].trim() === '') {
      contentLines.shift();
    }
    while (contentLines.length > 0 && contentLines[contentLines.length - 1].trim() === '') {
      contentLines.pop();
    }

    return { text: stripInjectedContext(contentLines.join('\n')), endLine: idlePromptIdx };
  }

  extractAllTurns(): Array<{ prompt: string; response: string }> {
    const allLines = this.readAllLines();
    const turns: Array<{ prompt: string; response: string }> = [];

    const userPrompts: number[] = [];
    const promptBoxPrompts = this.findAllPromptBoxes(allLines);

    for (let i = 0; i < allLines.length; i++) {
      const line = allLines[i];
      if (/^❯\s+\S/.test(line) && !promptBoxPrompts.includes(i)) {
        userPrompts.push(i);
      }
    }

    for (const userIdx of userPrompts) {
      const nextPromptBox = promptBoxPrompts.find((idx) => idx > userIdx);
      const nextUser = userPrompts.find((idx) => idx > userIdx);

      let endIdx: number | undefined;
      if (nextPromptBox !== undefined && nextUser !== undefined) {
        endIdx = Math.min(nextPromptBox, nextUser);
      } else {
        endIdx = nextPromptBox ?? nextUser;
      }
      if (endIdx === undefined) continue;

      if (promptBoxPrompts.includes(endIdx)) {
        endIdx = endIdx - 1;
      }

      const promptText = allLines[userIdx].replace(/^❯\s*/, '').trim();
      const responseText = this.extractBetween(allLines, userIdx + 1, endIdx);
      turns.push({ prompt: promptText, response: responseText });
    }

    return turns;
  }

  hasPromptBox(): boolean {
    const allLines = this.readAllLines();

    let lastNonEmpty = allLines.length - 1;
    while (lastNonEmpty >= 0 && allLines[lastNonEmpty].trim() === '') {
      lastNonEmpty--;
    }
    if (lastNonEmpty < 0) return false;

    const scanStart = Math.max(0, lastNonEmpty - 15);
    for (let i = lastNonEmpty; i >= scanStart + 2; i--) {
      const cur = allLines[i].trim();
      if (!(BOX_DRAWING_LINE.test(cur) && cur.length > 10)) continue;

      const promptLine = allLines[i - 1].trim();
      if (!/^❯/.test(promptLine)) continue;

      const topBorder = allLines[i - 2].trim();
      if (!(BOX_DRAWING_LINE.test(topBorder) && topBorder.length > 10)) continue;

      const afterPrompt = promptLine.slice(1).trim();
      if (this.lastSentPrompt && afterPrompt === this.lastSentPrompt) {
        const hasResponse = this.hasResponseAbove(allLines, i - 2);
        return hasResponse;
      }

      return true;
    }

    return false;
  }

  private hasResponseAbove(allLines: string[], promptBoxTopBorder: number): boolean {
    for (let j = promptBoxTopBorder - 1; j >= 0 && j >= promptBoxTopBorder - 30; j--) {
      if (/^⏺/.test(allLines[j].trim())) return true;
    }
    return false;
  }

  resetStreamingState(): void {
    this.lastStreamedContent = '';
  }

  extractStreamingDelta(): string | null {
    const allLines = this.readAllLines();

    const promptBoxes = this.findAllPromptBoxes(allLines);
    let userPromptIdx = -1;
    for (let i = allLines.length - 1; i >= 0; i--) {
      if (/^❯\s+\S/.test(allLines[i]) && !promptBoxes.includes(i)) {
        userPromptIdx = i;
        break;
      }
    }
    if (userPromptIdx === -1) return null;

    const responseStartIdx = this.findResponseStart(allLines, userPromptIdx, allLines.length);
    const firstAssistantIdx = this.findFirstAssistantMarker(allLines, responseStartIdx, allLines.length);
    if (firstAssistantIdx === -1) {
      debugDump('extractStreamingDelta:no-marker', {
        userPromptIdx,
        responseStartIdx,
        tail: this.getUserMessageTail(),
        slice: allLines.slice(responseStartIdx, allLines.length),
      });
      return null;
    }

    // End boundary: the idle prompt box at the buffer bottom is present
    // throughout streaming. Capturing up to (but not including) its top
    // border discards everything below — status line, native widgets,
    // `paste again to expand` overlay, and any future CLI hints rendered
    // in that zone — without per-pattern enumeration.
    const endIdx = promptBoxes.length > 0
      ? promptBoxes[promptBoxes.length - 1]
      : allLines.length;
    if (endIdx <= firstAssistantIdx) return null;

    const contentLines = this.collectAssistantText(allLines, firstAssistantIdx, endIdx);

    while (contentLines.length > 0 && contentLines[0].trim() === '') {
      contentLines.shift();
    }
    while (contentLines.length > 0 && contentLines[contentLines.length - 1].trim() === '') {
      contentLines.pop();
    }

    const rawContent = contentLines.join('\n');

    // While a bridge-injected block (e.g. [Recent history]...[/Recent history])
    // is still streaming, its closing tag hasn't arrived yet — emit nothing
    // until we can scrub the full block, otherwise the partial leaks to the UI.
    if (hasUnclosedInjectionBlock(rawContent)) return null;

    const currentContent = stripInjectedContext(rawContent);
    if (currentContent === this.lastStreamedContent) return null;

    // Claude CLI may re-flow already-rendered text mid-stream (collapse
    // `\n\n` between paragraphs, re-wrap lines). When that happens
    // `startsWith` reports false even though content has clearly grown.
    // Use longest-common-prefix so we emit only the divergent tail, not
    // the entire response from scratch. Cost is a small local visual
    // duplication around the reflow boundary; benefit is no full-response
    // re-emit (which would make the chat UI render a new message bubble
    // every reflow).
    const lcp = longestCommonPrefix(currentContent, this.lastStreamedContent);
    const isIncremental = lcp === this.lastStreamedContent.length;
    let delta: string;
    if (isIncremental || currentContent.length > this.lastStreamedContent.length) {
      delta = currentContent.slice(lcp);
    } else {
      // Content shrunk or unrelated — don't emit; wait for next poll.
      return null;
    }

    debugDump('extractStreamingDelta:emit', {
      userPromptIdx,
      responseStartIdx,
      firstAssistantIdx,
      endIdx,
      tail: this.getUserMessageTail(),
      isIncremental,
      lcp,
      lastStreamedContent: this.lastStreamedContent,
      currentContent,
      delta,
      slice: allLines.slice(responseStartIdx, allLines.length),
    });

    this.lastStreamedContent = currentContent;
    return delta || null;
  }

  hasToolOutput(): boolean {
    const allLines = this.readAllLines();
    return allLines.some((line) => /⎿/.test(line));
  }

  resetTurnUsage(): void {
    this.turnUsage = {};
  }

  getTurnUsage(): TurnUsage | undefined {
    if (Object.keys(this.turnUsage).length === 0) return undefined;
    return this.turnUsage as TurnUsage;
  }

  private parseTokenLine(line: string): void {
    const m = line.match(/^([\d,\.]+)\s*([KM])?\s+tokens/i);
    if (!m) return;
    let n = parseFloat(m[1].replace(/,/g, ''));
    if (m[2]?.toUpperCase() === 'K') n *= 1000;
    if (m[2]?.toUpperCase() === 'M') n *= 1_000_000;
    this.turnUsage.totalTokens = Math.round(n);
  }

  private parseCostOrInfoLine(line: string): void {
    const costMatch = line.match(/^cost:\s*\$?([\d,.]+)/i);
    if (costMatch) {
      this.turnUsage.costUsd = parseFloat(costMatch[1].replace(/,/g, ''));
      return;
    }
    const tokensMatch = line.match(/^tokens:\s*([\d,]+)\s*in\s*\/\s*([\d,]+)\s*out/i);
    if (tokensMatch) {
      this.turnUsage.inputTokens = parseInt(tokensMatch[1].replace(/,/g, ''), 10);
      this.turnUsage.outputTokens = parseInt(tokensMatch[2].replace(/,/g, ''), 10);
      return;
    }
    const modelMatch = line.match(/^model:\s*(.+)/i);
    if (modelMatch) {
      this.turnUsage.model = modelMatch[1].trim();
    }
  }

  private parseStatusLine(line: string): void {
    // Strip the sentinel + any leading whitespace so subsequent anchored
    // regexes (`^\[model\]`) line up regardless of whether the input
    // arrived with or without the sentinel.
    const sentinelAt = line.indexOf(HUD_SENTINEL);
    const content = sentinelAt >= 0
      ? line.slice(sentinelAt + HUD_SENTINEL.length).trimStart()
      : line;

    const modelMatch = content.match(/^\[([^\]]+)\]/);
    if (modelMatch) {
      this.turnUsage.model = modelMatch[1].trim();
    }
    const ctxMatch = content.match(/ctx:\s*(\d+)%/);
    if (ctxMatch) {
      this.turnUsage.contextPercent = parseInt(ctxMatch[1], 10);
    }
    const limit5hMatch = content.match(/5h:\s*(\d+)%(?:\s*\(([^)]+)\))?/);
    if (limit5hMatch) {
      this.turnUsage.limit5hPercent = parseInt(limit5hMatch[1], 10);
      if (limit5hMatch[2]) this.turnUsage.limit5hResetIn = limit5hMatch[2].trim();
    }
    const limit7dMatch = content.match(/7d:\s*(\d+)%(?:\s*\(([^)]+)\))?/);
    if (limit7dMatch) {
      this.turnUsage.limit7dPercent = parseInt(limit7dMatch[1], 10);
      if (limit7dMatch[2]) this.turnUsage.limit7dResetIn = limit7dMatch[2].trim();
    }
    const costMatch = content.match(/\$\s*([\d,.]+)/);
    if (costMatch) {
      this.turnUsage.costUsd = parseFloat(costMatch[1].replace(/,/g, ''));
    }
  }

  private findAllPromptBoxes(allLines: string[]): number[] {
    const results: number[] = [];
    for (let i = 2; i < allLines.length; i++) {
      const bottomBorder = allLines[i].trim();
      if (!(BOX_DRAWING_LINE.test(bottomBorder) && bottomBorder.length > 10)) continue;

      const promptLine = allLines[i - 1].trim();
      if (!/^❯/.test(promptLine)) continue;

      const topBorder = allLines[i - 2].trim();
      if (!(BOX_DRAWING_LINE.test(topBorder) && topBorder.length > 10)) continue;

      results.push(i - 1);
    }
    return results;
  }

  private getUserMessageTail(): string {
    if (!this.lastSentPrompt) return '';
    const lines = this.lastSentPrompt.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = lines[i].trim();
      if (t !== '') return t;
    }
    return '';
  }

  // Primary boundary: locate the echoed last line of the sent prompt in the
  // buffer (between the `❯` line and `searchEnd`). The line *after* that
  // is where the assistant response begins, even when the sent prompt
  // contained injected context blocks that only carry `❯` on their first line.
  // Falls back to `userPromptIdx + 1` (legacy ❯-only boundary) when the tail
  // is empty or cannot be located.
  private findResponseStart(
    allLines: string[],
    userPromptIdx: number,
    searchEnd: number,
  ): number {
    const tail = this.getUserMessageTail();
    if (!tail) return userPromptIdx + 1;

    for (let i = searchEnd - 1; i > userPromptIdx; i--) {
      if (allLines[i].trim() === tail) return i + 1;
    }
    return userPromptIdx + 1;
  }

  // The assistant's output is always introduced by a line beginning with
  // `⏺` (text blocks, tool-use lines, etc.). This makes it an allowlist
  // anchor — we don't need to enumerate every chrome variant that could
  // appear above the first ⏺, we just skip everything until we see it.
  // While walking past skipped rows we still call `isUiChrome` so its
  // side-effects (HUD/usage parsing from the status line) fire even when
  // the row sits *above* the response anchor.
  private findFirstAssistantMarker(
    allLines: string[],
    start: number,
    end: number,
  ): number {
    for (let i = start; i < end; i++) {
      if (/^⏺/.test(allLines[i].trim())) return i;
      this.isUiChrome(allLines[i]);
    }
    return -1;
  }

  // Walk the response range as a state machine and return only the lines
  // that belong to plain assistant text blocks. Tool invocations
  // (`⏺ Tool(...)`, MCP `⏺ Calling/Called X`), tool result rows (`⎿`),
  // and the indented continuation lines below a tool result are dropped
  // — tool activity is surfaced to consumers via separate `toolUse` /
  // `streamEvent` channels, not via the assistant-text stream.
  private collectAssistantText(
    allLines: string[],
    startIdx: number,
    endIdx: number,
  ): string[] {
    type State = 'IN_TEXT' | 'IN_TOOL';
    // Anchor is on a ⏺ line by contract; default to IN_TEXT and let the
    // first iteration flip to IN_TOOL if it's a tool invocation.
    let state: State = 'IN_TEXT';
    const out: string[] = [];

    for (let i = startIdx; i < endIdx; i++) {
      const line = allLines[i];
      const trimmed = line.trim();

      if (this.isUiChrome(line)) continue;
      if (/^❯/.test(trimmed)) continue;

      // Tool-block triggers — never push, always set state to IN_TOOL.
      if (TOOL_INVOCATION_RE.test(trimmed) || MCP_INVOCATION_RE.test(trimmed)) {
        state = 'IN_TOOL';
        continue;
      }
      if (trimmed.startsWith('⎿')) {
        state = 'IN_TOOL';
        continue;
      }

      // Plain `⏺ <text>` — opens (or re-opens) an assistant text block.
      if (/^⏺\s/.test(trimmed)) {
        state = 'IN_TEXT';
        out.push(line.replace(/^⏺\s?/, ''));
        continue;
      }

      // Blank line — preserved inside text blocks, dropped inside tool
      // blocks (keeps the post-tool gap from doubling up in the output).
      if (trimmed === '') {
        if (state === 'IN_TEXT') out.push('');
        continue;
      }

      // Plain text line, no marker — continuation. Belongs to whichever
      // block we're currently in.
      if (state === 'IN_TEXT') {
        out.push(line);
      }
      // state === 'IN_TOOL' → drop the line (tool result continuation).
    }

    return out;
  }

  private findPromptBoundaries(allLines: string[]): {
    userPromptIdx: number;
    idlePromptIdx: number;
  } {
    let userPromptIdx = -1;
    let idlePromptIdx = -1;

    const promptBoxes = this.findAllPromptBoxes(allLines);
    if (promptBoxes.length > 0) {
      idlePromptIdx = promptBoxes[promptBoxes.length - 1];
    }

    const searchEnd = idlePromptIdx !== -1 ? idlePromptIdx : allLines.length;
    for (let i = searchEnd - 1; i >= 0; i--) {
      const line = allLines[i];
      if (/^❯\s+\S/.test(line) && !promptBoxes.includes(i)) {
        userPromptIdx = i;
        break;
      }
    }

    return { userPromptIdx, idlePromptIdx };
  }

  private extractBetween(allLines: string[], start: number, end: number): string {
    const contentLines: string[] = [];
    for (let i = start; i < end; i++) {
      const line = allLines[i];
      if (this.isUiChrome(line)) continue;
      if (line.trim() === '') {
        contentLines.push('');
        continue;
      }
      const cleaned = line.replace(/^⏺\s?/, '');
      contentLines.push(cleaned);
    }

    while (contentLines.length > 0 && contentLines[0].trim() === '') {
      contentLines.shift();
    }
    while (contentLines.length > 0 && contentLines[contentLines.length - 1].trim() === '') {
      contentLines.pop();
    }

    return contentLines.join('\n');
  }

  private isUiChrome(line: string): boolean {
    const trimmed = line.trim();
    if (trimmed === '') return false;

    if (BOX_DRAWING_LINE.test(trimmed) && trimmed.length > 10) return true;

    if (/^[✻✢·✶✽✳]\s/.test(trimmed)) return true;

    if (/^\d+[\.,]?\d*[KM]?\s+tokens/.test(trimmed)) {
      this.parseTokenLine(trimmed);
      return true;
    }
    if (/^(cost|tokens|model):/i.test(trimmed)) {
      this.parseCostOrInfoLine(trimmed);
      return true;
    }

    // Status line: the arinova-bridge statusline.sh prepends a stable
    // `__BRIDGE_HUD__` sentinel to its single-line output. Treating any
    // row containing the sentinel as UI chrome means we don't need to
    // chase Claude CLI's evolving status-overlay shape (which renders on
    // the same row to the right of our output) — the whole row goes.
    if (trimmed.includes(HUD_SENTINEL)) {
      this.parseStatusLine(trimmed);
      return true;
    }
    // Legacy fallback for setups whose statusline.sh predates the sentinel
    // and only emits `[model] ctx:N% ...`. Kept narrow so it doesn't catch
    // assistant text that happens to contain `[X] ctx:`.
    if (/^\[[^\]]+\]\s+ctx:\s*\d+%/.test(trimmed)) {
      this.parseStatusLine(trimmed);
      return true;
    }

    if (/^⏵⏵\s/.test(trimmed)) return true;
    if (/^│.*│$/.test(trimmed)) return true;
    if (/^[╭╮╰╯┌┐└┘]/.test(trimmed) && /[╭╮╰╯┌┐└┘]$/.test(trimmed)) return true;
    if (/^⎿\s+SessionStart:/.test(trimmed)) return true;

    return false;
  }

  dispose(): void {
    this.terminal.dispose();
  }
}
