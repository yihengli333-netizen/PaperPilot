import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const run=spawnSync(process.execPath,['tools/python.mjs','package-xpi.py'],{
  cwd:fileURLToPath(new URL('.',import.meta.url)),stdio:'inherit',windowsHide:true,
});
if(run.error) throw run.error;
process.exitCode=run.status ?? 1;
