#!/usr/bin/env bun
/**
 * Command-line spaced-repetition flash cards for Ukrainian vocabulary.
 *
 * Two files live next to this script:
 *
 *   words.json     authored word list, appended to by hand
 *   progress.json  scheduler state, owned by the app
 *
 * Each word yields two cards, one per direction. Cards are ordered by `due`
 * alone; the clock enters only when a card is rescheduled. Times are Unix
 * seconds.
 */

import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const DAY = 86400;
const FIRST_INTERVAL = DAY; // gap after the first correct answer on a new card
const MISS_INTERVAL = 300; // fixed gap after a wrong or forgotten answer
const GROW = 2.5; // gap multiplier on a correct answer
const HINT_PENALTY = 0.75; // subtracted from GROW per hint used

const HINT_KEY = "?";
const FORGOT_KEY = "!";
const PROMPT = "> ";
const MASK_WIDTH = 20; // blanks shown in a hint, independent of answer length

type Lang = "uk" | "en";
type Direction = "uk-en" | "en-uk";
type Result = "correct" | "wrong" | "forgot";

interface Word {
  id: string;
  uk: string;
  en: string;
  aliases?: string[];
}

interface Review {
  at: number;
  result: Result;
  hints: number;
}

interface CardState {
  last_challenge: number | null;
  due: number;
  history: Review[];
}

interface Progress {
  version: 1;
  cards: Record<string, CardState>;
}

interface Picked {
  key: string;
  word: Word;
  direction: Direction;
  state: CardState;
}

const DIRECTIONS: Record<Direction, { cue: Lang; answer: Lang; label: string }> = {
  "uk-en": { cue: "uk", answer: "en", label: "uk → en" },
  "en-uk": { cue: "en", answer: "uk", label: "en → uk" },
};

