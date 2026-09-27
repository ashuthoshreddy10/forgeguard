/**
 * Writes deterministic replay views (ReplayEngine output) to the frontend test fixtures,
 * so frontend replay tests render exactly what the backend produces.
 * Run: npm run replay:snapshots  (tests/replay.test.ts fails if the file is stale)
 */
import fs from 'fs';
import path from 'path';
import { replaySnapshots } from '../src/replay/snapshots';

const out = path.resolve(__dirname, '../../frontend/src/test/replay-views.json');
fs.writeFileSync(out, `${JSON.stringify(replaySnapshots(), null, 2)}\n`);
console.log(`wrote ${out}`);
