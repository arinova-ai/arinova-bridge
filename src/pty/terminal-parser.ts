import { Terminal } from '@xterm/headless';
import { BOX_DRAWING_LINE } from './constants.js';
import type { TurnUsage } from './types.js';

export class TerminalParser {
  private terminal: Terminal;
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

    const contentLines: string[] = [];
    for (let i = userPromptIdx + 1; i < idlePromptIdx; i++) {
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

    return { text: contentLines.join('\n'), endLine: idlePromptIdx };
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

    const contentLines: string[] = [];
    for (let i = userPromptIdx + 1; i < allLines.length; i++) {
      const line = allLines[i];
      if (this.isUiChrome(line)) continue;
      if (/^❯/.test(line.trim())) continue;
      if (line.trim() === '') {
        contentLines.push('');
        continue;
      }
      contentLines.push(line.replace(/^⏺\s?/, ''));
    }

    while (contentLines.length > 0 && contentLines[0].trim() === '') {
      contentLines.shift();
    }
    while (contentLines.length > 0 && contentLines[contentLines.length - 1].trim() === '') {
      contentLines.pop();
    }

    const currentContent = contentLines.join('\n');
    if (currentContent === this.lastStreamedContent) return null;

    let delta: string;
    if (currentContent.startsWith(this.lastStreamedContent)) {
      delta = currentContent.slice(this.lastStreamedContent.length);
    } else {
      delta = currentContent;
    }

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
    const modelMatch = line.match(/^\[([^\]]+)\]/);
    if (modelMatch) {
      this.turnUsage.model = modelMatch[1].trim();
    }
    const ctxMatch = line.match(/ctx:\s*(\d+)%/);
    if (ctxMatch) {
      this.turnUsage.contextPercent = parseInt(ctxMatch[1], 10);
    }
    const limit5hMatch = line.match(/5h:\s*(\d+)%(?:\s*\(([^)]+)\))?/);
    if (limit5hMatch) {
      this.turnUsage.limit5hPercent = parseInt(limit5hMatch[1], 10);
      if (limit5hMatch[2]) this.turnUsage.limit5hResetIn = limit5hMatch[2].trim();
    }
    const limit7dMatch = line.match(/7d:\s*(\d+)%(?:\s*\(([^)]+)\))?/);
    if (limit7dMatch) {
      this.turnUsage.limit7dPercent = parseInt(limit7dMatch[1], 10);
      if (limit7dMatch[2]) this.turnUsage.limit7dResetIn = limit7dMatch[2].trim();
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

    if (/^\[.*\]\s+ctx:/.test(trimmed)) {
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