const ARTICLES = new Set(["the", "a", "an", "to"]);
const APOSTROPHES = /[’ʼ‘`´]/g;
const NON_WORD = /[^\p{L}\p{N}_\s']/gu;
const STRESS = /́/g; // combining acute accent, used for stress marks in words.json
const CLUSTERS = /\P{M}\p{M}*/gu; // a base character with its combining marks

const HERE = dirname(realpathSync(fileURLToPath(import.meta.url)));

const COLOR = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

function sgr(code: string, text: string): string {
  return COLOR ? `[${code}m${text}[0m` : text;
}

const bold = (text: string): string => sgr("1", text);
const dim = (text: string): string => sgr("2", text);
const red = (text: string): string => sgr("31", text);
const green = (text: string): string => sgr("32", text);
const yellow = (text: string): string => sgr("33", text);
const cyan = (text: string): string => sgr("36", text);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export function normalize(text: string, lang: Lang): string {
  const cleaned = text
    .normalize("NFC")
    .replace(STRESS, "")
    .toLowerCase()
    .replace(APOSTROPHES, "'")
    .replace(NON_WORD, " ");
  const words = cleaned.split(/\s+/).filter((w) => w.length > 0);
  if (lang === "en") {
    while (words.length > 1 && ARTICLES.has(words[0])) {
      words.shift();
    }
  }
  return words.join(" ");
}

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveJson(path: string, data: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

export function loadWords(path: string): Map<string, Word> {
  if (!existsSync(path)) {
    fail(`${path}: not found; create it as a JSON list of {id, uk, en, aliases?} objects`);
  }
  const raw = loadJson(path);
  if (!Array.isArray(raw)) {
    fail(`${path}: expected a JSON list`);
  }
  const byId = new Map<string, Word>();
  raw.forEach((entry: unknown, i: number) => {
    if (!isRecord(entry)) {
      fail(`${path}: entry ${i} is not an object`);
    }
    for (const field of ["id", "uk", "en"] as const) {
      if (!isNonEmptyString(entry[field])) {
        fail(`${path}: entry ${i} is missing a non-empty string '${field}'`);
      }
    }
    const id = entry.id as string;
    const aliases = entry.aliases ?? [];
    if (!isStringArray(aliases)) {
      fail(`${path}: entry '${id}' has a non-list-of-strings 'aliases'`);
    }
    if (byId.has(id)) {
      fail(`${path}: duplicate id '${id}'`);
    }
    byId.set(id, { id, uk: entry.uk as string, en: entry.en as string, aliases });
  });
  return byId;
}

function loadProgress(path: string): Progress {
  if (!existsSync(path)) {
    return { version: 1, cards: {} };
  }
  return loadJson(path) as Progress;
}

export function ingest(words: Map<string, Word>, cards: Record<string, CardState>, now: number): number {
  let added = 0;
  for (const wordId of words.keys()) {
    for (const direction of Object.keys(DIRECTIONS)) {
      const key = `${wordId}:${direction}`;
      if (!(key in cards)) {
        cards[key] = { last_challenge: null, due: now, history: [] };
        added += 1;
      }
    }
  }
  return added;
}

export function isNew(state: CardState): boolean {
  return state.last_challenge === null;
}

function splitKey(key: string): { wordId: string; direction: Direction } {
  const sep = key.lastIndexOf(":");
  return { wordId: key.slice(0, sep), direction: key.slice(sep + 1) as Direction };
}

/** Picks the eligible card with the earliest due time; ties are broken uniformly at random. */
export function selectCard(
  words: Map<string, Word>,
  cards: Record<string, CardState>,
  directions: ReadonlySet<Direction>,
  random: () => number = Math.random,
): Picked | null {
  let earliest: Picked[] = [];
  for (const [key, state] of Object.entries(cards)) {
    if (earliest.length > 0 && state.due > earliest[0].state.due) continue;
    const { wordId, direction } = splitKey(key);
    if (!directions.has(direction)) continue;
    const word = words.get(wordId);
    if (word === undefined) continue;
    const picked = { key, word, direction, state };
    if (earliest.length === 0 || state.due < earliest[0].state.due) {
      earliest = [picked];
    } else {
      earliest.push(picked);
    }
  }
  if (earliest.length === 0) return null;
  return earliest[Math.floor(random() * earliest.length)];
}

export function nextInterval(state: CardState, result: Result, hints: number): number {
  if (result !== "correct") {
    return MISS_INTERVAL;
  }
  const base = isNew(state) ? FIRST_INTERVAL / GROW : state.due - (state.last_challenge as number);
  return base * Math.max(1, GROW - HINT_PENALTY * hints);
}

export function reschedule(state: CardState, result: Result, hints: number, now: number): number {
  const gap = nextInterval(state, result, hints);
  state.last_challenge = now;
  state.due = now + gap;
  state.history.push({ at: now, result, hints });
  return gap;
}

function acceptedAnswers(word: Word, answerLang: Lang): Set<string> {
  const answers = new Set([normalize(word[answerLang], answerLang)]);
  for (const alias of word.aliases ?? []) {
    answers.add(normalize(alias, answerLang));
  }
  return answers;
}

/** Shows the first `revealed` letters, then pads with blanks to a fixed width so length is not disclosed. */
export function mask(answer: string, revealed: number): string {
  let shown = 0;
  const out: string[] = [];
  for (const cluster of answer.normalize("NFC").match(CLUSTERS) ?? []) {
    if (shown >= revealed) break;
    if (/\s/.test(cluster)) {
      out.push("  ");
    } else {
      out.push(`${cluster} `);
      shown += 1;
    }
  }
  while (out.length < MASK_WIDTH) {
    out.push("_ ");
  }
  return out.join("").trimEnd();
}

export function letterCount(answer: string): number {
  let n = 0;
  for (const cluster of answer.normalize("NFC").match(CLUSTERS) ?? []) {
    if (!/\s/.test(cluster)) n += 1;
  }
  return n;
}

export function humanize(seconds: number): string {
  if (seconds < 3600) return `${(seconds / 60).toFixed(0)} min`;
  if (seconds < 2 * DAY) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / DAY).toFixed(1)} d`;
}

class Prompt {
  // The prompt is written directly rather than via rl.prompt(): under Bun,
  // a second rl.prompt() call keeps the process alive after stdin closes.
  // `prompt` is still passed so line redraws in terminal mode stay aligned.
  private readonly rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true,
    prompt: PROMPT,
  });
  private readonly lines = this.rl[Symbol.asyncIterator]();

  constructor() {
    this.rl.on("SIGINT", () => {
      console.log();
      process.exit(0);
    });
  }

  /** Returns the next input line, or null when stdin is closed. */
  async ask(): Promise<string | null> {
    process.stdout.write(PROMPT);
    const next = await this.lines.next();
    // Bun's terminal-mode iterator yields an undefined value on Ctrl-D
    // instead of finishing, so treat both as end of input.
    return next.done || next.value === undefined ? null : next.value;
  }

  close(): void {
    this.rl.close();
  }
}

