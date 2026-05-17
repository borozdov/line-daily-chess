import fs from 'node:fs';
import readline from 'node:readline';
import { Chess } from 'chess.js';

const root = new URL('..', import.meta.url);
const sourceCsv = new URL('../lichess_db_puzzle.csv', root);
const outputJson = new URL('backend/app/seed_puzzles.json', root);

const perKey = new Map();
const maxPerKey = 4;
const targetCount = 90;
const minRating = 2000;
const maxRating = 3000;
const minPopularity = 92;
const maxDeviation = 90;
const minPlays = 1000;
const preferredThemes = [
  'mate',
  'fork',
  'pin',
  'skewer',
  'discoveredAttack',
  'deflection',
  'attraction',
  'clearance',
  'decoy',
  'interference',
  'quietMove',
  'sacrifice',
  'exposedKing',
  'kingsideAttack',
  'advancedPawn',
  'defensiveMove',
  'trappedPiece',
  'xRayAttack',
  'endgame',
  'pawnEndgame',
  'rookEndgame',
  'queenEndgame',
  'middlegame',
  'opening',
];

function toMove(uci) {
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci[4]?.toLowerCase(),
  };
}

function parseRow(line) {
  const parts = line.split(',');
  if (parts.length < 10) return null;
  return {
    externalId: parts[0],
    sourceFen: parts[1],
    moves: parts[2].split(' '),
    rating: Number(parts[3]),
    ratingDeviation: Number(parts[4]),
    popularity: Number(parts[5]),
    nbPlays: Number(parts[6]),
    themes: parts[7] ? parts[7].split(' ') : [],
    gameUrl: parts[8],
    openingTags: parts[9] ? parts[9].split(' ') : [],
  };
}

function primaryTheme(row) {
  return preferredThemes.find((theme) => row.themes.includes(theme));
}

function score(row) {
  const lengthScore = row.moves.length >= 6 ? row.moves.length * 12_000 : 0;
  const openingScore = row.openingTags.length ? 10_000 : 0;
  return (
    row.popularity * 250_000 +
    Math.min(row.nbPlays, 100_000) * 3 +
    lengthScore +
    openingScore -
    row.ratingDeviation * 9_000
  );
}

function buildPuzzle(row) {
  const game = new Chess(row.sourceFen);
  const first = row.moves[0];
  game.move(toMove(first));
  const initialFen = game.fen();

  for (const uci of row.moves.slice(1)) {
    game.move(toMove(uci));
  }

  return {
    external_id: row.externalId,
    source_fen: row.sourceFen,
    initial_fen: initialFen,
    first_move_uci: first,
    solution_uci: row.moves.slice(1),
    rating: row.rating,
    rating_deviation: row.ratingDeviation,
    popularity: row.popularity,
    nb_plays: row.nbPlays,
    themes: row.themes,
    game_url: row.gameUrl,
    opening_tags: row.openingTags,
  };
}

function pushCandidate(row) {
  const bucket = Math.floor(row.rating / 100) * 100;
  const theme = primaryTheme(row);
  const key = `${bucket}:${row.moves.length}:${theme}`;
  const list = perKey.get(key) ?? [];
  list.push({ row, score: score(row) });
  list.sort((a, b) => b.score - a.score);
  if (list.length > maxPerKey) list.length = maxPerKey;
  perKey.set(key, list);
}

const rl = readline.createInterface({
  input: fs.createReadStream(sourceCsv, { encoding: 'utf8' }),
  crlfDelay: Infinity,
});

let lineNumber = 0;
for await (const line of rl) {
  lineNumber += 1;
  if (lineNumber === 1) continue;

  const row = parseRow(line);
  if (!row) continue;
  if (row.rating < minRating || row.rating > maxRating) continue;
  if (row.ratingDeviation > maxDeviation) continue;
  if (row.popularity < minPopularity) continue;
  if (row.nbPlays < minPlays) continue;
  if (![4, 6, 8, 10].includes(row.moves.length)) continue;
  if (row.themes.includes('mateIn1') || row.themes.includes('oneMove')) continue;
  if (!primaryTheme(row)) continue;

  try {
    buildPuzzle(row);
    pushCandidate(row);
  } catch {
    continue;
  }
}

const candidates = [...perKey.values()]
  .flat()
  .sort((a, b) => b.score - a.score);
const buckets = [...new Set(candidates.map(({ row }) => Math.floor(row.rating / 100) * 100))].sort((a, b) => a - b);
const bucketQueues = new Map(
  buckets.map((bucket) => [
    bucket,
    candidates.filter(({ row }) => Math.floor(row.rating / 100) * 100 === bucket),
  ]),
);
const selected = [];
const seen = new Set();
const lengthCounts = new Map();
const themeCounts = new Map();
const lengthLimit = Math.ceil(targetCount / 4) + 6;
const themeLimit = Math.ceil(targetCount / 12) + 4;

let progressed = true;
while (selected.length < targetCount && progressed) {
  progressed = false;

  for (const bucket of buckets) {
    const queue = bucketQueues.get(bucket) ?? [];
    const next = queue.find(({ row }) => {
      const length = row.moves.length;
      const theme = primaryTheme(row);
      return (
        !seen.has(row.externalId) &&
        (lengthCounts.get(length) ?? 0) < lengthLimit &&
        (themeCounts.get(theme) ?? 0) < themeLimit
      );
    });

    if (!next) continue;

    const { row } = next;
    const length = row.moves.length;
    const theme = primaryTheme(row);

    selected.push(row);
    seen.add(row.externalId);
    lengthCounts.set(length, (lengthCounts.get(length) ?? 0) + 1);
    themeCounts.set(theme, (themeCounts.get(theme) ?? 0) + 1);
    progressed = true;

    if (selected.length >= targetCount) break;
  }
}

if (selected.length < targetCount) {
  for (const candidate of candidates) {
    const { row } = candidate;
    if (seen.has(row.externalId)) continue;
    selected.push(row);
    seen.add(row.externalId);
    if (selected.length >= targetCount) break;
  }
}

const seed = selected
  .sort((a, b) => a.rating - b.rating || b.popularity - a.popularity)
  .map((row, index) => ({
    day_index: index,
    daily_id: index + 1,
    ...buildPuzzle(row),
  }));

fs.writeFileSync(outputJson, `${JSON.stringify(seed, null, 2)}\n`, 'utf8');
console.log(`Wrote ${seed.length} puzzles to ${outputJson.pathname}`);
console.log(
  `Filters: rating ${minRating}-${maxRating}, deviation <=${maxDeviation}, popularity >=${minPopularity}, plays >=${minPlays}`,
);
console.log(seed.map((p) => `${p.daily_id}:${p.external_id}:${p.rating}:${p.solution_uci.length + 1}:${p.themes.slice(0, 4).join('/')}`).join('\n'));
