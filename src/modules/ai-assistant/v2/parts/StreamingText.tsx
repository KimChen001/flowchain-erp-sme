import type { ReactNode } from "react";
import { A } from "../../../../components/ui";
import { RefChip, usePartCopy, type Navigate, type PartCopy } from "./partKit";
import type { FlagSpan, PartRef } from "./types";

// The model's prose, as it streams. Only a small part of markdown is read:
// paragraphs, section headings (any level, all shown alike), numbered and
// bulleted lists, pipe tables (the first row as the header), quoted blocks
// ("> " lines, as a drafted message is written), fenced code blocks, bold
// and inline code. Images are
// dropped and links keep only their text, so nothing in an answer can load
// from or send a click to another site; the only links are record chips for
// the refs the server gave this answer.

type Block = { kind: "p" | "h" | "ol" | "ul" | "table" | "quote" | "pre"; start: number; lines: string[] };
const QUOTE_LINE = /^>\s?/;
const FENCE = /^```/;
const LIST_LINE = /^(?:(\d{1,3})[.)]\s+|[-*+•]\s+)/;
const HEADING = /^#{1,6}\s+/;
// A table row is a line between pipes; the line of dashes under the header
// is dropped.
const TABLE_ROW = /^\|.*\|$/;
const TABLE_RULE = /^\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?$/;
const tableCells = (line: string) => line.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());

function markdownBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  // A quote runs over its "> " lines; a fence keeps its lines as written.
  let quote: Block | null = null;
  let fence: Block | null = null;
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "p", start: 1, lines: [paragraph.join(" ")] });
    paragraph = [];
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (fence) {
      if (FENCE.test(line)) fence = null;
      else fence.lines.push(raw.replace(/\s+$/, ""));
      continue;
    }
    if (FENCE.test(line)) { flush(); quote = null; fence = { kind: "pre", start: 1, lines: [] }; blocks.push(fence); continue; }
    if (QUOTE_LINE.test(line)) {
      flush();
      if (!quote) { quote = { kind: "quote", start: 1, lines: [] }; blocks.push(quote); }
      quote.lines.push(line.replace(QUOTE_LINE, ""));
      continue;
    }
    quote = null;
    if (!line) { flush(); continue; }
    if (HEADING.test(line)) { flush(); blocks.push({ kind: "h", start: 1, lines: [line.replace(HEADING, "")] }); continue; }
    if (TABLE_ROW.test(line)) {
      flush();
      const last = blocks[blocks.length - 1];
      if (TABLE_RULE.test(line)) continue;
      if (last && last.kind === "table") last.lines.push(line);
      else blocks.push({ kind: "table", start: 1, lines: [line] });
      continue;
    }
    const match = line.match(LIST_LINE);
    if (!match) { paragraph.push(line); continue; }
    flush();
    const kind = match[1] ? "ol" : "ul";
    const content = line.slice(match[0].length);
    const last = blocks[blocks.length - 1];
    if (last && last.kind === kind) last.lines.push(content);
    else blocks.push({ kind, start: Number(match[1]) || 1, lines: [content] });
  }
  flush();
  return blocks;
}

// Images go entirely, a link keeps its text, a bare web address is removed.
function withoutImagesAndLinks(text: string) {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)?/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)?/g, "$1")
    .replace(/<\s*(?:https?:\/\/|www\.)[^>]*>/gi, "")
    .replace(/\b(?:https?:\/\/|www\.)[^\s<>()]+/gi, "")
    .replace(/[ \t]{2,}/g, " ");
}

// Record codes (PO-020, SKU-1007), not names, become chips.
const RECORD_CODE = /^(?=\S*\d)(?=\S*[A-Za-z])[A-Za-z0-9][A-Za-z0-9._/-]{2,39}$/;
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const bounded = (value: string) => `${/^[A-Za-z0-9]/.test(value) ? "(?<![A-Za-z0-9-])" : ""}${escapeRegExp(value)}${/[A-Za-z0-9]$/.test(value) ? "(?![A-Za-z0-9-])" : ""}`;

type Decorator = { pattern: RegExp | null; refs: Map<string, PartRef>; flags: Map<string, FlagSpan>; chipped: Set<string> };

function decorator(refs: PartRef[], flags: FlagSpan[]): Decorator {
  const refMap = new Map<string, PartRef>();
  for (const ref of refs) if (RECORD_CODE.test(ref.label) && !refMap.has(ref.label.toUpperCase())) refMap.set(ref.label.toUpperCase(), ref);
  const flagMap = new Map<string, FlagSpan>();
  for (const span of flags) if (span.text.trim() && !flagMap.has(span.text.toUpperCase())) flagMap.set(span.text.toUpperCase(), span);
  const terms = [...new Set([...[...refMap.values()].map((ref) => ref.label), ...[...flagMap.values()].map((span) => span.text)])].sort((a, b) => b.length - a.length);
  return { pattern: terms.length ? new RegExp(terms.map(bounded).join("|"), "gi") : null, refs: refMap, flags: flagMap, chipped: new Set() };
}

function decorate(text: string, d: Decorator, copy: PartCopy, onNavigate: Navigate | undefined, key: string): ReactNode[] {
  if (!d.pattern || !text) return [text];
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(d.pattern)) {
    if (match.index === undefined) continue;
    const word = match[0];
    const ref = d.refs.get(word.toUpperCase());
    const flag = d.flags.get(word.toUpperCase());
    if (match.index > last) out.push(text.slice(last, match.index));
    // One chip per record: later mentions read as plain text.
    if (ref && !d.chipped.has(ref.label.toUpperCase())) {
      d.chipped.add(ref.label.toUpperCase());
      out.push(<span key={`${key}-${match.index}`}><RefChip value={ref} onNavigate={onNavigate}>{word}</RefChip></span>);
    } else if (!ref && flag) {
      out.push(<span key={`${key}-${match.index}`} data-testid="ai-flag" data-flag-kind={flag.kind} title={copy.t("ai.v2.notMatched")} className="underline decoration-dotted underline-offset-2" style={{ textDecorationColor: A.gray1 }}>{word}</span>);
    } else out.push(word);
    last = match.index + word.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Bold and inline code. A marker left open while the text streams is hidden
// rather than shown as an asterisk or a backtick.
function inline(text: string, d: Decorator, copy: PartCopy, onNavigate: Navigate | undefined, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const tokens = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__)/);
  tokens.forEach((token, index) => {
    if (!token) return;
    const id = `${key}-${index}`;
    if (/^`[^`]+`$/.test(token)) out.push(<code key={id} className="rounded px-1 text-[12.5px]" style={{ background: A.gray5 }}>{token.slice(1, -1)}</code>);
    else if (/^(\*\*|__)[^]*\1$/.test(token) && token.length > 4) out.push(<strong key={id} className="font-semibold">{decorate(token.slice(2, -2), d, copy, onNavigate, id)}</strong>);
    else out.push(...decorate(token.replace(/\*\*|`/g, ""), d, copy, onNavigate, id));
  });
  return out;
}

export function StreamingText({ text, refs = [], flags = [], language, onNavigate }: { text: string; refs?: PartRef[]; flags?: FlagSpan[]; language?: string; onNavigate?: Navigate }) {
  const copy = usePartCopy(language);
  const d = decorator(refs, flags);
  const line = (value: string, key: string) => inline(value, d, copy, onNavigate, key);
  const render = (blocks: Block[], prefix: string): ReactNode[] => blocks.map((block, at) => {
    const index = `${prefix}${at}`;
    // A drafted message: its own blocks, set off from the answer.
    if (block.kind === "quote") return <blockquote key={index} data-testid="ai-v2-text-quote" className="space-y-2 rounded-r-lg border-l-2 py-1 pl-3" style={{ borderColor: A.gray4, background: A.gray6 }}>{render(markdownBlocks(block.lines.join("\n")), `${index}-`)}</blockquote>;
    if (block.kind === "pre") return <pre key={index} data-testid="ai-v2-text-pre" className="whitespace-pre-wrap rounded-lg px-3 py-2 text-[12.5px]" style={{ background: A.gray6 }}>{block.lines.join("\n")}</pre>;
    return renderBlock(block, index);
  });
  const renderBlock = (block: Block, index: string): ReactNode => block.kind === "p"
        ? <p key={index}>{line(block.lines[0], `${index}`)}</p>
        : block.kind === "h"
          ? <p key={index} data-testid="ai-v2-text-heading" className="pt-1 font-semibold">{line(block.lines[0], `${index}`)}</p>
          : block.kind === "table"
          ? (
            <div key={index} className="overflow-x-auto">
              <table data-testid="ai-v2-text-table" className="w-full border-collapse text-xs">
                <thead><tr>{tableCells(block.lines[0]).map((cell, column) => <th key={column} className="border-b px-2 py-1 text-left font-semibold" style={{ borderColor: A.gray4 }}>{line(cell, `${index}-h-${column}`)}</th>)}</tr></thead>
                <tbody>{block.lines.slice(1).map((row, rowIndex) => <tr key={rowIndex}>{tableCells(row).map((cell, column) => <td key={column} className="border-b px-2 py-1 align-top" style={{ borderColor: A.gray5 }}>{line(cell, `${index}-${rowIndex}-${column}`)}</td>)}</tr>)}</tbody>
              </table>
            </div>
          )
          : block.kind === "ol"
          ? <ol key={index} start={block.start} className="list-decimal space-y-1 pl-5">{block.lines.map((value, row) => <li key={row}>{line(value, `${index}-${row}`)}</li>)}</ol>
          : <ul key={index} className="list-disc space-y-1 pl-5">{block.lines.map((value, row) => <li key={row}>{line(value, `${index}-${row}`)}</li>)}</ul>;
  return (
    <div data-testid="ai-v2-text" lang={copy.language} className="space-y-2 text-sm leading-relaxed" style={{ color: A.label }}>
      {render(markdownBlocks(withoutImagesAndLinks(text)), "")}
    </div>
  );
}
