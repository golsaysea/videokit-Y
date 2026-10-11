const {_electron:electron}=require(process.env.PLAYWRIGHT_MODULE);
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('node:assert/strict');
(async()=>{
 const root=path.resolve(__dirname,'..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'videokit-security-'));
 fs.mkdirSync(path.join(profile,'videokit-presets'));
 fs.writeFileSync(path.join(profile,'videokit-presets/local-storage-presets.json'),JSON.stringify({values:{security_test_preset:'restored'}}));
 const env={...process.env,VIDEOKIT_TEST_PROFILE:profile,VITE_PORT:'5198'};delete env.ELECTRON_RUN_AS_NODE;
 const server=require('child_process').spawn(process.execPath,[path.join(root,'node_modules/vite/bin/vite.js'),'--port','5198'],{cwd:root,env,windowsHide:true,stdio:'ignore'});
 let app;
 try {
 for(let i=0;i<100;i++){try{const r=await fetch('http://localhost:5198/');if(r.ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 app=await electron.launch({executablePath:require('electron'),args:[path.join(__dirname,'queue-ui-test-entry.cjs')],cwd:root,env});
 try {
  let page;
  for(let i=0;i<100;i++){page=app.windows().find(p=>p.url().startsWith('http://localhost:5198'));if(page)break;await new Promise(r=>setTimeout(r,200));}
  assert.ok(page,'main window must reach the test server');
  await page.waitForFunction(()=>!!window.electronAPI,{timeout:15000});
  assert.equal(await page.evaluate(()=>localStorage.getItem('security_test_preset')),'restored');
  const result=await app.evaluate(async ({BrowserWindow})=>{
   const main=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('http://localhost:5198'));
   const version=await main.webContents.executeJavaScript("window.electronAPI.getAppVersion()");
   const hostile=new BrowserWindow({show:false,webPreferences:{nodeIntegration:true,contextIsolation:false}});
   try {await hostile.loadURL('data:text/html,test');
    const denied=await hostile.webContents.executeJavaScript("require('electron').ipcRenderer.invoke('get-app-version').then(()=>false, e=>e.message.includes('Untrusted IPC sender'))");
    return {version,denied};
   } finally {hostile.destroy();}
  });
  assert.ok(result.version);assert.equal(result.denied,true);
  console.log('PASS: real Electron allows main-window IPC and rejects untrusted-window IPC',result.version);
 } finally {await app.close();}
 } finally {server.kill();}
})().catch(e=>{console.error(e);process.exitCode=1});
