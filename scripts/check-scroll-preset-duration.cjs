const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('src/reels-overlay-panel.js','utf8');
const blocks=[...source.matchAll(/clone\.end = Number\.isFinite\(loadedEnd\)[\s\S]*?clone\.end = 9999;\s*\}/g)].map(m=>m[0]);assert.ok(blocks.length>=4);
for(const block of blocks){
 for(const [clone,expected] of [[{type:'scroll',scroll_auto_stop:true,start:0},9999],[{type:'scroll',scroll_auto_stop:false,start:0},30],[{type:'image',scroll_auto_stop:true,start:0},30],[{type:'scroll',scroll_auto_stop:true,start:0,display_ranges:[{start:2,end:30}]},30]]){
  vm.runInNewContext(block,{clone,loadedEnd:30});assert.equal(clone.end,expected);
 }
}
console.log('PASS: all four preset replace/merge paths follow task duration only for auto-stop scroll; manual timing, media, and explicit ranges unchanged');
