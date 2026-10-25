// Downloads the community MIDI transcriptions of Windmill Hut from vgmusic.com into songs/reference/.
// They are not committed to this repository; run `npm run fetch-reference` once after cloning.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'songs/reference');
const FILES = {
  'windmill-hut-vgmusic.mid': 'https://www.vgmusic.com/music/console/nintendo/n64/Windmill.mid',
  'windmill-hut-kuzma-vgmusic.mid': 'https://www.vgmusic.com/music/console/nintendo/n64/z64inwml.mid',
};
fs.mkdirSync(dir, { recursive: true });
for (const [name, url] of Object.entries(FILES)) {
  const out = path.join(dir, name);
  if (fs.existsSync(out)) { console.log('exists', name); continue; }
  const res = await fetch(url);
  if (!res.ok) { console.error('failed', url, res.status); process.exitCode = 1; continue; }
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  console.log('saved', name);
}