/** Runs one card interactively. Returns null when stdin is closed. */
async function challenge(
  prompt: Prompt,
  word: Word,
  direction: Direction,
): Promise<{ result: Result; hints: number } | null> {
  const { cue, answer: answerLang, label } = DIRECTIONS[direction];
  const answer = word[answerLang];
  const accepted = acceptedAnswers(word, answerLang);
  const total = letterCount(answer);
  let hints = 0;

  console.log(`\n${dim(`[${label}]`)}  ${bold(cyan(word[cue]))}`);
  for (;;) {
    const raw = await prompt.ask();
    if (raw === null) {
      console.log();
      return null;
    }
    const line = raw.trim();
    if (line === HINT_KEY) {
      hints += 1;
      if (hints >= total) {
        console.log(`  ${bold(red("forgot:"))} ${bold(answer)}`);
        return { result: "forgot", hints };
      }
      console.log(`  ${yellow(mask(answer, hints))}`);
      continue;
    }
    if (line === FORGOT_KEY) {
      console.log(`  ${bold(red("forgot:"))} ${bold(answer)}`);
      return { result: "forgot", hints };
    }
    if (line.length === 0) {
      console.log(dim(`  type the answer, ${HINT_KEY} for a hint, ${FORGOT_KEY} if you forgot`));
      continue;
    }
    if (accepted.has(normalize(line, answerLang))) {
      console.log(`  ${bold(green("correct"))}`);
      return { result: "correct", hints };
    }
    console.log(`  ${bold(red("wrong:"))} ${bold(answer)}`);
    return { result: "wrong", hints };
  }
}

function nowSeconds(): number {
  return Date.now() / 1000;
}

const MODES: Record<string, ReadonlySet<Direction>> = {
  "uk-en": new Set<Direction>(["uk-en"]),
  "en-uk": new Set<Direction>(["en-uk"]),
  both: new Set<Direction>(["uk-en", "en-uk"]),
};

const CHART = "chart";

const MENU: ReadonlyArray<[key: string, mode: string, label: string]> = [
  ["1", "uk-en", DIRECTIONS["uk-en"].label],
  ["2", "en-uk", DIRECTIONS["en-uk"].label],
  ["3", "both", "both"],
  ["4", CHART, "when cards are due"],
];

const CHART_BUCKETS: ReadonlyArray<[label: string, withinSeconds: number]> = [
  ["due now", 0],
  ["≤ 10 min", 600],
  ["≤ 1 h", 3600],
  ["≤ 6 h", 6 * 3600],
  ["≤ 1 d", DAY],
  ["≤ 1 w", 7 * DAY],
];
const CHART_BAR_WIDTH = 40;

/** Prints, per direction, how many cards fall due in each time window. */
function printDueChart(words: Map<string, Word>, cards: Record<string, CardState>, now: number): void {
  for (const direction of Object.keys(DIRECTIONS) as Direction[]) {
    const waits = Object.entries(cards)
      .filter(([key]) => {
        const parts = splitKey(key);
        return parts.direction === direction && words.has(parts.wordId);
      })
      .map(([, state]) => state.due - now);
    const rows: Array<[string, number]> = CHART_BUCKETS.map(([label, upper], i) => {
      const lower = i === 0 ? -Infinity : CHART_BUCKETS[i - 1][1];
      return [label, waits.filter((w) => w > lower && w <= upper).length];
    });
    rows.push(["later", waits.filter((w) => w > CHART_BUCKETS[CHART_BUCKETS.length - 1][1]).length]);
    const scale = Math.max(1, ...rows.map(([, n]) => n));
    const labelWidth = Math.max(...rows.map(([label]) => label.length));

    console.log(`\n${bold(DIRECTIONS[direction].label)}  ${dim(`${waits.length} cards`)}`);
    for (const [label, n] of rows) {
      const bar = "█".repeat(Math.round((n / scale) * CHART_BAR_WIDTH));
      console.log(`  ${label.padEnd(labelWidth)}  ${cyan(bar)}${bar ? " " : ""}${bold(String(n))}`);
    }
  }
  console.log();
}

