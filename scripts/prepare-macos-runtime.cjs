const fs=require('fs'),path=require('path'),crypto=require('crypto'),{execFileSync}=require('child_process');
async function main(){
 const arch=process.argv[2];if(process.platform!=='darwin'||!['arm64','x64'].includes(arch)||process.arch!==arch)throw Error('Use the matching native macOS runner');
 const root=path.resolve(__dirname,'..'),vendor=path.join(root,'vendor/darwin');fs.mkdirSync(path.join(vendor,'ffmpeg'),{recursive:true});
 const assets=require('./macos-runtime-assets.json')[arch];
 for(const asset of assets){
  const response=await fetch(asset.url);if(!response.ok)throw Error('Download failed: '+asset.name+' '+response.status);
  const bytes=Buffer.from(await response.arrayBuffer());const digest='sha256:'+crypto.createHash('sha256').update(bytes).digest('hex');if(digest!==asset.digest)throw Error('Checksum mismatch: '+asset.name);
  const dest=path.join(vendor,asset.target==='python.tar.gz'?asset.target:'ffmpeg/'+asset.target);fs.writeFileSync(dest,bytes);
  if(asset.target==='python.tar.gz'){execFileSync('tar',['-xzf',dest,'-C',vendor]);fs.unlinkSync(dest);}else if(['ffmpeg','ffprobe'].includes(asset.target))fs.chmodSync(dest,0o755);
 }
 const python=path.join(vendor,'python/bin/python3');
 execFileSync(python,['-m','pip','install','-r','requirements-edge.txt','yt-dlp','requests'],{cwd:root,stdio:'inherit'});
 execFileSync(python,['-c','import edge_tts, yt_dlp, requests; print("Bundled Python runtime OK")'],{stdio:'inherit'});
 for(const tool of ['ffmpeg','ffprobe'])execFileSync(path.join(vendor,'ffmpeg',tool),['-version'],{stdio:'inherit'});
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
