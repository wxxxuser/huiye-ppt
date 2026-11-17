import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { makeSampleDeck } from '../src/sample';
import { buildPptx } from '../src/export-pptx';

const directory = resolve('examples');
await mkdir(directory, { recursive: true });
const sample = makeSampleDeck();
await writeFile(resolve(directory, 'huiye-demo.huiye.json'), JSON.stringify(sample, null, 2) + '\n', 'utf8');
await writeFile(resolve(directory, 'huiye-demo.pptx'), await buildPptx(sample));
console.log('Generated examples/huiye-demo.pptx and huiye-demo.huiye.json (fictional sample, zero AI calls).');
