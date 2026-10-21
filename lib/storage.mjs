import {rename} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
// OneDrive and antivirus scanners can briefly hold the destination on Windows.
// Retry the same atomic replacement, never delete the old destination first.
export async function replaceFile(source,target,{renameImpl=rename,delayImpl=delay}={}) {
  for(let attempt=0;;attempt++) {
    try{return await renameImpl(source,target);}
    catch(error){if(attempt>=4||!['EPERM','EBUSY','EACCES'].includes(error.code))throw error;await delayImpl(50*2**attempt);}
  }
}
