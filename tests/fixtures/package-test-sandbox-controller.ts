/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Run a disposable controller process so crash tests exercise independent container lifetime and recovery.
 */
import { PackageTestSandbox } from '../../src/features/swarm-apps/services/package-test-sandbox';

/** @description Launch only a fixed synthetic hanging suite; test arguments contain no live paths or credentials. */
async function main(): Promise<void> {
  const [image, executionId, mode] = process.argv.slice(2);
  const stopLauncher = mode === 'stop-launcher'
    ? `const fs=require('node:fs');for(const pid of fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p))){
      try{const args=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0');
      if(args[1]==='-e'&&args[2]?.includes('Package test snapshot could not be materialized'))process.kill(Number(pid),'SIGSTOP');}catch{}}
      ` : '';
  const result = await new PackageTestSandbox().run({ image, executionId, timeoutMs: mode === 'stop-launcher' ? 60000 : 8000,
    maxMemoryMb: 256, suiteFiles: ['tests/crash.cjs'], files: [{ path: 'tests/crash.cjs',
      content: Buffer.from(`${stopLauncher}console.log('${executionId}');setInterval(()=>{},1000);`) }] });
  process.stdout.write(JSON.stringify(result));
}

void main().catch(() => { process.exitCode = 1; });
