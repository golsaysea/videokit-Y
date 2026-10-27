'use strict';
const {spawn}=require('child_process');
const fs=require('fs');
const path=require('path');
function resolveDefaultPythonPath(){
 const candidates=[
  path.join(__dirname,'vendor/python/python.exe'),
  path.join(__dirname,'..','vendor','windows','python','python.exe'),
  process.resourcesPath?path.join(process.resourcesPath,'vendor','python','python.exe'):'',
 ].filter(Boolean);
 return candidates.find(p=>fs.existsSync(p))||path.join(__dirname,'vendor/python/python.exe');
}
const PYTHON_SOURCE="\"\"\"Bound the aggregate CPU budget of export process trees on Windows.\"\"\"\nimport ctypes as C\nfrom ctypes import wintypes as W\nimport json\nimport sys\nimport threading\nimport time\n\nk = C.WinDLL('kernel32', use_last_error=True)\nclass Rate(C.Structure):\n    _fields_ = [('flags', W.DWORD), ('rate', W.DWORD)]\nclass Accounting(C.Structure):\n    _fields_ = [('user', C.c_longlong), ('kernel', C.c_longlong),\n                ('period_user', C.c_longlong), ('period_kernel', C.c_longlong),\n                ('faults', W.DWORD), ('total', W.DWORD), ('active', W.DWORD), ('terminated', W.DWORD)]\nk.CreateJobObjectW.argtypes = [C.c_void_p, W.LPCWSTR]\nk.CreateJobObjectW.restype = W.HANDLE\nk.OpenProcess.argtypes = [W.DWORD, W.BOOL, W.DWORD]\nk.OpenProcess.restype = W.HANDLE\nk.CloseHandle.argtypes = [W.HANDLE]\nk.AssignProcessToJobObject.argtypes = [W.HANDLE, W.HANDLE]\nk.SetInformationJobObject.argtypes = [W.HANDLE, C.c_int, C.c_void_p, W.DWORD]\nk.QueryInformationJobObject.argtypes = [W.HANDLE, C.c_int, C.c_void_p, W.DWORD, C.c_void_p]\nk.IsProcessInJob.argtypes = [W.HANDLE, W.HANDLE, C.POINTER(W.BOOL)]\nk.SetPriorityClass.argtypes = [W.HANDLE, W.DWORD]\nk.GetSystemTimes.argtypes = [C.POINTER(W.FILETIME), C.POINTER(W.FILETIME), C.POINTER(W.FILETIME)]\n\ncondition = threading.Condition(threading.RLock())\njobs = {}\nbudget = 6000\nstopping = False\n\ndef checked(value, operation):\n    if not value:\n        raise OSError(C.get_last_error(), operation + ': ' + C.FormatError(C.get_last_error()))\n    return value\n\ndef set_rate(job, rate):\n    info = Rate(5, max(1, int(rate)))  # ENABLE | HARD_CAP, hundredths of a percent.\n    checked(k.SetInformationJobObject(job, 15, C.byref(info), C.sizeof(info)), 'Set CPU rate')\n\ndef reap():\n    for pid, job in list(jobs.items()):\n        info = Accounting()\n        if not k.QueryInformationJobObject(job, 1, C.byref(info), C.sizeof(info), None) or info.active == 0:\n            k.CloseHandle(job)\n            jobs.pop(pid, None)\n\ndef redistribute():\n    rate = max(1, budget // max(1, len(jobs)))\n    for job in jobs.values():\n        set_rate(job, rate)\n    return rate\n\ndef sample_cpu():\n    idle, kernel, user = W.FILETIME(), W.FILETIME(), W.FILETIME()\n    checked(k.GetSystemTimes(C.byref(idle), C.byref(kernel), C.byref(user)), 'Read CPU usage')\n    number = lambda t: (t.dwHighDateTime << 32) | t.dwLowDateTime\n    return number(idle), number(kernel) + number(user)\n\ndef monitor():\n    global budget\n    previous = None\n    while True:\n        with condition:\n            while not jobs and not stopping:\n                previous = None\n                condition.wait()\n            if stopping:\n                return\n            deadline = time.monotonic() + .5\n            while not stopping and time.monotonic() < deadline:\n                condition.wait(deadline - time.monotonic())\n            if stopping:\n                return\n            try:\n                reap()\n                if not jobs:\n                    continue\n                current = sample_cpu()\n                if previous and current[1] > previous[1]:\n                    usage = 100 * (1 - (current[0] - previous[0]) / (current[1] - previous[1]))\n                    if usage > 70:\n                        budget = max(500, int(budget * .85))\n                    elif usage < 60:\n                        budget = min(6000, budget + 100)\n                previous = current\n                redistribute()\n            except Exception as error:\n                print('CPU budget monitor: ' + str(error), file=sys.stderr, flush=True)\n\ndef assign(pid):\n    global budget\n    process = k.OpenProcess(0x1301, False, pid)  # SET_QUOTA | SET_INFORMATION | TERMINATE | QUERY_LIMITED.\n    if not process:\n        error = C.get_last_error()\n        if error in (87, 1168):\n            return {'ok': True, 'exited': True}\n        checked(process, 'Open export process')\n    try:\n        with condition:\n            reap()\n            for root, job in jobs.items():\n                member = W.BOOL()\n                if k.IsProcessInJob(process, job, C.byref(member)) and member.value:\n                    return {'ok': True, 'reused': True, 'cpuPercent': budget / max(1, len(jobs)) / 100}\n            if not jobs:\n                budget = 6000\n            job = checked(k.CreateJobObjectW(None, None), 'Create export CPU job')\n            try:\n                set_rate(job, max(1, budget // (len(jobs) + 1)))\n                # Lower all existing caps before enrolling another independent tree.\n                for existing in jobs.values():\n                    set_rate(existing, max(1, budget // (len(jobs) + 1)))\n                checked(k.AssignProcessToJobObject(job, process), 'Assign export CPU job')\n                k.SetPriorityClass(process, 0x4000)  # BELOW_NORMAL_PRIORITY_CLASS.\n                jobs[pid] = job\n                rate = redistribute()\n                condition.notify_all()\n                return {'ok': True, 'cpuPercent': rate / 100, 'totalBudgetPercent': budget / 100, 'jobs': len(jobs)}\n            except Exception:\n                k.CloseHandle(job)\n                raise\n    finally:\n        k.CloseHandle(process)\n\nthread = threading.Thread(target=monitor, daemon=True)\nthread.start()\nprint(json.dumps({'ready': True, 'version': 2}), flush=True)\ntry:\n    for line in sys.stdin:\n        request = {}\n        try:\n            request = json.loads(line)\n            result = assign(int(request['pid']))\n            result['id'] = request['id']\n        except Exception as error:\n            result = {'id': request.get('id'), 'ok': False, 'error': str(error)}\n        print(json.dumps(result), flush=True)\nfinally:\n    with condition:\n        stopping = True\n        condition.notify_all()\n    thread.join(2)\n    for job in jobs.values():\n        info = Rate(0, 0)\n        k.SetInformationJobObject(job, 15, C.byref(info), C.sizeof(info))\n        k.CloseHandle(job)\n";
function createBudgetManager(options={}){
 const launch=options.spawn||spawn;
 const python=options.pythonPath||resolveDefaultPythonPath();
 let current=null,sequence=0;
 function start(){
  if(current)return current.ready;
  const record={child:null,pending:new Map(),stderr:'',ready:null,fail:null};
  current=record;
  record.ready=new Promise((resolve,reject)=>{
   let buffer='',settled=false;
   const timer=setTimeout(()=>{record.fail(Error('CPU budget helper startup timed out'));record.child?.kill();},options.startTimeout||10000);
   const fail=error=>{
    clearTimeout(timer);
    if(!settled){settled=true;reject(error);}
    for(const request of record.pending.values()){clearTimeout(request.timer);request.reject(error);}
    record.pending.clear();if(current===record)current=null;
   };
   record.fail=fail;
   try{
    // No dependency on a separately installed .py file: the helper travels
    // inside this module and works even if optional source files are removed.
    record.child=launch(python,['-u','-c',PYTHON_SOURCE],{windowsHide:true,stdio:['pipe','pipe','pipe']});
   }catch(error){fail(error);return;}
   const child=record.child;
   child.stdout.on('data',chunk=>{
    buffer+=chunk.toString();let newline;
    while((newline=buffer.indexOf('\n'))>=0){
     const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);let response;
     try{response=JSON.parse(line);}catch(_){continue;}
     if(response.ready){clearTimeout(timer);settled=true;resolve(record);}
     else{const request=record.pending.get(response.id);if(request){record.pending.delete(response.id);clearTimeout(request.timer);response.ok?request.resolve(response):request.reject(Error(response.error||'CPU budget assignment failed'));}}
    }
   });
   child.stderr.on('data',chunk=>{record.stderr=(record.stderr+chunk.toString()).slice(-2000);});
   child.on('error',error=>fail(Error('CPU budget helper could not start: '+error.message)));
   child.on('exit',(code,signal)=>fail(Error(`CPU budget helper exited (code=${code}, signal=${signal||'none'})${record.stderr.trim()?': '+record.stderr.trim():''}`)));
   child.stdin.on('error',error=>fail(Error('CPU budget helper input failed: '+error.message)));
  });
  // Avoid a stale synchronous launch failure keeping a rejected cached startup.
  record.ready.catch(()=>{if(current===record)current=null;});
  return record.ready;
 }
 async function assign(pid){
  if(process.platform!=='win32')return{ok:true};
  if(!Number.isInteger(pid)||pid<=0)throw Error('Invalid export process id');
  const record=await start();
  if(current!==record||record.child.exitCode!==null||record.child.killed)throw Error('CPU budget helper is not running');
  return new Promise((resolve,reject)=>{
   const id=++sequence;
   const timer=setTimeout(()=>{record.pending.delete(id);reject(Error('CPU budget assignment timed out'));},options.assignTimeout||10000);
   record.pending.set(id,{resolve,reject,timer});
   record.child.stdin.write(JSON.stringify({id,pid})+'\n',error=>{if(error){const request=record.pending.get(id);if(request){record.pending.delete(id);clearTimeout(timer);reject(error);}}});
  });
 }
 async function close(){
  const record=current;if(!record)return;
  const child=record.child;
  await new Promise(resolve=>{if(child.exitCode!==null)return resolve();const timer=setTimeout(()=>{child.kill();resolve();},2000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.stdin.end();});
 }
 return{assign,close};
}
const manager=createBudgetManager();
module.exports={...manager,createBudgetManager};
