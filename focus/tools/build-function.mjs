// Copies app/shared.js into the edge function between its SHARED markers.
// Run after changing app/shared.js:   npm run build:function
// (No Node on your PC? Copy shared.js by hand: paste it between the markers
//  in supabase/functions/focus/index.ts and delete the word "export " in front
//  of each function/const.)
import { readFileSync, writeFileSync } from 'node:fs';

const shared = readFileSync(new URL('../app/shared.js', import.meta.url), 'utf8')
  .replace(/^export /gm, '')
  .trim();
const fnPath = new URL('../supabase/functions/focus/index.ts', import.meta.url);
const src = readFileSync(fnPath, 'utf8');
const re = /(\/\/ ===== BEGIN SHARED[^\n]*\n)[\s\S]*?(\/\/ ===== END SHARED =====)/;
if (!re.test(src)) throw new Error('SHARED markers not found in index.ts');
writeFileSync(fnPath, src.replace(re, (_, a, b) => `${a}${shared}\n${b}`));
console.log('Updated supabase/functions/focus/index.ts with app/shared.js');
