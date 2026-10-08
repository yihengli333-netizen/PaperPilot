import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
const root=fileURLToPath(new URL('../',import.meta.url));
const suites=[['typecheck','node_modules/typescript/bin/tsc','--noEmit'],['build','build.mjs'],
  ['pure','test/run.mjs'],['integration','test/integration.mjs'],['regressions','test/regressions.mjs'],
  ['v02','test/v02.mjs'],['fixes','--test','test/fixes.test.mjs'],
  ['python','tools/python.mjs','test/test_pdf_backend.py']];
const results=[];
for(const [name,...args] of suites) {
  const r=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',windowsHide:true});
  const output=(r.stdout || '')+(r.stderr || '')+(r.error ? String(r.error) : '');
  process.stdout.write(output);
  results.push({name,exitCode:r.status,output});
}
fs.writeFileSync(new URL('all-results.json',import.meta.url),JSON.stringify(results,null,2));
const failed=results.filter(r=>r.exitCode!==0);
console.log(`Suites: ${results.length-failed.length} passed / ${failed.length} failed`);
process.exitCode=failed.length ? 1 : 0;