/** Shows the home screen. Returns the chosen directions, or null when stdin is closed. */
async function chooseDirections(
  prompt: Prompt,
  words: Map<string, Word>,
  cards: Record<string, CardState>,
): Promise<ReadonlySet<Direction> | null> {
  const showMenu = (): void => {
    console.log(bold("ukralearn"));
    for (const [key, , label] of MENU) {
      console.log(`  ${bold(cyan(key))}  ${label}`);
    }
  };
  showMenu();
  for (;;) {
    const raw = await prompt.ask();
    if (raw === null) {
      console.log();
      return null;
    }
    const entry = MENU.find(([key]) => key === raw.trim());
    if (entry === undefined) {
      console.log(dim(`  press ${MENU.map(([key]) => key).join(", ")} or Ctrl-D`));
      continue;
    }
    if (entry[1] === CHART) {
      printDueChart(words, cards, nowSeconds());
      showMenu();
      continue;
    }
    return MODES[entry[1]];
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      words: { type: "string", default: join(HERE, "words.json") },
      progress: { type: "string", default: join(HERE, "progress.json") },
      direction: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(
      "usage: ukralearn [--words PATH] [--progress PATH] [--direction MODE]\n\n" +
        "Ukrainian flash cards with spaced repetition.\n" +
        "  --direction MODE  skip the home screen; MODE is uk-en, en-uk or both",
    );
    return;
  }
  if (values.direction !== undefined && !(values.direction in MODES)) {
    fail(`--direction: expected one of ${Object.keys(MODES).join(", ")}, got '${values.direction}'`);
  }

  const words = loadWords(values.words as string);
  const progressPath = values.progress as string;
  const progress = loadProgress(progressPath);
  const cards = progress.cards;

  const now = nowSeconds();
  if (ingest(words, cards, now) > 0) {
    saveJson(progressPath, progress);
  }

  const prompt = new Prompt();
  try {
    const directions =
      values.direction !== undefined ? MODES[values.direction] : await chooseDirections(prompt, words, cards);
    if (directions === null) {
      return;
    }

    const live = Object.entries(cards)
      .filter(([key]) => {
        const { wordId, direction } = splitKey(key);
        return directions.has(direction) && words.has(wordId);
      })
      .map(([, state]) => state);
    const newCount = live.filter(isNew).length;
    const dueCount = live.filter((s) => !isNew(s) && s.due <= now).length;
    console.log(
      `${dim("cards:")} ${bold(String(live.length))}  ${dim("due:")} ${bold(String(dueCount))}  ` +
        `${dim("new:")} ${bold(String(newCount))}  ${dim("(Ctrl-D to quit)")}`,
    );

    let continueAnyway = false;
    for (;;) {
      const picked = selectCard(words, cards, directions);
      if (picked === null) {
        console.log(dim("nothing left to show this session"));
        return;
      }
      const wait = picked.state.due - nowSeconds();
      if (wait > 0 && !continueAnyway) {
        console.log(`\n${bold("nothing due right now")}  ${dim(`next card in ${humanize(wait)}`)}`);
        console.log(dim("  Enter to continue anyway, Ctrl-D to quit"));
        if ((await prompt.ask()) === null) {
          console.log();
          return;
        }
        continueAnyway = true;
      }
      const outcome = await challenge(prompt, picked.word, picked.direction);
      if (outcome === null) {
        return;
      }
      const gap = reschedule(picked.state, outcome.result, outcome.hints, nowSeconds());
      saveJson(progressPath, progress);
      console.log(dim(`  next in ${humanize(gap)}`));
    }
  } finally {
    prompt.close();
  }
}

if (import.meta.main) {
  await main();
}
