/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Materialize only bounded package snapshots and run fixed Node tests inside disposable memory-backed storage.
 * 2 | maintainer@emeraldcoastsystemsgroup.com | Arm the fixed launcher deadline independently of the controller before accepting any package bytes.
 */
import path from 'node:path';

/** @description One immutable, package-relative source file supplied by trusted catalog composition. */
export interface PackageTestSandboxFile { path: string; content: Buffer }

const MAX_BYTES = 32 * 1024 * 1024;

/** @description Reject path traversal, option inputs and ambiguous filesystem names before staging. */
export function validateSandboxPath(value: string): void {
  if (typeof value !== 'string' || value.length > 256 || !/^[A-Za-z0-9_@./-]+$/.test(value)
    || path.posix.isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('package_test_snapshot_path_invalid');
  }
}

/** @description Freeze a bounded source payload without accepting a shell command or runtime environment. */
export function sandboxPayload(files: PackageTestSandboxFile[], suiteFiles: string[]): string {
  if (!Array.isArray(files) || files.length === 0 || files.length > 4096
    || !Array.isArray(suiteFiles) || suiteFiles.length === 0 || suiteFiles.length > 64) throw new Error('package_test_snapshot_invalid');
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
  return JSON.stringify({ files: snapshot, suiteFiles });
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
  const args=['--test','--test-reporter=tap','--test-concurrency=1','--',...input.suiteFiles.map(file=>path.join(root,file))];
  const child=cp.spawn(process.execPath,args,{cwd:root,env,stdio:['ignore','inherit','inherit']});
  child.on('error',()=>process.exit(2));child.on('close',(code,signal)=>process.exit(code===null?1:code));
 }catch{process.stderr.write('Package test snapshot could not be materialized.\n');process.exit(2);}
});
`;
