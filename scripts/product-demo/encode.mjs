// Encode real screenshots from the isolated fixture into short demo sequences.
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const root = fileURLToPath(new URL('../../', import.meta.url));
const assets = 'website/public/assets/';
const frames = 'scripts/product-demo/frames/';
const scenes = {
  chart: [[assets+'chart.png',1.8],[frames+'chart-price.png',2.3],[frames+'chart-amount.png',4.1],[frames+'chart-order.png',3.8]],
  wallet: [[assets+'chart.png',1.2],[assets+'wallet.png',5],[assets+'chart.png',1.2],[assets+'wallet.png',3]],
  tokens: [[assets+'chart.png',1],[assets+'tokens.png',3],[frames+'tokens-search.png',3],[assets+'tokens.png',2]],
};
for (const [name, sequence] of Object.entries(scenes)) {
  const lines = sequence.flatMap(([file,duration]) => [`file '${path.join(root,file).replaceAll('\\','/')}'`,`duration ${duration}`]);
  lines.push(`file '${path.join(root,sequence.at(-1)[0]).replaceAll('\\','/')}'`);
  const input = path.join(os.tmpdir(),`dekxdis-${name}-frames.txt`);
  writeFileSync(input,lines.join('\n'));
  const result = spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','concat','-safe','0','-i',input,'-vf','fps=24','-c:v','libx264','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',path.join(root,assets,name+'.mp4')],{stdio:'inherit'});
  if (result.status !== 0) throw new Error(`Encoding ${name} failed`);
}
