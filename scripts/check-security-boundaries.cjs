const assert = require('node:assert/strict');
const path = require('path');
const {pathToFileURL} = require('url');
const {isTrustedRendererUrl: trusted} = require('../electron/services/trustedRenderer');
const root=path.resolve(__dirname,'..');
assert.ok(trusted(pathToFileURL(path.join(root,'dist/index.html')).href+'#template=x'));
assert.ok(trusted('http://localhost:5173/',{packaged:false}));
assert.ok(trusted('http://localhost:5184/index.html',{packaged:false,port:5184}));
for(const url of ['https://evil.example/','http://localhost:5173/','file:///C:/Users/User/Downloads/evil.html']) assert.equal(trusted(url),false);
for(const url of ['http://localhost.evil.example:5173/','http://localhost:5173/evil.html','http://user:pass@localhost:5173/','http://localhost:9999/','data:text/html,hello']) assert.equal(trusted(url,{packaged:false}),false);
console.log('PASS: renderer URL allowlist including custom port, template hash, hostile origins and credentials');

const fs=require('fs'),vm=require('vm'),{EventEmitter}=require('events');
const panel=fs.readFileSync(path.join(root,'src/reels-overlay-panel.js'),'utf8');
const start=panel.indexOf("            const bindSelect = this.container.querySelector('#rop-bind-scroll-target');");
const end=panel.indexOf("        if (ov.type === 'textcard' || ov.type === 'solid_mask')",start);
const code=panel.slice(start,end).replace(/\s*}\s*$/, '');
let options=[];
const select={replaceChildren(...o){options=o},add(o){options.push(o)}};
Object.defineProperty(select,'innerHTML',{set(){throw Error('untrusted HTML sink')}});
const hostile='<img src=x onerror=alert(1)>';
const context={ov:{bind_scroll_overlay_id:'id'},Option:function(text,value,def,selected){Object.assign(this,{text,value,selected})},container:{querySelector:()=>select},videoCanvas:{overlayMgr:{overlays:[{id:'id',type:'scroll',name:hostile}]}}};
vm.runInNewContext(code,context);assert.equal(options[1].text,hostile);assert.equal(options[1].selected,true);
console.log('PASS: imported overlay labels are plain text and selection is retained');
const updater=fs.readFileSync(path.join(root,'electron/updater.js'),'utf8');
const a=updater.indexOf('function downloadFile('),b=updater.indexOf('\n/**',a);
async function exercise(url,responses){let writes=0,calls=0;
 const mockFs={createWriteStream(){writes++;const file=new EventEmitter();file.close=()=>{};return file},unlinkSync(){}};
 const https={get(url,opts,callback){calls++;const request=new EventEmitter();request.setTimeout=()=>{};request.destroy=()=>{};queueMicrotask(()=>{const r=responses.shift();const res=new EventEmitter();Object.assign(res,r);res.resume=()=>{};res.pipe=file=>queueMicrotask(()=>file.emit('finish'));callback(res)});return request}};
 const sandbox={URL,Promise,fs:mockFs,https};vm.runInNewContext(updater.slice(a,b),sandbox);
 try{await sandbox.downloadFile(url,'unused');return {writes,calls}}catch(error){error.writes=writes;error.calls=calls;throw error}
}
(async()=>{
 await assert.rejects(exercise('http://example.com/a',[]),e=>e.writes===0);
 await assert.rejects(exercise('https://example.com/a',[{statusCode:302,headers:{location:'http://example.com/b'}}]),e=>e.calls===1);
 const ok=await exercise('https://example.com/a',[{statusCode:302,headers:{location:'/b'}},{statusCode:200,headers:{}}]);assert.equal(ok.calls,2);
 console.log('PASS: updater blocks plaintext downgrade and follows relative HTTPS redirects');
})().catch(e=>{console.error(e);process.exitCode=1});
