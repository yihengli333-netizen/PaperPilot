import {spawnSync} from 'node:child_process';
import {existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';

// Use the configured interpreter or an installed runtime, avoiding Windows' Store alias.
const candidates=[];
if(process.env.PAPERPILOT_PYTHON) candidates.push([process.env.PAPERPILOT_PYTHON]);
else {
  if(process.platform==='win32' && process.env.USERPROFILE) {
    const backend=join(process.env.USERPROFILE,'.workbuddy','binaries','python','envs','paperpilot','Scripts','python.exe');
    if(existsSync(backend)) candidates.push([backend]);
    const versions=join(process.env.USERPROFILE,'.workbuddy','binaries','python','versions');
    if(existsSync(versions)) {
      for(const version of readdirSync(versions).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}))) {
        const binary=join(versions,version,'python.exe');
        if(existsSync(binary)) candidates.push([binary]);
      }
    }
  }
  candidates.push(...(process.platform==='win32' ? [['py','-3']] : [['python3'],['python']]));
}
let selected;
for(const [binary,...flags] of candidates) {
  const probe=spawnSync(binary,[...flags,'--version'],{encoding:'utf8',timeout:5000,windowsHide:true});
  if(probe.status===0 && /Python 3\./.test(probe.stdout+probe.stderr)) {selected=[binary,...flags];break;}
}
if(!selected) throw new Error('Python 3 未找到。请安装 Python 3，或设置 PAPERPILOT_PYTHON 为解释器的完整路径。');
const [binary,...flags]=selected;
const run=spawnSync(binary,[...flags,'-X','utf8',...process.argv.slice(2)],{stdio:'inherit',windowsHide:true});
if(run.error) throw run.error;
process.exitCode=run.status ?? 1;
