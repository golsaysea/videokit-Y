const fs=require('fs');
const path=require('path');
function createFontPreferences(profileDir){
    const file=path.join(profileDir,'font-preferences.json');let cached=null;
    const clean=values=>[...new Set((Array.isArray(values)?values:[]).filter(x=>typeof x==='string'&&x.trim()&&x.length<=200).map(x=>x.trim()))].slice(0,3000);
    function read(seed=[]){
        if(cached)return [...cached.favorites];
        if(fs.existsSync(file)){
            let data;try{data=JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(!fs.existsSync(file+'.bak'))throw error;data=JSON.parse(fs.readFileSync(file+'.bak','utf8'));}
            cached={favorites:clean(data.favorites)};return [...cached.favorites];
        }
        cached={favorites:clean(seed)};if(cached.favorites.length)save(cached.favorites);return [...cached.favorites];
    }
    function save(values){
        const favorites=clean(values),body=JSON.stringify({version:1,favorites},null,2);fs.mkdirSync(profileDir,{recursive:true});
        if(fs.existsSync(file))fs.copyFileSync(file,file+'.bak');const tmp=file+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,body,'utf8');fs.renameSync(tmp,file);cached={favorites};return [...favorites];
    }
    function toggle(family){if(typeof family!=='string'||!family.trim()||family.length>200)throw new Error('无效的字体名称');family=family.trim();const values=read();return save(values.includes(family)?values.filter(x=>x!==family):[...values,family]);}
    return {read,save,toggle};
}
module.exports={createFontPreferences};
