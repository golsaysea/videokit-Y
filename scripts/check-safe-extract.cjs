const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os');
const archiver=require('archiver'),extract=require('../electron/services/safeExtract');
async function zip(file,add){const a=archiver('zip'),out=fs.createWriteStream(file);const done=new Promise((resolve,reject)=>{out.on('close',resolve);out.on('error',reject);a.on('error',reject)});a.pipe(out);add(a);await a.finalize();await done;}
test('extracts normal files and rejects symlink entries without modifying outside file',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vk-zip-security-')),outside=path.join(root,'outside.txt');
 try {fs.writeFileSync(outside,'keep');const safe=path.join(root,'safe.zip');await zip(safe,a=>a.append('hello',{name:'nested/file.txt'}));await extract(safe,{dir:path.join(root,'safe')});assert.equal(fs.readFileSync(path.join(root,'safe/nested/file.txt'),'utf8'),'hello');
 const bad=path.join(root,'bad.zip');await zip(bad,a=>a.symlink('link','../outside.txt'));await assert.rejects(extract(bad,{dir:path.join(root,'bad')}),/symbolic links/);assert.equal(fs.readFileSync(outside,'utf8'),'keep');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
