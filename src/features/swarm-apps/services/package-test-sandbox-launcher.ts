/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Materialize only bounded package snapshots and run fixed Node tests inside disposable memory-backed storage.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Arm the fixed launcher deadline independently of the controller before accepting any package bytes.
 * 3 | maintainer@emeraldcoastsystemsgroup.com | Add the browser profile: the launcher points Playwright at the image's system Chromium through a registry shim on the writable tmpfs, so Node-harness browser recipes run in the same closed container.
 * 4 | maintainer@emeraldcoastsystemsgroup.com | Add the vitest profile: the launcher runs the image's own globally installed vitest CLI over the staged suite with a TAP reporter, inside the same closed container — no network, no mounts, no daemon socket.
 * 5 | maintainer@emeraldcoastsystemsgroup.com | Name the core test fixtures the image carries at OSHAL_CORE_ROOT for browser recipes that declare harness:core-test-fixtures. Three store browser cases require tests/fixtures/isolated-browser.ts and tests/fixtures/stl-viewer.ts from the core root through tsx, and the image shipped no tests/ at all; this is the measured closure (two files, no relative imports, runtime dependencies only), fixed and controller-owned like VITEST_CLI, so the probe asks the image about exactly this set and the Dockerfile COPY is held to it.
 */
import path from 'node:path';

/** @description One immutable, package-relative source file supplied by trusted catalog composition. */
export interface PackageTestSandboxFile { path: string; content: Buffer }

/** @description Which closed container profile a payload asks for. `browser` adds Chromium and `vitest`
 * adds the image's own vitest CLI; neither adds a network, a mount or the daemon socket. */
export type PackageTestSandboxProfile = 'node' | 'browser' | 'vitest';

/** @description Every profile the launcher knows how to start, so an unknown name is refused before staging. */
export const SANDBOX_PROFILES: readonly PackageTestSandboxProfile[] = ['node', 'browser', 'vitest'];

/** @description Where the image installs the vitest CLI globally. Fixed and controller-owned: a package never
 * supplies a runner path, and the launcher refuses the profile outright when this file is absent. */
export const VITEST_CLI = '/usr/local/lib/node_modules/vitest/vitest.mjs';

/** @description The core test fixtures a browser recipe may require from OSHAL_CORE_ROOT (`harness:core-test-fixtures`):
 * the shared isolated-browser launcher and the STL viewer helpers, loaded through the image's tsx CommonJS hook exactly
 * as the store specs load them. This is the whole measured closure — no relative imports, runtime dependencies only —
 * and Dockerfile.oshal copies exactly these paths to /app/tests/fixtures/; the probe advertises the prerequisite only
 * after loading every one of them on the image. Nothing else from tests/ reaches the image. */
export const CORE_TEST_FIXTURES: readonly string[] = ['tests/fixtures/isolated-browser.ts', 'tests/fixtures/stl-viewer.ts'];

const MAX_BYTES = 32 * 1024 * 1024;

/** @description Reject path traversal, option inputs and ambiguous filesystem names before staging. */
export function validateSandboxPath(value: string): void {
  if (typeof value !== 'string' || value.length > 256 || !/^[A-Za-z0-9_@./-]+$/.test(value)
    || path.posix.isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('package_test_snapshot_path_invalid');
  }
}

/** @description Freeze a bounded source payload without accepting a shell command or runtime environment. */
export function sandboxPayload(files: PackageTestSandboxFile[], suiteFiles: string[], profile: PackageTestSandboxProfile = 'node'): string {
  if (!Array.isArray(files) || files.length === 0 || files.length > 4096
    || !Array.isArray(suiteFiles) || suiteFiles.length === 0 || suiteFiles.length > 64) throw new Error('package_test_snapshot_invalid');
  if (!SANDBOX_PROFILES.includes(profile)) throw new Error('package_test_profile_invalid');
  const names = new Set<string>(); let bytes = 0;
  const snapshot = files.map(file => {
    validateSandboxPath(file.path);
    if (names.has(file.path) || !Buffer.isBuffer(file.content) || file.content.length > 8 * 1024 * 1024) throw new Error('package_test_snapshot_invalid');
    names.add(file.path); bytes += file.content.length;
    if (bytes > MAX_BYTES) throw new Error('package_test_snapshot_too_large');
    return { path: file.path, content: file.content.toString('base64') };
  });
  if (new Set(suiteFiles).size !== suiteFiles.length) throw new Error('package_test_suites_invalid');
  for (const file of suiteFiles) { validateSandboxPath(file); if (!names.has(file) || !/\.[cm]?js$/.test(file)) throw new Error('package_test_suites_invalid'); }
  return JSON.stringify({ files: snapshot, suiteFiles, profile });
}

