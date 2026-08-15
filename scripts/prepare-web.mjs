import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
const www='www';
mkdirSync(join(www,'icons'),{recursive:true});
if(!existsSync(join(www,'manifest.json'))) throw new Error('manifest.json missing');
if(!existsSync(join(www,'sw.js'))) throw new Error('sw.js missing');
console.log('Wavelength web shell ready.');
