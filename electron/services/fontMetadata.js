const fs=require('fs');
const cache=new Map();
const path=require('path');
let persistentFile=null,persistTimer=null;
try{
    const app=require('electron').app;
    if(app?.getPath){
        persistentFile=path.join(app.getPath('userData'),'font-metadata-scan-cache.json');
        if(fs.existsSync(persistentFile)&&fs.statSync(persistentFile).size<2097152){
            const saved=JSON.parse(fs.readFileSync(persistentFile,'utf8'));
            if(saved.version===1&&Array.isArray(saved.entries))for(const entry of saved.entries){
                if(!Array.isArray(entry)||typeof entry[0]!=='string'||typeof entry[1]?.key!=='string')continue;
                const input=entry[1].value||{},value={};
                if(typeof input.family==='string'&&input.family.length<500)value.family=input.family;
                if(typeof input.weight==='string'&&/^[0-9 ]{1,9}$/.test(input.weight))value.weight=input.weight;
                cache.set(entry[0],{key:entry[1].key,value});
            }
        }
    }
}catch(_){}
function schedulePersist(){
    if(!persistentFile||persistTimer)return;
    persistTimer=setTimeout(()=>{
        persistTimer=null;
        try{
            const temporary=persistentFile+'.'+process.pid+'.tmp';
            fs.mkdirSync(path.dirname(persistentFile),{recursive:true});
            fs.writeFileSync(temporary,JSON.stringify({version:1,entries:[...cache]}),'utf8');
            fs.renameSync(temporary,persistentFile);
        }catch(_){}
    },500);
    persistTimer?.unref?.();
}
function readFontMetadata(file){
    let fd;
    try{
        const st=fs.statSync(file),key=st.size+':'+st.mtimeMs,old=cache.get(file);if(old?.key===key)return old.value;
        fd=fs.openSync(file,'r');const read=(pos,len)=>{if(pos<0||len<0||len>524288||pos+len>st.size)throw Error('Invalid font table');const b=Buffer.alloc(len);if(fs.readSync(fd,b,0,len,pos)!==len)throw Error('Short font table');return b;};
        let base=0,head=read(0,12);if(head.toString('ascii',0,4)==='ttcf'){base=read(12,4).readUInt32BE(0);head=read(base,12);}
        const signature=head.toString('ascii',0,4);if(head.readUInt32BE(0)!==65536&&signature!=='OTTO'&&signature!=='true')return {};
        const count=head.readUInt16BE(4);if(count>300)return {};const directory=read(base+12,count*16),tables={};
        for(let i=0;i<count;i++){const pos=i*16;tables[directory.toString('ascii',pos,pos+4)]={offset:directory.readUInt32BE(pos+8),length:directory.readUInt32BE(pos+12)};}
        let family='',score=-1;const table=tables.name;
        if(table&&table.length<=524288){const data=read(table.offset,table.length);if(data.length>=6){const count=data.readUInt16BE(2),start=data.readUInt16BE(4);for(let i=0;i<count;i++){const p=6+i*12;if(p+12>data.length)break;const platform=data.readUInt16BE(p),lang=data.readUInt16BE(p+4),id=data.readUInt16BE(p+6),len=data.readUInt16BE(p+8),offset=start+data.readUInt16BE(p+10);if(![1,16].includes(id)||offset+len>data.length)continue;let bytes=Buffer.from(data.subarray(offset,offset+len)),text;if(platform===0||platform===3){if(bytes.length%2)continue;bytes.swap16();text=bytes.toString('utf16le');}else text=bytes.toString('latin1');const rank=(id===16?20:0)+(lang===1033?10:0)+(platform===3?2:0);if(text.trim()&&rank>score){family=text.replace(/\0/g,'').trim();score=rank;}}}}
        const value={};if(family)value.family=family;const os=tables['OS/2'];if(os&&os.length>=6){const weight=read(os.offset+4,2).readUInt16BE(0);if(weight>=1&&weight<=1000)value.weight=String(weight);}if(tables.fvar)value.weight='100 900';cache.set(file,{key,value});schedulePersist();return value;
    }catch(_){return {};}finally{if(fd!==undefined)fs.closeSync(fd);}
}
module.exports={readFontMetadata};
