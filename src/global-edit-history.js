(function(){
    'use strict';
    const histories=new Map(),adapters=new Map(),objectIds=new WeakMap(),largeStrings=new Map();let nextId=1,restoring=false,gesture=null,pending=null;
    const excluded=/password|secret|token|api.?key|(?:^|[-_])key(?:$|[-_])|license/i;
    function copy(value,seen=new WeakMap()){
        if(!value||typeof value!=='object')return value;
        if(value instanceof Blob)return value;
        if(seen.has(value))return seen.get(value);
        if(value instanceof Set){const out=new Set();seen.set(value,out);for(const v of value)out.add(copy(v,seen));return out;}
        if(value instanceof Map){const out=new Map();seen.set(value,out);for(const [k,v]of value)out.set(copy(k,seen),copy(v,seen));return out;}
        if(Array.isArray(value)){const out=[];seen.set(value,out);for(const v of value)out.push(copy(v,seen));return out;}
        if(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)return value;
        const out={};seen.set(value,out);for(const [k,v]of Object.entries(value))if(typeof v!=='function')out[k]=copy(v,seen);return out;
    }
    function signature(value){
        const seen=new WeakSet();return JSON.stringify(value,(key,v)=>{
            if(typeof v==='string'&&v.length>1024){if(!largeStrings.has(v))largeStrings.set(v,nextId++);return {string:largeStrings.get(v)};}
            if(v instanceof Blob){if(!objectIds.has(v))objectIds.set(v,nextId++);return {blob:objectIds.get(v),size:v.size,name:v.name};}
            if(v instanceof Map)return {map:Array.from(v)};if(v instanceof Set)return {set:Array.from(v)};
            if(v&&typeof v==='object'){if(seen.has(v))return null;seen.add(v);}return v;
        });
    }
    function context(target){
        if(target?.closest?.('#reels-batch-table-container'))return 'batch-reels';
        return document.querySelector('.tab.active[data-tab]')?.dataset.tab||document.querySelector('section.panel.active')?.id.replace(/-panel$/,'')||'general';
    }
    function panel(id){return document.getElementById(id+'-panel')||document.querySelector('section.panel.active')||document.body;}
    function controls(id){
        const root=panel(id),counts=new Map();return Array.from(root.querySelectorAll('input,textarea,select')).filter(el=>el.type!=='file'&&el.type!=='password'&&!excluded.test(el.id+' '+el.name)).map(el=>{
            let key;if(el.id)key='#'+el.id;else {const base=el.name||el.tagName+':'+el.type,n=counts.get(base)||0;counts.set(base,n+1);key=base+':'+n;}
            return {key,el};
        });
    }
    function storageKeys(id){const rx=id==='settings'?/theme|language|watermark|volume/:id==='voiceover-workflow'?/^(vw_|videokit_voiceover_resume)/:id==='media'?/^(su-|mtb|visual-review|autoEdit|organizer|folderMerge)/:id==='srt-tools'?/wrap|subtitle.?lang|srt/:null;return Array.from({length:localStorage.length},(_,i)=>localStorage.key(i)).filter(k=>rx?.test(k)&&!excluded.test(k));}
    function capture(id,clone=true){
        const form=controls(id).map(({key,el})=>({key,value:el.value,checked:el.checked}));
        const models=[];for(const [name,adapter]of adapters){if(adapter.contexts.includes(id))models.push([name,clone?copy(adapter.capture(id)):adapter.capture(id)]);}
        const prefs=storageKeys(id).map(key=>[key,localStorage.getItem(key)]);
        return {form,models,prefs};
    }
    function get(id){if(!histories.has(id))histories.set(id,{items:[],index:-1});return histories.get(id);}
    function note(message){if(typeof showToast==='function')showToast(message,'info',2000);}
    function busy(id){for(const a of adapters.values())if(a.contexts.includes(id)&&a.busy?.())return true;return false;}
    function commit(id){
        if(restoring||id==='batch-reels'||busy(id))return;
        try{const h=get(id),raw=capture(id,false),hash=signature(raw);if(h.items[h.index]?.hash===hash)return;
            const state=copy(raw);let bytes=hash.length*2;const strings=new Set();
            function size(v,seen=new WeakSet()){
                if(typeof v==='string'){if(!strings.has(v)){strings.add(v);bytes+=v.length*2;}return;}
                if(!v||typeof v!=='object'||seen.has(v)||v instanceof Blob)return;seen.add(v);
                if(v instanceof Map){for(const [k,x]of v){size(k,seen);size(x,seen);}}
                else if(v instanceof Set){for(const x of v)size(x,seen);}
                else for(const x of Object.values(v))size(x,seen);
            }size(state);
            h.items.splice(h.index+1);h.items.push({state,hash,bytes});h.index=h.items.length-1;
            let total=h.items.reduce((n,item)=>n+(item.bytes||0),0);
            while(h.items.length>2&&(h.items.length>100||total>50*1024*1024)){total-=h.items.shift().bytes||0;h.index--;}
            // Release interned strings no longer retained in any page's history.
            if(largeStrings.size>128){const used=new Set();for(const history of histories.values())for(const item of history.items){
                function collect(v,seen=new WeakSet()){if(typeof v==='string'){if(v.length>1024)used.add(v);return;}if(!v||typeof v!=='object'||seen.has(v)||v instanceof Blob)return;seen.add(v);if(v instanceof Map){for(const [k,x]of v){collect(k,seen);collect(x,seen);}}else if(v instanceof Set){for(const x of v)collect(x,seen);}else for(const x of Object.values(v))collect(x,seen);}collect(item.state);
            }for(const value of largeStrings.keys())if(!used.has(value))largeStrings.delete(value);}
        }catch(error){console.warn('[GlobalUndo] Snapshot failed:',error.message);}
    }
    function restore(id,state){
        restoring=true;
        try{
            for(const [name,data]of state.models){const adapter=adapters.get(name);adapter?.restore(copy(data),id);}
            const oldKeys=storageKeys(id);for(const key of oldKeys)if(!state.prefs.some(([k])=>k===key))localStorage.removeItem(key);
            for(const [key,value]of state.prefs)localStorage.setItem(key,value);
            for(const [name]of state.models)adapters.get(name)?.render?.(id);
            const saved=new Map(state.form.map(row=>[row.key,row]));for(const {key,el}of controls(id)){const row=saved.get(key);if(!row)continue;el.value=row.value;if('checked'in el)el.checked=row.checked;}
        }finally{restoring=false;}
    }
    function step(direction,target){
        const local=target?.closest?.('[data-videokit-local-history]');
        if(local){direction<0?local.videokitUndo?.():local.videokitRedo?.();return;}
        const id=context(target);if(id==='batch-reels'){direction<0?window.reelsUndo?.():window.reelsRedo?.();return;}
        if(busy(id)){note('当前正在处理任务，请完成或停止后再撤销编辑');return;}
        if(pending){clearTimeout(pending);pending=null;commit(id);}else if(direction<0)commit(id);
        const h=get(id);const index=h.index+direction;if(index<0||index>=h.items.length){note(direction<0?'当前页没有可撤销的编辑记录':'当前页没有可重做的编辑记录');return;}
        const previous=h.index,backup=capture(id);
        try{restore(id,h.items[index].state);h.index=index;const normalized=capture(id);h.items[index]={state:normalized,hash:signature(normalized),bytes:h.items[index].bytes};note(h.external?'已恢复界面编辑；已执行的文件或云端操作不撤回':direction<0?'已撤销当前页一步编辑':'已重做当前页一步编辑');}
        catch(error){h.index=previous;try{restore(id,backup);}catch(_){}console.warn('[GlobalUndo] Restore failed:',error.message);note('这一步无法完整恢复，已停止撤销');}
    }
    window.VideoKitGlobalHistory={register(name,adapter){adapters.set(name,adapter);},capture:commit,noteExternalAction:()=>{get(context()).external=true;},undo:target=>step(-1,target),redo:target=>step(1,target),copy,stats:id=>{const h=get(id);return {steps:h.items.length,index:h.index};}};
    window.addEventListener('keydown',event=>{
        if(event.defaultPrevented||event.isComposing||event.altKey||!(event.ctrlKey||event.metaKey))return;
        const key=event.key.toLowerCase();if(key!=='z'&&key!=='y')return;
        if(event.target?.isContentEditable||event.target?.tagName==='TEXTAREA'||(event.target?.tagName==='INPUT'&&['text','search','password','url','email','tel'].includes(event.target.type)))return;
        event.preventDefault();event.stopImmediatePropagation();step(key==='y'||event.shiftKey?1:-1,event.target);
    },true);
    for(const name of ['pointerdown','beforeinput'])document.addEventListener(name,event=>{
        if(restoring||event.ctrlKey||event.metaKey||event.target?.closest?.('[data-videokit-local-history]'))return;
        const id=context(event.target);if(id==='batch-reels')return;
        if(name==='pointerdown'&&!event.target?.closest?.('input,textarea,select,button,canvas,[onclick],[contenteditable]'))return;
        if(!pending)commit(id);if(name==='pointerdown')gesture={id,range:event.target?.type==='range'};
    },true);
    for(const name of ['input','change','click','pointerup','drop'])document.addEventListener(name,event=>{
        if(restoring||event.target?.closest?.('[data-videokit-local-history]'))return;const id=context(event.target);if(id==='batch-reels')return;
        if(gesture?.range&&name==='input')return;if(name==='pointerup')gesture=null;
        clearTimeout(pending);pending=setTimeout(()=>{pending=null;commit(id);},name==='input'?350:0);
    });
    document.addEventListener('DOMContentLoaded',()=>setTimeout(()=>commit(context()),500));
})();