/**
 * @description Fixed controller-owned launcher. Package bytes are stdin data, never executable CLI text.
 * The child receives only deterministic test settings and can write only disposable tmpfs mounts.
 */
export const PACKAGE_TEST_LAUNCHER = String.raw`
'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const env={PATH:'/usr/local/bin:/usr/bin:/bin',HOME:'/tmp',TMPDIR:'/tmp',NODE_ENV:'test',CI:'true',OSHAL_CORE_ROOT:'/app',NODE_PATH:'/app/node_modules'};
for(const key of Object.keys(process.env))delete process.env[key];
Object.assign(process.env,env);
const deadline=Number(process.argv[1]),remaining=deadline-Date.now();
if(!Number.isSafeInteger(deadline)||remaining<=0||remaining>300000)process.exit(124);
setTimeout(()=>process.exit(124),remaining);
let size=0;const chunks=[];
process.stdin.on('data',chunk=>{size+=chunk.length;if(size>48*1024*1024)process.exit(2);chunks.push(chunk);});
process.stdin.on('end',()=>{
 try{
  const input=JSON.parse(Buffer.concat(chunks).toString('utf8')),root='/work/package';
  if(!Array.isArray(input.files)||!Array.isArray(input.suiteFiles)||input.files.length>4096||input.suiteFiles.length>64)throw Error();
  const names=new Set();let bytes=0;
  fs.mkdirSync(root,{recursive:true});
  for(const file of input.files){
   if(typeof file.path!=='string'||file.path.length>256||!/^[A-Za-z0-9_@./-]+$/.test(file.path)||file.path.split('/').some(p=>!p||p==='.'||p==='..')||names.has(file.path))throw Error();
   const content=Buffer.from(file.content,'base64');bytes+=content.length;if(content.length>8*1024*1024||bytes>32*1024*1024)throw Error();
   const target=path.join(root,file.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,content,{flag:'wx',mode:0o600});names.add(file.path);
  }
  if(!input.suiteFiles.length||input.suiteFiles.some(file=>!names.has(file)||!/[.][cm]?js$/.test(file)))throw Error();
  if(input.profile!==undefined&&!['node','browser','vitest'].includes(input.profile))throw Error();
  if(input.profile==='browser'){
   // Playwright resolves its browser from a registry directory; point that directory at a writable
   // tmpfs and lay the image's system Chromium under the exact paths Playwright expects. No download,
   // no network, no package-supplied path: the executable is always /usr/bin/chromium from the image.
   if(!fs.existsSync('/usr/bin/chromium')){process.stderr.write('Browser runner is unavailable in this image.\n');process.exit(3);}
   const browsers='/tmp/pw';fs.mkdirSync(browsers,{recursive:true,mode:0o700});process.env.PLAYWRIGHT_BROWSERS_PATH=browsers;
   const {registry}=require('/app/node_modules/playwright-core/lib/server/registry/index.js');
   for(const name of ['chromium','chromium-headless-shell']){const target=registry.findExecutable(name).executablePath();if(!target)continue;fs.mkdirSync(path.dirname(target),{recursive:true});if(!fs.existsSync(target))fs.symlinkSync('/usr/bin/chromium',target);}
   Object.assign(env,{PLAYWRIGHT_BROWSERS_PATH:browsers,PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS:'1',PLAYWRIGHT_SKIP_BROWSER_GC:'1',OSHAL_CHROMIUM_EXECUTABLE:'/usr/bin/chromium'});
  }
  let args=['--test','--test-reporter=tap','--test-concurrency=1','--',...input.suiteFiles.map(file=>path.join(root,file))];
  if(input.profile==='vitest'){
   // The image installs vitest globally; the launcher runs that fixed CLI over the staged suite and asks for a
   // per-test TAP stream, so the controller reads what vitest actually reported. No network, no mount, no socket.
   const cli='${VITEST_CLI}';
   if(!fs.existsSync(cli)){process.stderr.write('Vitest runner is unavailable in this image.\n');process.exit(3);}
   env.NODE_PATH='/app/node_modules:/usr/local/lib/node_modules';
   args=[cli,'run','--root',root,'--reporter=tap-flat','--no-color','--pool=forks','--no-file-parallelism',...input.suiteFiles];
  }
  const child=cp.spawn(process.execPath,args,{cwd:root,env,stdio:['ignore','inherit','inherit']});
  child.on('error',()=>process.exit(2));child.on('close',(code,signal)=>process.exit(code===null?1:code));
 }catch{process.stderr.write('Package test snapshot could not be materialized.\n');process.exit(2);}
});
`;
