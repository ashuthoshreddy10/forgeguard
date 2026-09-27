/**
 * StreamParser.ts — Utilities for parsing structured content out of Bob output.
 *
 * Bob responses may contain free-form text mixed with structured blocks.
 * ForgeGuard uses a simple delimiter protocol to extract JSON payloads:
 *
 *   --- FORGEGUARD:JSON ---
 *   { "key": "value" }
 *   --- END ---
 *
 * This module provides functions to extract those blocks and parse them safely.
 */

const JSON_BLOCK_OPEN = '--- FORGEGUARD:JSON ---';
const JSON_BLOCK_CLOSE = '--- END ---';

/**
 * Extract the first JSON block from a Bob response string.
 * Returns the parsed object, or null if no block is found or JSON is invalid.
 */
export function extractJsonBlock(output: string): unknown | null {
  const openIdx = output.indexOf(JSON_BLOCK_OPEN);
  if (openIdx === -1) return null;

  const start = openIdx + JSON_BLOCK_OPEN.length;
  const closeIdx = output.indexOf(JSON_BLOCK_CLOSE, start);
  const jsonStr = closeIdx === -1
    ? output.slice(start).trim()
    : output.slice(start, closeIdx).trim();

  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

/**
 * Extract all JSON blocks from a Bob response string.
 * Returns an array of parsed objects (skipping any that fail to parse).
 */
export function extractAllJsonBlocks(output: string): unknown[] {
  const results: unknown[] = [];
  let searchFrom = 0;

  while (true) {
    const openIdx = output.indexOf(JSON_BLOCK_OPEN, searchFrom);
    if (openIdx === -1) break;

    const start = openIdx + JSON_BLOCK_OPEN.length;
    const closeIdx = output.indexOf(JSON_BLOCK_CLOSE, start);
    const jsonStr = closeIdx === -1
      ? output.slice(start).trim()
      : output.slice(start, closeIdx).trim();

    try {
      results.push(JSON.parse(jsonStr));
    } catch {
      // skip malformed block
    }

    searchFrom = closeIdx === -1 ? output.length : closeIdx + JSON_BLOCK_CLOSE.length;
  }

  return results;
}

/**
 * Extract the LAST parseable JSON block. Bob may echo the template or emit
 * intermediate drafts before its final answer, so the last block wins.
 */
export function extractLastJsonBlock(output: string): unknown | null {
  const blocks = extractAllJsonBlocks(output);
  return blocks.length > 0 ? blocks[blocks.length - 1]! : null;
}

/**
 * Check whether a Bob response contains the ForgeGuard JSON delimiter.
 */
export function hasJsonBlock(output: string): boolean {
  return output.includes(JSON_BLOCK_OPEN);
}

/**
 * Strip all ForgeGuard JSON blocks from a Bob response, returning only the prose.
 */
export function stripJsonBlocks(output: string): string {
  let result = output;
  while (true) {
    const openIdx = result.indexOf(JSON_BLOCK_OPEN);
    if (openIdx === -1) break;
    const closeIdx = result.indexOf(JSON_BLOCK_CLOSE, openIdx);
    const end = closeIdx === -1 ? result.length : closeIdx + JSON_BLOCK_CLOSE.length;
    result = result.slice(0, openIdx) + result.slice(end);
  }
  return result.trim();
}

/**
 * A streaming line buffer that accumulates Bob output and fires callbacks
 * when complete JSON blocks are detected.
 */
export class StreamingJsonDetector {
  private buffer = '';
  private readonly onJsonBlock: (parsed: unknown) => void;

  constructor(onJsonBlock: (parsed: unknown) => void) {
    this.onJsonBlock = onJsonBlock;
  }

  feed(chunk: string): void {
    this.buffer += chunk;
    // Check if we have a complete JSON block
    while (this.buffer.includes(JSON_BLOCK_OPEN) && this.buffer.includes(JSON_BLOCK_CLOSE)) {
      const parsed = extractJsonBlock(this.buffer);
      if (parsed !== null) {
        this.onJsonBlock(parsed);
      }
      // Remove the consumed block
      const closeIdx = this.buffer.indexOf(JSON_BLOCK_CLOSE);
      this.buffer = this.buffer.slice(closeIdx + JSON_BLOCK_CLOSE.length);
    }
  }

  /** Return any remaining unprocessed buffer content. */
  flush(): string {
    return this.buffer;
  }
}

// ─── Bob Shell `bob run -f stream-json` parser ────────────────────────────────
//
// Bob Shell 2.0.5 headless mode with `--format stream-json` writes one JSON
// object per line (observed in the bobshell bundle's stream-json renderer):
//   {"type":"message","role":"assistant","content":"<delta>","isReasoning":false}
//   {"type":"message","role":"user","content":"..."}
//   {"type":"tool_use","tool_name":"read_file","tool_id":"...","parameters":{...}}
//   {"type":"tool_result","tool_id":"...","status":"success"|"error",...}
//   {"type":"error","severity":"error","message":"..."}
//   {"type":"result","status":"success","stats":{"task_id":"...","duration_ms":...}}
// Assistant `message` content is streamed as deltas.

export interface BobStreamEvent {
  type: string;
  [key: string]: unknown;
}

export interface BobStreamSummary {
  /** Concatenated non-reasoning assistant text. */
  assistantText: string;
  /** Bob's own task ID, from the final `result` event. */
  bobTaskId: string | null;
  /** Status of the final `result` event, or null if none was emitted. */
  resultStatus: string | null;
  /** Messages of every `error` event. */
  errors: string[];
  /** Names of tools Bob invoked, in order. */
  toolCalls: string[];
  /** Number of lines that were not JSON (kept verbatim in raw stdout). */
  unparsedLines: number;
}

export class BobStreamJsonParser {
  private buffer = '';
  private readonly summary: BobStreamSummary = {
    assistantText: '',
    bobTaskId: null,
    resultStatus: null,
    errors: [],
    toolCalls: [],
    unparsedLines: 0,
  };

  constructor(private readonly onAssistantText?: (delta: string) => void) {}

  /** Feed a raw stdout chunk; complete lines are parsed immediately. */
  feed(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      this.handleLine(line);
    }
  }

  /** Parse any trailing partial line and return the summary. */
  finish(): BobStreamSummary {
    if (this.buffer.trim()) this.handleLine(this.buffer);
    this.buffer = '';
    return { ...this.summary, errors: [...this.summary.errors], toolCalls: [...this.summary.toolCalls] };
  }

  private handleLine(rawLine: string): void {
    const line = rawLine.trim();
    if (!line) return;
    let event: BobStreamEvent;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || typeof (parsed as BobStreamEvent).type !== 'string') {
        this.summary.unparsedLines++;
        return;
      }
      event = parsed as BobStreamEvent;
    } catch {
      this.summary.unparsedLines++;
      return;
    }

    switch (event.type) {
      case 'message':
        if (event['role'] === 'assistant' && event['isReasoning'] !== true && typeof event['content'] === 'string') {
          this.summary.assistantText += event['content'];
          this.onAssistantText?.(event['content']);
        }
        break;
      case 'tool_use':
        if (typeof event['tool_name'] === 'string') this.summary.toolCalls.push(event['tool_name']);
        break;
      case 'error':
        this.summary.errors.push(typeof event['message'] === 'string' ? event['message'] : JSON.stringify(event));
        break;
      case 'result': {
        this.summary.resultStatus = typeof event['status'] === 'string' ? event['status'] : 'unknown';
        const stats = event['stats'] as { task_id?: unknown } | undefined;
        if (stats && typeof stats.task_id === 'string') this.summary.bobTaskId = stats.task_id;
        break;
      }
      default:
        break;
    }
  }
}
