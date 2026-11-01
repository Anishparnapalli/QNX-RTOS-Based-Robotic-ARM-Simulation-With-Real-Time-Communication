"use strict";
// ═══════════════════════════════════════════════════════════════════
//  UPLOAD PAGE LOGIC
// ═══════════════════════════════════════════════════════════════════
const uploadedFiles = {};   // filename → File object
const quantities    = {};   // filename → count
let previewScene, previewCamera, previewRenderer, previewAnim;

function initPreviewRenderer(){
  const c = document.getElementById('preview-canvas');
  const w = c.parentElement.clientWidth||200, h = c.parentElement.clientHeight||200;
  previewRenderer = new THREE.WebGLRenderer({canvas:c,antialias:true,alpha:true});
  previewRenderer.setSize(w,h);
  previewCamera = new THREE.PerspectiveCamera(45,w/h,.01,100);
  previewCamera.position.set(0,1,3);
  previewScene  = new THREE.Scene();
  previewScene.add(new THREE.AmbientLight(0xffffff,.8));
  const dl = new THREE.DirectionalLight(0x00d4ff,1.2); dl.position.set(2,3,2); previewScene.add(dl);
  function loop(){ previewAnim = requestAnimationFrame(loop);
    if(previewScene.children.length>2){ previewScene.children.forEach(c=>{ if(c.isMesh||c.isGroup) c.rotation.y+=.008; }); }
    previewRenderer.render(previewScene,previewCamera);
  }
  loop();
}

function showPreview(file){
  if(!previewRenderer) initPreviewRenderer();
  // Clear previous models
  while(previewScene.children.length>2) previewScene.remove(previewScene.children[2]);
  document.getElementById('preview-label').textContent = file.name;

  const isSTL = file.name.toLowerCase().endsWith('.stl');
  const loader = isSTL ? new THREE.STLLoader() : new THREE.OBJLoader();
  const url = URL.createObjectURL(file);

  loader.load(url, obj=>{
    let meshGroup = obj;
    if(isSTL){
      const mat = new THREE.MeshStandardMaterial({color:0x1a6cf5,roughness:.4,metalness:.6});
      meshGroup = new THREE.Mesh(obj, mat);
    }
    const box = new THREE.Box3().setFromObject(meshGroup);
    const sz  = box.getSize(new THREE.Vector3());
    const sc  = 1.5/Math.max(sz.x,sz.y,sz.z);
    meshGroup.scale.setScalar(sc);
    const ctr = box.getCenter(new THREE.Vector3());
    meshGroup.position.sub(ctr.multiplyScalar(sc));
    if(!isSTL){
      meshGroup.traverse(c=>{ if(c.isMesh) c.material=new THREE.MeshStandardMaterial({color:0x1a6cf5,roughness:.4,metalness:.6}); });
    }
    previewScene.add(meshGroup);

    // Auto-frame perfectly
    const finalBox = new THREE.Box3().setFromObject(meshGroup);
    const finalCtr = finalBox.getCenter(new THREE.Vector3());
    const finalSz = finalBox.getSize(new THREE.Vector3());
    const maxDim = Math.max(finalSz.x, finalSz.y, finalSz.z);
    if(axisOrbit) axisOrbit.target.copy(finalCtr); // if we had orbit here, but we don't.
    previewCamera.position.set(finalCtr.x, finalCtr.y, finalCtr.z + maxDim*1.5);
    previewCamera.lookAt(finalCtr);
  });
}

function handleFiles(files){
  for(const f of files){
    const lower = f.name.toLowerCase();
    if(!lower.endsWith('.obj') && !lower.endsWith('.stl')) continue;
    uploadedFiles[f.name] = f;
    quantities[f.name]    = quantities[f.name]||1;
  }
  renderFileList();
}

function renderFileList(){
  const list = document.getElementById('file-list');
  list.innerHTML='';
  const names = Object.keys(uploadedFiles);
  names.forEach(name=>{
    const f   = uploadedFiles[name];
    const kb  = (f.size/1024).toFixed(1);
    const row = document.createElement('div');
    row.className='file-item';
    const ext = name.split('.').pop().toUpperCase();
    row.innerHTML=`
      <div class="fi-icon" onclick="showPreview(uploadedFiles['${name}'])" style="cursor:pointer" title="Preview">${ext}</div>
      <div>
        <div class="fi-name" title="${name}">${name}</div>
        <div class="fi-size">${kb} KB</div>
      </div>
      <div class="fi-size">${kb}KB</div>
      <div class="qty-control">
        <button class="qty-btn" onclick="changeQty('${name}',-1)">−</button>
        <input class="qty-val" type="number" min="1" max="10" value="${quantities[name]}" id="qty-${CSS.escape(name)}" onchange="quantities['${name}']=Math.max(1,+this.value)"/>
        <button class="qty-btn" onclick="changeQty('${name}',1)">+</button>
      </div>`;
    row.querySelector('.fi-icon').addEventListener('click',()=>showPreview(f));
    list.appendChild(row);
  });
  const total = Object.values(quantities).reduce((a,b)=>a+b,0);
  document.getElementById('file-count').textContent=names.length;
  document.getElementById('part-count').textContent=total;
  document.getElementById('btn-launch').disabled = names.length===0;
}

function changeQty(name,delta){
  if(quantities[name]===1 && delta===-1){
    dzRemove(name);
    return;
  }
  quantities[name] = Math.max(1,Math.min(10,(quantities[name]||1)+delta));
  const el = document.getElementById('qty-'+CSS.escape(name));
  if(el) el.value = quantities[name];
  const total = Object.values(quantities).reduce((a,b)=>a+b,0);
  document.getElementById('part-count').textContent=total;
  updateAssemblyMap();
}

function dzDrag(e,on){ e.preventDefault(); document.getElementById('drop-zone').classList.toggle('drag',on); }
function dzDrop(e){ e.preventDefault(); dzDrag(e,false); handleFiles(e.dataTransfer.files); }
function dzRemove(name){ delete uploadedFiles[name]; delete quantities[name]; renderFileList(); updateAssemblyMap(); }

function updateAssemblyMap() {
  const mapDiv = document.querySelector('.upload-right > div:last-child');
  if(!mapDiv) return;
  mapDiv.innerHTML = `<div style="color:var(--cyan);margin-bottom:6px;font-size:9px;letter-spacing:.12em">ASSEMBLY MAP</div>`;
  Object.keys(uploadedFiles).forEach(k => {
    let mapping = "Part";
    let kl = k.toLowerCase();
    if(kl.includes('base')) mapping = "J0 Yaw";
    else if(kl.includes('waist')) mapping = "J1 Shoulder";
    else if(kl.includes('arm 01')) mapping = "J2 Elbow";
    else if(kl.includes('arm 02')) mapping = "J3 Wrist";
    else if(kl.includes('arm 03')) mapping = "J4 Roll";
    else if(kl.includes('gripper base')) mapping = "Mount";
    else if(kl.includes('gripper')) mapping = "Jaw";
    else if(kl.includes('gear')) mapping = "Gear";
    mapDiv.innerHTML += `<div>${k} <span style="font-size:9px;opacity:0.6">(x${quantities[k]})</span> → <span style="color:var(--fg)">${mapping}</span></div>`;
  });
}


// ═══════════════════════════════════════════════════════════════════
//  LOADING SEQUENCE
// ═══════════════════════════════════════════════════════════════════
const loadSteps=[
  [10,'Booting M.A.T.R.I.X. kernel…'],
  [25,'Loading Three.js renderer…'],
  [45,'Initializing RTOS simulation engine…'],
  [60,'Establishing WebSocket bridge…'],
  [75,'Compiling shader programs…'],
  [90,'Configuring joint controllers…'],
  [100,'Systems nominal. Ready.']
];
let li=0;
function animLoad(){
  if(li>=loadSteps.length){ setTimeout(showProjectHub,500); return; }
  const [pct,msg]=loadSteps[li++];
  document.getElementById('load-bar').style.width=pct+'%';
  document.getElementById('load-status').textContent=msg;
  setTimeout(animLoad,380+Math.random()*200);
}
setTimeout(animLoad,600);

function showUpload(){
  document.getElementById('loading').style.opacity='0';
  document.getElementById('loading').style.transition='opacity .5s';
  setTimeout(()=>{ document.getElementById('loading').style.display='none';
    document.getElementById('upload-screen').style.display='flex';
    initPreviewRenderer();
  },500);
}

function uploadNew(){
  document.getElementById('main').style.display='none';
  document.getElementById('upload-screen').style.display='flex';
}


// ═══════════════════════════════════════════════════════════════════
//  AXIS CALIBRATION & LAUNCH
// ═══════════════════════════════════════════════════════════════════

let axisScene, axisCamera, axisRenderer, axisOrbit, axisAnim;
let axisRaycaster = new THREE.Raycaster();
let axisMouse = new THREE.Vector2();
let axisMesh = null;
let axisHelper = null;
let axisCurrentFile = null;
let axisClicks = []; // 4-point calibration

function showAxisCalibration(){
  document.getElementById('upload-screen').style.display='none';
  document.getElementById('axis-screen').style.display='flex';

  const backBtn = document.getElementById('btn-axis-back');
  if(backBtn) {
     backBtn.innerHTML = '◀ BACK';
     backBtn.onclick = () => {
         document.getElementById('axis-screen').style.display='none';
         document.getElementById('upload-screen').style.display='flex';
     };
  }
  const launchBtn = document.getElementById('btn-finish-axis');
  if(launchBtn) {
     launchBtn.innerHTML = 'LAUNCH M.A.T.R.I.X. →';
  }

  if(!axisRenderer){
    const c = document.getElementById('axis-canvas');
    const w = c.parentElement.clientWidth||800, h = c.parentElement.clientHeight||600;
    axisRenderer = new THREE.WebGLRenderer({canvas:c,antialias:true});
    axisRenderer.setSize(w,h);
    axisRenderer.setPixelRatio(window.devicePixelRatio);
    axisCamera = new THREE.PerspectiveCamera(45,w/h,.01,100);
    axisCamera.position.set(0,2,5);
    axisScene = new THREE.Scene();
    axisScene.background = new THREE.Color(0x020408);
    axisScene.add(new THREE.AmbientLight(0xffffff,.6));
    const dl = new THREE.DirectionalLight(0x00d4ff,1.2); dl.position.set(2,3,2); axisScene.add(dl);

    axisOrbit = new THREE.OrbitControls(axisCamera, axisRenderer.domElement);
    axisOrbit.enableDamping = true;

    axisHelper = new THREE.AxesHelper(0.5);
    axisHelper.visible = false;
    axisScene.add(axisHelper);

    c.addEventListener('click', e => {
      if(!axisMesh) return;
      const rect = c.getBoundingClientRect();
      axisMouse.x = ((e.clientX - rect.left)/rect.width)*2-1;
      axisMouse.y = -((e.clientY - rect.top)/rect.height)*2+1;
      axisRaycaster.setFromCamera(axisMouse, axisCamera);
      const intersects = axisRaycaster.intersectObject(axisMesh, true);
      if(intersects.length > 0){
        if(axisClicks.length === 4) axisClicks = []; // reset
        axisClicks.push(intersects[0].point.clone());

        if(axisClicks.length === 1) {
          axisScene.children.filter(ch=>ch.name==='clickPt').forEach(ch=>axisScene.remove(ch));
          axisHelper.visible = false;
          document.getElementById('btn-set-axis').disabled = true;
        }

        const ptMesh = new THREE.Mesh(new THREE.SphereGeometry(0.03), new THREE.MeshBasicMaterial({color:0x00ff88}));
        ptMesh.position.copy(intersects[0].point);
        ptMesh.name = 'clickPt';
        axisScene.add(ptMesh);

        if(axisClicks.length === 4){
          const center = new THREE.Vector3();
          axisClicks.forEach(p => center.add(p));
          center.divideScalar(4);
          axisHelper.position.copy(center);
          axisHelper.visible = true;
          document.getElementById('btn-set-axis').disabled = false;
        }
      }
    });

    const ro = new ResizeObserver(()=>{
      const cw = c.parentElement.clientWidth, ch = c.parentElement.clientHeight;
      if(cw&&ch) { axisRenderer.setSize(cw,ch); axisCamera.aspect=cw/ch; axisCamera.updateProjectionMatrix(); }
    }); ro.observe(c.parentElement);

    function loop(){ axisAnim = requestAnimationFrame(loop); axisOrbit.update(); axisRenderer.render(axisScene,axisCamera); }
    loop();
  }

  // Render list
  const list = document.getElementById('axis-file-list');
  list.innerHTML='';
  Object.keys(uploadedFiles).forEach(name=>{
    const row = document.createElement('div');
    row.className='file-item';
    row.style.cursor='pointer';
    row.innerHTML=`<div class="fi-name">${name}</div>${S.axisOffsets&&S.axisOffsets[name]?'<div style="color:var(--green)">✔ SET</div>':''}`;
    row.onclick = () => loadAxisModel(name);
    list.appendChild(row);
  });
}

function loadAxisModel(fname){
  axisCurrentFile = fname;
  document.getElementById('axis-current-name').textContent = fname;
  document.getElementById('btn-set-axis').disabled = true;
  axisHelper.visible = false;
  axisClicks = [];
  axisScene.children.filter(ch=>ch.name==='clickPt').forEach(ch=>axisScene.remove(ch));

  if(axisMesh) { axisScene.remove(axisMesh); axisMesh=null; }

  const file = uploadedFiles[fname];
  const isSTL = fname.toLowerCase().endsWith('.stl');
  const loader = isSTL ? new THREE.STLLoader() : new THREE.OBJLoader();
  const url = URL.createObjectURL(file);

  loader.load(url, obj=>{
    if(isSTL){
      const mat = new THREE.MeshStandardMaterial({color:0x1a6cf5,roughness:.4,metalness:.6});
      axisMesh = new THREE.Mesh(obj, mat);
    } else {
      axisMesh = obj;
      axisMesh.traverse(c=>{ if(c.isMesh) c.material=new THREE.MeshStandardMaterial({color:0x1a6cf5,roughness:.4,metalness:.6}); });
    }
    axisMesh.scale.setScalar(ARM_CFG.scale);
    axisScene.add(axisMesh);

    const box = new THREE.Box3().setFromObject(axisMesh);
    const ctr = box.getCenter(new THREE.Vector3());
    const sz = box.getSize(new THREE.Vector3());
    axisOrbit.target.copy(ctr);
    axisCamera.position.set(ctr.x, ctr.y + sz.y, ctr.z + sz.z*2);
    axisOrbit.update();

    if(S.axisOffsets && S.axisOffsets[fname]){
      axisHelper.position.set(-S.axisOffsets[fname][0], -S.axisOffsets[fname][1], -S.axisOffsets[fname][2]);
      axisHelper.visible = true;
    }
  });
}

function saveAxisPoint(){
  if(!axisCurrentFile || !axisHelper.visible) return;
  if(!S.axisOffsets) S.axisOffsets = {};
  S.axisOffsets[axisCurrentFile] = [-axisHelper.position.x, -axisHelper.position.y, -axisHelper.position.z];
  toast(`Axis Center Point set for ${axisCurrentFile}`);

  const list = document.getElementById('axis-file-list');
  [...list.children].forEach(c => {
    if(c.querySelector('.fi-name').textContent === axisCurrentFile){
      if(!c.innerHTML.includes('✔')) c.innerHTML += '<div style="color:var(--green)">✔ SET</div>';
    }
  });
}

function launchDashboard(){
  document.getElementById('axis-screen').style.display='none';
  document.getElementById('main').style.display='flex';
  window.dispatchEvent(new Event('resize'));
  ProjectDB.saveFilesForProject(currentProjectId, uploadedFiles, quantities).then(()=>{
    return ProjectDB.loadProject(currentProjectId).then(proj => {
      proj.axisOffsets = S.axisOffsets;
      return ProjectDB.saveProject(proj);
    });
  }).then(()=>{
    initDashboard();
    // For a brand-new project there's no saved state to restore, but the
    // load-complete hook clears cleanly after all models load.
    if(_pendingModelLoads > 0){
      _onAllModelsLoaded = () => log('All models loaded — ready','ok');
    }
  });
}


// ═══════════════════════════════════════════════════════════════════
//  APPLICATION STATE
// ═══════════════════════════════════════════════════════════════════
const S = {
  savedTransforms: null,

  angles:       [90,90,90,90,90,0],
  targets:      [90,90,90,90,90,0],
  emergency:    false,
  load:         false,
  mode:         'manual',  // 'manual'|'rtos'|'nonrtos'
  replaying:    false,
  qnxConnected: false,
  packets:      0,
  sequence:     [],
  repIdx:       0,
  repFrame:     0,
  editMode:     false,
  wdgHits:      0,
  axisOffsets:  {},
  actuationAxes:{},
  // NON-RTOS state
  nrJoint:      0,
  nrTimer:      0,
  jitterT:      0,

  // ── Simulation engine state ────────────────────────────────────
  // rtosRunning: true while QNX replay is ACTIVE (sliders locked, angles driven by WS)
  rtosRunning:  false,
  // rtosCycling: true while QNX is looping continuously (SEQ_STOP not yet sent)
  rtosCycling:  false,
  // rtosCycleCount: number of full passes completed in the current run
  rtosCycleCount: 0,
  // nonrtosRunning: true while NON-RTOS replay is active (JS driven)
  nonrtosRunning: false,

  // For deterministic timing (RTOS mode):
  //   Each pose must complete within RTOS_POSE_DURATION_MS (1000ms).
  //   We track start time per pose and check watchdog.
  rtosPoseStart:   0,
  rtosPoseIdx:     0,

  // For NON-RTOS timing: poses take 1300ms each (13% slower)
  nrPoseStart:     0,
  nrPoseIdx:       0,

  // Emergency source: 'rtos'|'nonrtos'|null
  emergencySource: null,

  // NON-RTOS: flag that emergency was triggered mid-pose
  nrEmergencyPending: false,

  // Item 6: true while waiting for QNX's EMERGENCY_CLEARED confirmation
  // after requestEmergencyReset() sent RESET_EMERGENCY to QNX.
  _resetPending: false,

  // ── Bug fix (Phase 2 testing, item 1 — "first RTOS send" issue) ──
  // QNX keeps streaming idle sine-wave telemetry whenever it isn't
  // cycling a recorded sequence, but the dashboard only applies incoming
  // "angles" packets to S.targets while S.rtosRunning is true (idle
  // telemetry is intentionally not visualized). That means the moment
  // RTOS is first activated, S.targets/S.angles can be far from QNX's
  // TRUE current position (wherever the idle sine wave had wandered to),
  // and the normal per-frame lerp (LR_RTOS=0.12) sweeps through that gap
  // visibly before catching up — looking like the arm "doing something
  // unexpected" for the first second or so. On a second send shortly
  // after, S.angles was already being actively tracked during the first
  // run, so the gap is small and the same lerp looks smooth/correct.
  // Fix: when this flag is set, the very next real "angles" packet from
  // QNX hard-snaps S.angles (not just S.targets) to that packet's values
  // — no sweep — so the visualization always starts a fresh RTOS run
  // exactly where QNX physically is, regardless of how long QNX was
  // idling beforehand. See sendToQNX() and the 'angles' handler below.
  _rtosSyncPending: false,

  // ── Pose duration (ms/pose), user-configurable — Phase 2 item 5 ──
  // QNX and bridge.py already fully support an arbitrary per-pose
  // duration (SEQ_START:<n>:<dur_ms>); only the dashboard hardcoded it.
  poseDurationMs: 1000,

  // ── NON-RTOS pose duration (Item 2, this pass) ──────────────────
  // Same idea as poseDurationMs above but purely dashboard-side — the
  // JS simulation loop uses this directly, no QNX/bridge involvement.
  nrPoseDurationMs: 1300,
};

// ── Timing constants ──────────────────────────────────────────────
const RTOS_POSE_DURATION_MS = 1000;   // historical default only — actual duration is now user-configurable via S.poseDurationMs (Phase 2 item 5), initialized to this same 1000ms value
const NR_POSE_DURATION_MS   = 1300;   // historical default only — actual duration is now user-configurable via S.nrPoseDurationMs (Item 2), initialized to this same 1300ms value
const RTOS_LERP             = 0.10;   // smooth per-frame lerp (simultaneous all joints)
const NR_LERP               = 0.06;   // slower lerp (sequential joints)
const NR_SLOT               = 60;     // frames per joint in NON-RTOS sequential mode
const REP_DUR               = 168;    // legacy replay frame counter (manual mode)
const LR_RTOS               = 0.12;
const LR_NR                 = 0.05;
const JIT_AMP               = 25;
let fps=0,fpsF=0,fpsLast=performance.now();

let _dragJustFinished = false;

// Calibration data: calibrationData[pivotUUID] = { q0, q90, q180 }
const calibrationData = {};
let jointControlEditActive = false;
let _renameTargetId = null;

// Undo/Redo History
const editState = { history: [], redo: [], dragPos: new THREE.Vector3(), dragRot: new THREE.Euler() };
function undoEdit(){
  if(!S.editMode || editState.history.length===0) return;
  const action = editState.history.pop();
  action.obj.position.copy(action.oldPos);
  action.obj.rotation.copy(action.oldRot);
  editState.redo.push(action);
}
function redoEdit(){
  if(!S.editMode || editState.redo.length===0) return;
  const action = editState.redo.pop();
  action.obj.position.copy(action.newPos);
  action.obj.rotation.copy(action.newRot);
  editState.history.push(action);
}
document.addEventListener('keydown', e => {
  if(S.editMode) {
    if(e.key === 'Escape'){
      transform.detach();
      document.getElementById('edit-actuation-panel').style.display='none';
      document.getElementById('calib-menu').classList.remove('visible');
      document.getElementById('axis-angle-overlay').innerHTML='';
      ['btn-act-x','btn-act-horiz','btn-act-vert'].forEach(id=>{const el=document.getElementById(id);if(el)el.classList.remove('active');});
      log('Selection cleared (Esc)','info');
      return;
    }
    if(e.ctrlKey) {
      if(e.key.toLowerCase() === 'z') { e.preventDefault(); undoEdit(); }
      if(e.key.toLowerCase() === 'y') { e.preventDefault(); redoEdit(); }
    } else {
      if(e.key.toLowerCase() === 't') { transform.setMode('translate'); }
      if(e.key.toLowerCase() === 'r') { transform.setMode('rotate'); }
      if(e.key.toLowerCase() === 'l') { transform.setSpace(transform.space === 'local' ? 'world' : 'local'); }
    }
  }
});

// Joint display config
const JOINTS=[
  {id:'J0',name:'Base Yaw',    min:0, max:180, col:'#4d9fff',tag:'J0'},
  {id:'J1',name:'Shoulder',    min:0, max:180, col:'#b56aff',tag:'J1'},
  {id:'J2',name:'Elbow',       min:0, max:180, col:'#00d4ff',tag:'J2'},
  {id:'J3',name:'Wrist Pitch', min:0, max:180, col:'#00e676',tag:'J3'},
  {id:'J4',name:'Wrist Roll',  min:0, max:180, col:'#ffb347',tag:'J4'},
  {id:'J5',name:'Gripper',     min:0, max:100, col:'#ff47b3',tag:'J5'},
];


// ─── Async model load tracker ────────────────────────────────────────────────
// Counts how many OBJ/STL XHR loads are still in-flight.
// restoreProjectState is called only after ALL models finish (avoids the
// 1400ms magic-number race where scene.traverse finds no objects yet).
let _pendingModelLoads = 0;
let _onAllModelsLoaded = null;
function _modelLoadDone(){
  _pendingModelLoads = Math.max(0, _pendingModelLoads - 1);
  if(_pendingModelLoads === 0 && _onAllModelsLoaded){
    const cb = _onAllModelsLoaded;
    _onAllModelsLoaded = null;
    // Small rAF delay so Three.js geometry is fully committed before traversal
    requestAnimationFrame(cb);
  }
}


let renderer,scene,camera,orbit,transform,arm;
let _isDashboardInit = false;

function initDashboard(){
  buildSliders();
  initThree();
  if(!_isDashboardInit) {
    _isDashboardInit = true;
    connectWS();
    requestAnimationFrame(loop);
  }
  // Initialize mode-dependent UI (run/send buttons visibility)
  updateModeUI();
}

let _threeInitialized = false;
function initThree(){
  if(_threeInitialized){
    const oldBase = scene.getObjectByName('Static_Base');
    if(oldBase) {
      oldBase.traverse(c => {
        if(c.isMesh) {
          if(c.geometry) c.geometry.dispose();
          if(c.material) {
            if(Array.isArray(c.material)) c.material.forEach(m => m.dispose());
            else c.material.dispose();
          }
        }
      });
      scene.remove(oldBase);
    }
    arm = buildArm();
    return;
  }
  _threeInitialized = true;

  const canvas = document.getElementById('three-canvas');
  const wrap   = document.getElementById('viewport');
  renderer = new THREE.WebGLRenderer({canvas,antialias:true});
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.shadowMap.enabled=true;
  renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  renderer.toneMapping=THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure=1.1;
  scene = new THREE.Scene();
  scene.background=new THREE.Color(0x020408);
  scene.fog=new THREE.FogExp2(0x020408,.03);
  camera=new THREE.PerspectiveCamera(45,1,.1,200);
  camera.position.set(3,4,9);
  orbit=new THREE.OrbitControls(camera,renderer.domElement);
  orbit.enableDamping=true; orbit.dampingFactor=.08;
  orbit.target.set(0,2.5,0); orbit.update();
  transform=new THREE.TransformControls(camera,renderer.domElement);
  transform.setSpace('local');
  transform.addEventListener('dragging-changed',e=>{
    orbit.enabled=!e.value;
    if(!e.value){
      _dragJustFinished = true;
      setTimeout(()=>_dragJustFinished = false, 150);
      if(!transform.object) return;
      editState.history.push({
        obj: transform.object,
        oldPos: editState.dragPos.clone(),
        oldRot: editState.dragRot.clone(),
        newPos: transform.object.position.clone(),
        newRot: transform.object.rotation.clone()
      });
      editState.redo = [];
      autoSave();
    } else {
      if(!transform.object) return;
      editState.dragPos.copy(transform.object.position);
      editState.dragRot.copy(transform.object.rotation);
    }
  });
  transform.addEventListener('change', () => {
    // Keep coord inputs in sync during drag
    if(S.editMode && transform.object) updateCoordInputs();
  });
  scene.add(transform);

  renderer.domElement.addEventListener('click', editClick);

  // Resize
  const ro=new ResizeObserver(()=>{
    const W=wrap.clientWidth,H=wrap.clientHeight;
    renderer.setSize(W,H); camera.aspect=W/H; camera.updateProjectionMatrix();
  }); ro.observe(wrap);

  // Lighting
  scene.add(new THREE.AmbientLight(0x304060,.5));
  const sun=new THREE.DirectionalLight(0xffffff,1.3); sun.position.set(-3,8,-5); sun.castShadow=true;
  sun.shadow.mapSize.set(2048,2048); scene.add(sun);
  const rim=new THREE.PointLight(0x0a84ff,2,18); rim.position.set(5,7,3); scene.add(rim);
  const fill=new THREE.PointLight(0xff8040,.5,14); fill.position.set(-4,2,-3); scene.add(fill);

  // Floor
  const fgeo=new THREE.PlaneGeometry(24,24);
  const fmat=new THREE.MeshStandardMaterial({color:0x060c14,roughness:.95,metalness:.1});
  const floor=new THREE.Mesh(fgeo,fmat); floor.rotation.x=-Math.PI/2; floor.receiveShadow=true; scene.add(floor);
  const grid=new THREE.GridHelper(24,24,0x0f1a2e,0x0f1a2e); grid.position.y=.002; scene.add(grid);
  const rg=new THREE.RingGeometry(1.05,1.25,64);
  const rm=new THREE.MeshBasicMaterial({color:0x0a84ff,side:THREE.DoubleSide});
  const ring=new THREE.Mesh(rg,rm); ring.rotation.x=-Math.PI/2; ring.position.y=.005; scene.add(ring);

  // Build arm
  arm = buildArm();
}


// ═══════════════════════════════════════════════════════════════════
//  ROBOTIC ARM ASSEMBLY — Forward Kinematic Hierarchy
// ═══════════════════════════════════════════════════════════════════

// ── Tunable offsets (change these to align your specific CAD parts) ──
const ARM_CFG = {
  scale:         0.012,
  baseH:         0.45,
  shoulderH:     1.05,
  elbowH:        0.95,
  wristPitchH:   0.80,
  wristRollH:    0.65,
  gripOffsetX:   0.05,
  gripOffsetY:   0.12,
  jawOffsetY:    0.16,
  maxGripAngle:  0.45,
};

function buildArm(){
  // Reset async load tracker for this build — must be 0 before any loader.load() calls
  _pendingModelLoads = 0;
  _onAllModelsLoaded = null;

  const mats={
    blue  : new THREE.MeshStandardMaterial({color:0x1a6cf5,roughness:.3,metalness:.7}),
    gray  : new THREE.MeshStandardMaterial({color:0x8090b0,roughness:.4,metalness:.6}),
    dark  : new THREE.MeshStandardMaterial({color:0x304060,roughness:.5,metalness:.5}),
    gear  : new THREE.MeshStandardMaterial({color:0x405070,roughness:.4,metalness:.8}),
    grip  : new THREE.MeshStandardMaterial({color:0xb0c0d8,roughness:.35,metalness:.65}),
    orange: new THREE.MeshStandardMaterial({color:0xff8020,roughness:.4,metalness:.5}),
  };

  const allMeshes=[];

  // ── Resolve uploaded file by base name (.obj OR .stl) ──
  function getFileEntry(expectedFname){
    const base = expectedFname.replace(/\.(obj|stl)$/i, '').toLowerCase();
    for(let k in uploadedFiles){
      if(k.replace(/\.(obj|stl)$/i, '').toLowerCase() === base)
        return { key: k, file: uploadedFiles[k] };
    }
    return { key: expectedFname, file: null };
  }

  // ── Apply saved edit-mode transform ──
  function applySavedTransform(obj){
    if(!S.savedTransforms) return;
    let t = null;
    if(obj.name && obj.name.endsWith('_Offset')){
      t = S.savedTransforms.find(x => x.name === obj.name);
    } else if(obj.userData && obj.userData.partId){
      t = S.savedTransforms.find(x => x.partId === obj.userData.partId);
    }
    if(t){ obj.position.set(...t.pos); obj.rotation.set(...t.rot); }
  }

  // Helper to make a joint with an offset group (for editing/assembly) and act group (for rotation)
  function makeJoint(name, parentAct, offsetPos, partId) {
    const offsetGrp = new THREE.Group();
    offsetGrp.name = name + '_Offset';
    offsetGrp.userData.partId = partId;
    offsetGrp.userData.isOffsetGroup = true;
    if (offsetPos) offsetGrp.position.set(...offsetPos);
    parentAct.add(offsetGrp);

    const actGrp = new THREE.Group();
    actGrp.name = name;
    offsetGrp.add(actGrp);

    applySavedTransform(offsetGrp);
    return { offset: offsetGrp, act: actGrp };
  }

  // ── Load a model file into a group ──
  function loadModelInto(fname, group, mat, meshOffset, meshRot, partId, isBase){
    const entry = getFileEntry(fname);
    const file  = entry.file;
    const qty   = quantities[entry.key] || 1;
    const pid   = partId || fname+'_0';
    if(file){
      const isSTL = file.name.toLowerCase().endsWith('.stl');
      const ldr   = isSTL ? new THREE.STLLoader() : new THREE.OBJLoader();
      const url   = URL.createObjectURL(file);
      _pendingModelLoads++;                        // ← track this load
      ldr.load(url, obj=>{
        let baseMesh = obj;
        if(isSTL) baseMesh = new THREE.Mesh(obj, mat.clone());
        baseMesh.scale.setScalar(ARM_CFG.scale);

        let mo = S.axisOffsets && S.axisOffsets[entry.key] ? S.axisOffsets[entry.key] : meshOffset;
        if(mo) {
           const sc = 1 / ARM_CFG.scale;
           if (!isSTL) {
             baseMesh.traverse(c => {
               if (c.isMesh) {
                 c.geometry.translate(mo[0]*sc, mo[1]*sc, mo[2]*sc);
                 c.geometry.computeBoundingBox();
               }
             });
           } else {
             baseMesh.geometry.translate(mo[0]*sc, mo[1]*sc, mo[2]*sc);
             baseMesh.geometry.computeBoundingBox();
           }
        }
        if(meshRot) baseMesh.rotation.set(...meshRot);

        baseMesh.userData.partId = pid;
        baseMesh.userData.isBase = false;
        applySavedTransform(baseMesh);
        if(!isSTL) baseMesh.traverse(c=>{ if(c.isMesh){ c.material=mat.clone(); c.userData.origColor = c.material.color.clone(); c.castShadow=true; c.receiveShadow=true; allMeshes.push(c); }});
        else { baseMesh.userData.origColor = baseMesh.material.color.clone(); baseMesh.castShadow=true; baseMesh.receiveShadow=true; allMeshes.push(baseMesh); }
        group.add(baseMesh);

        for(let i=1; i<qty; i++){
           const clone = baseMesh.clone(true);
           clone.userData.partId = fname + '_' + i;
           clone.position.x += i * 0.4;
           applySavedTransform(clone);
           group.add(clone);
           if(isSTL) allMeshes.push(clone);
           else clone.traverse(c=>{ if(c.isMesh) allMeshes.push(c); });
        }
        log(`Loaded ${file.name} (qty:${qty})`,'info');
        _modelLoadDone();                          // ← mark complete
      }, undefined, ()=>{
        for(let i=0; i<qty; i++){
          let off = meshOffset ? [...meshOffset] : [0,0,0];
          off[0] += i * 0.4;
          addPrimitive(fname, group, mat, off, allMeshes, i===0 ? pid : fname+'_'+i);
        }
        _modelLoadDone();                          // ← mark complete (error path)
      });
    } else {
      for(let i=0; i<qty; i++){
        let off = meshOffset ? [...meshOffset] : [0,0,0];
        off[0] += i * 0.4;
        addPrimitive(fname, group, mat, off, allMeshes, i===0 ? pid : fname+'_'+i);
      }
    }
  }

  // ── Load a model, add original to groupL, clone to groupR ──
  function loadModelCloned(fname, groupL, groupR, mat, meshOffset, pidL, pidR){
    const entry = getFileEntry(fname);
    const file  = entry.file;
    if(!file) return;
    const isSTL = file.name.toLowerCase().endsWith('.stl');
    const ldr   = isSTL ? new THREE.STLLoader() : new THREE.OBJLoader();
    const url   = URL.createObjectURL(file);
    _pendingModelLoads++;                          // ← track this load
    ldr.load(url, obj=>{
      let mesh = obj;
      if(isSTL) mesh = new THREE.Mesh(obj, mat.clone());
      mesh.scale.setScalar(ARM_CFG.scale);

      let mo = S.axisOffsets && S.axisOffsets[entry.key] ? S.axisOffsets[entry.key] : meshOffset;
      if(mo) {
           const sc = 1 / ARM_CFG.scale;
           if (!isSTL) {
             mesh.traverse(c => {
               if (c.isMesh) {
                 c.geometry.translate(mo[0]*sc, mo[1]*sc, mo[2]*sc);
                 c.geometry.computeBoundingBox();
               }
             });
           } else {
             mesh.geometry.translate(mo[0]*sc, mo[1]*sc, mo[2]*sc);
             mesh.geometry.computeBoundingBox();
           }
      }

      mesh.userData.partId = pidL;
      applySavedTransform(mesh);
      if(!isSTL) mesh.traverse(c=>{ if(c.isMesh){ c.material=mat.clone(); c.userData.origColor = c.material.color.clone(); c.castShadow=true; c.receiveShadow=true; allMeshes.push(c); }});
      else { mesh.userData.origColor = mesh.material.color.clone(); mesh.castShadow=true; mesh.receiveShadow=true; allMeshes.push(mesh); }
      groupL.add(mesh);

      const clone = mesh.clone(true);

      clone.userData.partId = pidR;
      applySavedTransform(clone);
      if(isSTL) { clone.userData.origColor = clone.material.color.clone(); allMeshes.push(clone); }
      else clone.traverse(c=>{ if(c.isMesh) { c.userData.origColor = c.material.color.clone(); allMeshes.push(c); }});
      groupR.add(clone);
      log(`Loaded ${file.name} (+ mirror)`,'info');
      _modelLoadDone();                            // ← mark complete
    }, undefined, () => _modelLoadDone());         // ← mark complete (error path)
  }

  // ═════════════════════════════════════════════════════════════════
  //  KINEMATIC CHAIN
  // ═════════════════════════════════════════════════════════════════

  // Static Base — ALWAYS at scene center (0,0,0), never moved by saved transforms
  const staticBase = new THREE.Group(); staticBase.name='Static_Base';
  scene.add(staticBase);
  loadModelInto('Base.obj', staticBase, mats.dark, null, null, 'Base.obj_0', true/*isBase*/);

  // J0 (Base Yaw): Y-Axis
  const j0 = makeJoint('J0_Base', staticBase, [0, ARM_CFG.baseH, 0], 'J0_Offset');
  loadModelInto('Waist.obj', j0.act, mats.blue, null, null, 'Waist.obj_0');

  // J1 (Shoulder Pitch): Z-Axis
  const j1 = makeJoint('J1_Shoulder', j0.act, [0, ARM_CFG.shoulderH, 0], 'J1_Offset');
  loadModelInto('Arm 01.obj', j1.act, mats.blue, null, null, 'Arm 01.obj_0');

  // J2 (Elbow Pitch): Z-Axis
  const j2 = makeJoint('J2_Elbow', j1.act, [0, ARM_CFG.elbowH, 0], 'J2_Offset');
  loadModelInto('Arm 02 v3.obj', j2.act, mats.blue, null, null, 'Arm 02 v3.obj_0');

  // J3 (Wrist Pitch): Z-Axis
  const j3 = makeJoint('J3_WristPitch', j2.act, [0, ARM_CFG.wristPitchH, 0], 'J3_Offset');
  loadModelInto('Arm 03.obj', j3.act, mats.blue, null, null, 'Arm 03.obj_0');

  // J4 (Wrist Roll): Y-Axis
  const j4 = makeJoint('J4_WristRoll', j3.act, [0, ARM_CFG.wristRollH, 0], 'J4_Offset');
  loadModelInto('Gripper base.obj', j4.act, mats.grip, null, null, 'Gripper base.obj_0');

  // ═════════════════════════════════════════════════════════════════
  //  GRIPPER SUB-ASSEMBLY
  // ═════════════════════════════════════════════════════════════════

  // Gripper Root
  const gripperRoot = makeJoint('Gripper_Root', j4.act, [0,0,0], 'Gripper_Root_Offset');

  // ── Left Gear Pivot ──
  const leftGearPiv = makeJoint('Left_Gear_Pivot', gripperRoot.act, [-ARM_CFG.gripOffsetX, ARM_CFG.gripOffsetY, 0], 'Left_Gear_Offset');
  loadModelInto('gear1.obj', leftGearPiv.act, mats.gear, [ARM_CFG.gripOffsetX, -ARM_CFG.gripOffsetY, 0], null, 'gear1.obj_0');

  // ── Right Gear Pivot ──
  const rightGearPiv = makeJoint('Right_Gear_Pivot', gripperRoot.act, [ARM_CFG.gripOffsetX, ARM_CFG.gripOffsetY, 0], 'Right_Gear_Offset');
  loadModelInto('gear2.obj', rightGearPiv.act, mats.gear, [-ARM_CFG.gripOffsetX, -ARM_CFG.gripOffsetY, 0], null, 'gear2.obj_0');

  // ── Left Jaw Pivot ──
  const leftJawPiv = makeJoint('Left_Jaw_Pivot', gripperRoot.act, [-ARM_CFG.gripOffsetX, ARM_CFG.jawOffsetY, 0], 'Left_Jaw_Offset');

  // ── Right Jaw Pivot ──
  const rightJawPiv = makeJoint('Right_Jaw_Pivot', gripperRoot.act, [ARM_CFG.gripOffsetX, ARM_CFG.jawOffsetY, 0], 'Right_Jaw_Offset');

  // ── Left Link Pivot ──
  const leftLinkPiv = makeJoint('Left_Link_Pivot', gripperRoot.act, [-ARM_CFG.gripOffsetX, ARM_CFG.jawOffsetY, 0], 'Left_Link_Offset');

  // ── Right Link Pivot ──
  const rightLinkPiv = makeJoint('Right_Link_Pivot', gripperRoot.act, [ARM_CFG.gripOffsetX, ARM_CFG.jawOffsetY, 0], 'Right_Link_Offset');

  // Load grip link 1 → left link, clone → right link
  loadModelCloned('grip link 1.obj', leftLinkPiv.act, rightLinkPiv.act, mats.blue,
    null, 'grip link 1.obj_L', 'grip link 1.obj_R');

  // Load Gripper 1 (jaw) → left jaw, clone → right jaw
  loadModelCloned('Gripper 1.obj', leftJawPiv.act, rightJawPiv.act, mats.grip,
    null, 'Gripper 1.obj_L', 'Gripper 1.obj_R');

  // ── Fallback primitives if no file uploaded ──
  if(!getFileEntry('grip link 1.obj').file){
    const lnkL = new THREE.Mesh(new THREE.BoxGeometry(.04,.3,.04), mats.blue.clone());
    lnkL.userData.partId='grip link 1.obj_L'; lnkL.position.set(0,.14,0);
    lnkL.castShadow=true; allMeshes.push(lnkL); leftLinkPiv.act.add(lnkL);
    const lnkR = lnkL.clone(); lnkR.userData.partId='grip link 1.obj_R';
    allMeshes.push(lnkR); rightLinkPiv.act.add(lnkR);
  }
  if(!getFileEntry('Gripper 1.obj').file){
    const jawL = new THREE.Mesh(new THREE.BoxGeometry(.06,.28,.06), mats.grip.clone());
    jawL.userData.partId='Gripper 1.obj_L'; jawL.position.set(-.015,.32,0);
    jawL.castShadow=true; allMeshes.push(jawL); leftJawPiv.act.add(jawL);
    const jawR = jawL.clone(); jawR.userData.partId='Gripper 1.obj_R';
    jawR.position.set(.015,.32,0);
    allMeshes.push(jawR); rightJawPiv.act.add(jawR);
  }

  // ═════════════════════════════════════════════════════════════════
  //  RETURN ARM INTERFACE
  // ═════════════════════════════════════════════════════════════════
  const pivots = [j0.act, j1.act, j2.act, j3.act, j4.act, gripperRoot.act,
                  leftGearPiv.act, rightGearPiv.act, leftJawPiv.act, rightJawPiv.act, leftLinkPiv.act, rightLinkPiv.act];

  return {
    j0: j0.act, j1: j1.act, j2: j2.act, j3: j3.act, j4: j4.act,
    gripperRoot: gripperRoot.act, leftGearPiv: leftGearPiv.act, rightGearPiv: rightGearPiv.act, leftJawPiv: leftJawPiv.act, rightJawPiv: rightJawPiv.act,
    leftLinkPiv: leftLinkPiv.act, rightLinkPiv: rightLinkPiv.act,
    pivots, allMeshes, origColors: null,

    applyGrip(v){
      const angle = (v / 100) * ARM_CFG.maxGripAngle;
      leftGearPiv.act.rotation.z  = -angle;
      leftJawPiv.act.rotation.z   = -angle;
      leftLinkPiv.act.rotation.z  = -angle;
      rightGearPiv.act.rotation.z =  angle;
      rightJawPiv.act.rotation.z  =  angle;
      rightLinkPiv.act.rotation.z =  angle;
    }
  };
}

function addPrimitive(fname,pivot,mat,offset,list,partId){
  const sizes={
    'Base.obj':[.8,.45,.8],'Waist.obj':[.6,.5,.6],'Arm 01.obj':[.22,1.1,.22],
    'Arm 02 v3.obj':[.19,.9,.19],'Arm 03.obj':[.17,.75,.17],
    'gear1.obj':[.25,.06,.25],'gear2.obj':[.22,.05,.22],
    'Gripper base.obj':[.35,.1,.3],'Gripper 1.obj':[.06,.28,.06],'grip link 1.obj':[.04,.3,.04],
  };
  const sz=sizes[fname]||[.3,.3,.3];
  const m=new THREE.Mesh(new THREE.BoxGeometry(...sz),mat.clone());
  m.userData.origColor = m.material.color.clone();
  if(partId) m.userData.partId = partId;
  if(S.savedTransforms && partId) {
     const t = S.savedTransforms.find(x => x.partId === partId);
     if(t) { m.position.set(...t.pos); m.rotation.set(...t.rot); }
     else m.position.set(offset[0],offset[1]||sz[1]/2,offset[2]);
  } else {
     m.position.set(offset[0],offset[1]||sz[1]/2,offset[2]);
  }
  m.castShadow=true; m.receiveShadow=true; list.push(m); pivot.add(m);
}




// ═══════════════════════════════════════════════════════════════════
//  ARM ANIMATION
// ═══════════════════════════════════════════════════════════════════
function applyAngles(a){
  if(!arm) return;
  const D=Math.PI/180;

  arm.pivots.forEach((piv, i) => {
     if(i >= 5) return;

     // Try SLERP from calibration data first — keyed by pivot name (stable across sessions)
     const cd = calibrationData[piv.name];
     if(cd && cd.q0 && cd.q90){
       const val = a[i]; // 0–180
       const q = new THREE.Quaternion();
       if(val <= 90){
         const t = Math.max(0, Math.min(1, val / 90));
         q.slerpQuaternions(cd.q0, cd.q90, t);
       } else {
         if(cd.q180){
           const t = Math.max(0, Math.min(1, (val - 90) / 90));
           q.slerpQuaternions(cd.q90, cd.q180, t);
         } else {
           // Extrapolate: continue SLERP direction past q90
           const t = Math.max(0, Math.min(1, val / 90));
           q.slerpQuaternions(cd.q0, cd.q90, t);
         }
       }
       piv.quaternion.copy(q);
       return;
     }

     // Fallback: axis-based rotation
     let axis = null;
     if(S.actuationAxes){
       piv.children.forEach(c => {
         if(c.userData && c.userData.partId && S.actuationAxes[c.userData.partId]) axis = S.actuationAxes[c.userData.partId];
       });
     }
     if(!axis){
       if(i===0) axis='Y';
       else if(i===1) axis='Z';
       else if(i===2) axis='Z';
       else if(i===3) axis='Z';
       else if(i===4) axis='Y';
     }

     piv.rotation.set(0,0,0);
     if(axis === 'Y') piv.rotation.y = a[i]*D;
     if(axis === 'Z') piv.rotation.z = a[i]*D;
     if(axis === 'X') piv.rotation.x = a[i]*D;
  });

  arm.applyGrip(a[5]);
}

let _emCached=null;
function setEmergencyColor(on){
  if(on===_emCached||!arm) return;
  _emCached=on;
  arm.allMeshes.forEach(m=>{
    if(m.material&&m.material.color) {
      if(on) m.material.color.set(0xff2244);
      else if(m.userData.origColor) m.material.color.copy(m.userData.origColor);
      else m.material.color.set(0x1a6cf5);
    }
  });
}


// ═══════════════════════════════════════════════════════════════════
//  MAIN ANIMATION LOOP — Full Simulation Engine
// ═══════════════════════════════════════════════════════════════════
function loop(){
  requestAnimationFrame(loop);
  fpsF++;
  const now=performance.now();
  if(now-fpsLast>=1000){ fps=fpsF; fpsF=0; fpsLast=now; }

  // ── Emergency: freeze everything ──────────────────────────────
  if(S.emergency){
    setEmergencyColor(true);
    document.getElementById('emerg-overlay').classList.add('show');
    applyAngles(S.angles);
    orbit&&orbit.update();
    renderer&&renderer.render(scene,camera);
    updateUI();
    return;
  }

  setEmergencyColor(false);
  document.getElementById('emerg-overlay').classList.remove('show');

  // ── MANUAL mode ───────────────────────────────────────────────
  if(S.mode==='manual'){
    for(let i=0;i<6;i++) S.angles[i]+=(S.targets[i]-S.angles[i])*.15;
  }

  // ── NON-RTOS simulation ───────────────────────────────────────
  else if(S.mode==='nonrtos'){
    if(S.nonrtosRunning && S.sequence.length>0){
      _tickNonRTOS(now);
    } else {
      // idle: manual lerp still works
      for(let i=0;i<6;i++) S.angles[i]+=(S.targets[i]-S.angles[i])*.15;
    }
  }

  // ── RTOS mode ─────────────────────────────────────────────────
  else if(S.mode==='rtos'){
    if(S.rtosRunning){
      // Angles come from QNX via WebSocket → S.targets already set in ws.onmessage
      // Just smooth-interpolate toward whatever QNX sent (simultaneous all joints)
      for(let i=0;i<6;i++) S.angles[i]+=(S.targets[i]-S.angles[i])*LR_RTOS;
    } else {
      // idle
      for(let i=0;i<6;i++) S.angles[i]+=(S.targets[i]-S.angles[i])*.15;
    }
  }

  applyAngles(S.angles);
  orbit&&orbit.update();
  renderer&&renderer.render(scene,camera);
  updateUI();
  updateAxisAngleOverlay();
}

// ─── NON-RTOS tick ───────────────────────────────────────────────
function _tickNonRTOS(now){
  // If emergency was pending (triggered while mid-pose), only stop AFTER current pose finishes
  const elapsed = now - S.nrPoseStart;
  const pose = S.sequence[S.nrPoseIdx];

  // Apply jitter on top joints (J3, J4) if load is ON
  let jitter = [0,0,0,0,0,0];
  if(S.load){
    S.jitterT += 0.018;
    const j = JIT_AMP * Math.sin(S.jitterT * 22) * Math.sin(S.jitterT * 7.3);
    jitter[3] = j * 0.6;
    jitter[4] = j;
  }

  // NON-RTOS: sequential joint movement — move one joint at a time
  const jointPhase = elapsed / S.nrPoseDurationMs; // 0→1 over the configured duration
  const jointPerPhase = 1 / 6;
  const activeJoint = Math.min(5, Math.floor(jointPhase / jointPerPhase));
  for(let i=0;i<=activeJoint;i++){
    S.angles[i] += (pose[i] + jitter[i] - S.angles[i]) * NR_LERP;
  }

  // Pose complete after the configured NON-RTOS pose duration
  if(elapsed >= S.nrPoseDurationMs){
    // Advance to next pose
    S.nrPoseIdx++;
    if(S.nrPoseIdx >= S.sequence.length){
      // Cycle complete — stop NOW if emergency was pending
      if(S.nrEmergencyPending){
        S.nrEmergencyPending = false;
        S.emergency = true;
        S.emergencySource = 'nonrtos';
        S.nonrtosRunning = false;
        _updateSafetyLockUI();
        log('⚠ NON-RTOS Emergency: stopped after cycle completed','warn');
        highlightCurrentPose(-1);
        return;
      }
      S.nrPoseIdx = 0; // loop
    }
    S.nrPoseStart = now;
    highlightCurrentPose(S.nrPoseIdx);
    log(`NON-RTOS: Pose #${S.nrPoseIdx+1} starting (${S.nrPoseDurationMs}ms/pose)`,'warn');
  }
}


// ═══════════════════════════════════════════════════════════════════
//  UI BUILDERS
// ═══════════════════════════════════════════════════════════════════
function buildSliders(){
  const sec=document.getElementById('slider-section');
  sec.innerHTML='';
  JOINTS.forEach((j,i)=>{
    const isG = i===5;
    const min = j.min;
    const max = j.max;
    const unit = isG ? '' : '°';
    const initAngle = S.targets[i] !== undefined ? S.targets[i] : 0;
    const initVal = isG ? Math.round(initAngle).toString() : `${initAngle>=0?'+':''}${initAngle.toFixed(1)}°`;
    sec.innerHTML+=`
    <div class="joint-block">
      <div class="joint-hdr">
        <div class="j-tag" style="background:${j.col};color:${i===3||i===4?'black':'white'}">${j.tag}</div>
        <div class="j-name">${j.name}</div>
        <div class="j-val" id="jv${i}" style="color:${j.col}">${initVal}</div>
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <span style="font-size:9px;color:var(--fg3)">${min}${unit}</span>
        <input type="range" id="js${i}" min="${min}" max="${max}" value="${initAngle}" step="0.5"
          oninput="onSlider(${i},this.value)" style="flex:1">
        <span style="font-size:9px;color:var(--fg3)">${max>0?'+':''}${max}${unit}</span>
      </div>
      ${isG ? `
        <div style="margin-top:12px;padding:6px;background:var(--bg2);border:1px solid var(--bg4);border-radius:4px">
          <svg id="grip-diagram" width="100%" height="80" viewBox="0 0 220 80">
            <line x1="110" y1="10" x2="110" y2="40" stroke="#5a7aaa" stroke-width="2"/>
            <rect x="85" y="35" width="50" height="10" rx="2" fill="#0f1a2e" stroke="#1e2d48"/>
            <circle cx="95" cy="40" r="8" fill="none" stroke="#0a84ff" stroke-width="1.5" stroke-dasharray="4 2"/>
            <circle cx="125" cy="40" r="8" fill="none" stroke="#0a84ff" stroke-width="1.5" stroke-dasharray="4 2"/>
            <line id="gd-ll" x1="80" y1="45" x2="55" y2="72" stroke="#00d4ff" stroke-width="3" stroke-linecap="round"/>
            <rect id="gd-lf" x="40" y="66" width="20" height="8" rx="2" fill="#00d4ff" opacity=".8"/>
            <line id="gd-rl" x1="140" y1="45" x2="165" y2="72" stroke="#00d4ff" stroke-width="3" stroke-linecap="round"/>
            <rect id="gd-rf" x="160" y="66" width="20" height="8" rx="2" fill="#00d4ff" opacity=".8"/>
            <rect id="gd-obj" x="95" y="62" width="30" height="14" rx="3" fill="#ffaa00" opacity=".3" stroke="#ffaa00" stroke-width="1"/>
            <text x="110" y="73" text-anchor="middle" fill="#ffaa00" font-size="8" font-family="Share Tech Mono">GRIP</text>
          </svg>
        </div>
      ` : ''}
    </div>`;
  });
}

function resetJoints() { S.targets = [0,0,0,0,0,0]; }
function homePose() { S.targets = [90,90,90,90,90,0]; }

// ── Pose duration control (Phase 2 item 5, extended to NON-RTOS: item 2) ──
// The same slider/input pair is reused for both RTOS and NON-RTOS — which
// underlying state field it writes to depends on the currently active mode.
// NON-RTOS stays purely dashboard-side either way; nothing here talks to
// the bridge/QNX when S.mode==='nonrtos'.
function setPoseDuration(val){
  const v = Math.max(300, Math.min(5000, Math.round(parseFloat(val)||1000)));
  if(S.mode === 'nonrtos'){
    S.nrPoseDurationMs = v;
  } else {
    S.poseDurationMs = v;
  }
  const sl = document.getElementById('pose-dur-slider');
  const inp = document.getElementById('pose-dur-input');
  if(sl && document.activeElement!==sl) sl.value = v;
  if(inp && document.activeElement!==inp) inp.value = v;
  autoSave();
}

// Called when the mode changes so the slider/input reflect THIS mode's
// stored duration, not whatever the other mode last left displayed.
function _syncPoseDurationDisplay(){
  const v = S.mode === 'nonrtos' ? S.nrPoseDurationMs : S.poseDurationMs;
  const sl = document.getElementById('pose-dur-slider');
  const inp = document.getElementById('pose-dur-input');
  const lbl = document.getElementById('pose-dur-lbl-text');
  if(sl) sl.value = v;
  if(inp) inp.value = v;
  if(lbl) lbl.textContent = S.mode === 'nonrtos' ? 'POSE DURATION (NON-RTOS, local)' : 'POSE DURATION (RTOS → QNX)';
}

let _lastMode=null,_lastEM=null,_lastQNX=null,_lastLoad=null,_lastPkt=-1;
function updateUI(){
  const a=S.angles;
  // Angle strip
  document.getElementById('angle-strip').textContent=
    a.map((v,i)=>i===5 ? `GRIP:${Math.round(v)}%` : `J${i}:${v>=0?'+':''}${v.toFixed(1)}°`).join('  ');

  // Slider readouts
  a.forEach((v,i)=>{
    const lbl=document.getElementById(`jv${i}`);
    if(lbl) lbl.textContent=i===5 ? Math.round(v) : `${v>=0?'+':''}${v.toFixed(1)}°`;
    const sl=document.getElementById(`js${i}`);
    if(sl && document.activeElement !== sl) sl.value=v;
  });

  // Telemetry
  if(S.packets!==_lastPkt){ document.getElementById('t-pkt').textContent=S.packets; _lastPkt=S.packets; }
  document.getElementById('t-fps').textContent=fps;
  document.getElementById('t-seq').textContent=S.sequence.length;
  document.getElementById('t-wdg').textContent=S.wdgHits;

  // QNX badge
  if(S.qnxConnected!==_lastQNX){
    _lastQNX=S.qnxConnected;
    document.getElementById('qnx-dot').className='dot'+(S.qnxConnected?' on':'');
    document.getElementById('qnx-lbl').textContent=S.qnxConnected?'ONLINE':'OFFLINE';
    setLED('led-qnx',S.qnxConnected,'c','');
  }

  // Mode — delegate to updateModeUI only when changed
  if(S.mode!==_lastMode){
    _lastMode=S.mode;
    updateModeUI();
  }

  // Emergency/load LEDs
  if(S.emergency!==_lastEM){
    _lastEM=S.emergency;
    setLED('led-em',S.emergency,'r','');
    setLED('led-ok',!S.emergency&&!S.load,'g','');
    _updateSafetyLockUI();
  }
  if(S.load!==_lastLoad){
    _lastLoad=S.load;
    setLED('led-load',S.load,'a','');
    document.getElementById('btn-load').textContent=S.load?'⚙ REMOVE LOAD':'⚙ ADD LOAD';
    document.getElementById('btn-load').className=S.load?'btn danger':'btn warn';
  }

  // Mode strip realtime status overlay
  const modeStrip = document.getElementById('mode-strip');
  if(S.rtosRunning){
    if(S.rtosCycling){
      modeStrip.textContent=`MODE: RTOS ▶ CYCLING — Cycle #${S.rtosCycleCount} | Pose #${S.rtosPoseIdx+1}/${S.sequence.length} [CONTINUOUS]`;
      modeStrip.style.color='var(--amber)';
    } else {
      // Stop requested — finishing last cycle
      modeStrip.textContent=`MODE: RTOS ▶ STOPPING — Finishing Cycle #${S.rtosCycleCount}…`;
      modeStrip.style.color='var(--fg2)';
    }
  } else if(S.nonrtosRunning){
    modeStrip.textContent=`MODE: NON-RTOS ▶ RUNNING — Pose #${S.nrPoseIdx+1}/${S.sequence.length} [${(S.nrPoseDurationMs/1000).toFixed(1)}s/pose, SEQUENTIAL]${S.nrEmergencyPending?' ⚠ EMERGENCY QUEUED':''}`;
    modeStrip.style.color='var(--amber)';
  } else if(!_lastMode || S.mode!==_lastMode){
    // handled by updateModeUI
  }

  // Gripper diagram
  updateGripDiagram();

  // Replay highlight (pose list)
  // (handled in highlightCurrentPose)
}

function setLED(id,on,colorKey,_){
  const el=document.getElementById(id); if(!el) return;
  const map={g:['led-off-g','led-on-g'],r:['led-off-r','led-on-r'],a:['led-off-a','led-on-a'],c:['led-off-c','led-on-c']};
  const [off,onCls]=map[colorKey];
  el.className='led-dot '+(on?onCls:off);
}

function updateGripDiagram(){
  const t=S.angles[5]/100;
  const spread=t*40;
  const llx1=80,lly1=45,llx2=55-spread,lly2=72;
  const rlx1=140,rly1=45,rlx2=165+spread,rly2=72;
  const lfl=document.getElementById('gd-ll');
  const rfl=document.getElementById('gd-rl');
  const lfb=document.getElementById('gd-lf');
  const rfb=document.getElementById('gd-rf');
  if(lfl){ lfl.setAttribute('x2',llx2); }
  if(rfl){ rfl.setAttribute('x2',rlx2); }
  if(lfb){ lfb.setAttribute('x',llx2-14); }
  if(rfb){ rfb.setAttribute('x',rlx2-6); }
}


// ═══════════════════════════════════════════════════════════════════
//  CONTROLS
// ═══════════════════════════════════════════════════════════════════
let _saveTimer = null;   // ← declared here so autoSave's clearTimeout never throws
function onSlider(idx,val){
  // Always allow slider movement — used for manual control and teach-record pose setup in all modes
  // In RTOS mode during active RTOS replay (QNX driving), sliders are disabled via disableSliders()
  if(!S.rtosRunning){
    S.targets[idx]=parseFloat(val);
    // Debounce: batch rapid slider drags into a single DB write
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(autoSave, 600);
  }
}

function resetJoints(){
  for(let i=0;i<6;i++){ S.targets[i]=0; const s=document.getElementById(`js${i}`); if(s) s.value=0; }
}

function homePose(){
  const h=[0,25,-35,20,0,0];
  h.forEach((v,i)=>{ S.targets[i]=v; const s=document.getElementById(`js${i}`); if(s) s.value=v; });
}

function setMode(m){
  // Stop any running simulation before switching mode
  if(S.nonrtosRunning){ stopSimulation(); }
  if(S.rtosRunning){ stopRTOSReplay(); }
  S.mode=m; S.nrJoint=0; S.nrTimer=0;
  if(ws&&ws.readyState===1&&_wsAuthed) ws.send(JSON.stringify({type:'set_mode',mode:m}));
  log(`Mode set: ${m.toUpperCase()}`,'info');
  updateModeUI();
  autoSave();
}

function updateModeUI(){
  const m = S.mode;
  // Mode buttons
  ['manual','rtos','nonrtos'].forEach(x=>document.getElementById(`mBtn-${x}`).className='mode-btn');
  document.getElementById(`mBtn-${m}`).classList.add(`active-${m}`);
  // NOTE: the explanatory "mode-desc" card that used to sit below the
  // MANUAL/RTOS/NON-RTOS buttons has been removed from the UI (index.html)
  // per request — the three mode buttons and all mode-switching behavior
  // below are unchanged.
  const modeLabels={manual:'MANUAL',rtos:'RTOS',nonrtos:'NON-RTOS'};
  document.getElementById('mode-lbl').textContent=modeLabels[m];
  document.getElementById('mode-strip').textContent='MODE: '+modeLabels[m];
  document.getElementById('mode-strip').style.color=
    m==='rtos'?'var(--green)':m==='nonrtos'?'var(--amber)':'var(--cyan)';
  document.getElementById('mode-dot').style.background=
    m==='rtos'?'var(--green)':m==='nonrtos'?'var(--amber)':'var(--cyan)';

  // Show/hide Send-to-QNX vs Run button based on mode
  const runBtn = document.getElementById('btn-run');
  const sendBtn = document.getElementById('btn-send-qnx');
  if(runBtn) runBtn.style.display = (m==='nonrtos') ? '' : 'none';
  if(sendBtn) sendBtn.style.display = (m==='rtos') ? '' : 'none';

  // Pose duration control: RTOS (→ QNX) and NON-RTOS (local JS sim) both
  // get it now (Item 2) — hidden only in MANUAL, where it's meaningless.
  const poseDurRow = document.getElementById('pose-dur-row');
  if(poseDurRow) poseDurRow.style.display = (m==='rtos' || m==='nonrtos') ? '' : 'none';
  _syncPoseDurationDisplay();

  // STOP CYCLE row is RTOS-only — hide it entirely when not in RTOS mode
  // (also hides if not currently cycling, via _updateCycleUI)
  if(m !== 'rtos'){
    const row = document.getElementById('row-stop-cycle');
    if(row) row.style.display = 'none';
    const btn = document.getElementById('btn-stop-cycle');
    if(btn) btn.style.display = 'none';
    const badge = document.getElementById('tb-cycle-badge');
    if(badge) badge.style.display = 'none';
  } else {
    _updateCycleUI();   // restore correct visibility if re-entering RTOS mode
  }

  // Slider enable/disable: in manual mode always enabled, in rtos/nonrtos enabled for teach-record
  enableSliders();
}

function enableSliders(){
  JOINTS.forEach((_,i)=>{
    const sl=document.getElementById(`js${i}`);
    if(sl) sl.disabled = false;
  });
}
function disableSliders(){
  JOINTS.forEach((_,i)=>{
    const sl=document.getElementById(`js${i}`);
    if(sl) sl.disabled = true;
  });
}

function triggerEmergency(){
  if(S.mode==='nonrtos' && S.nonrtosRunning){
    // NON-RTOS: don't stop immediately — flag it, stop after entire cycle finishes
    S.nrEmergencyPending = true;
    log('⚠ NON-RTOS Emergency PENDING — will stop after cycle completes','warn');
    toast('NON-RTOS: Emergency queued — waiting for full cycle to finish…');
    return;
  }
  // RTOS mode or idle: INSTANT stop
  S.emergency=true;
  S.emergencySource = S.mode;
  S._resetPending = false;
  S.rtosRunning = false;
  S.nonrtosRunning = false;
  enableSliders();
  _updateSafetyLockUI();
  if(ws&&ws.readyState===1&&_wsAuthed && S.mode === 'rtos') ws.send(JSON.stringify({type:'emergency'}));
  log('⚠ EMERGENCY STOP — INSTANT preemption','err');
  toast('🛑 EMERGENCY STOP ACTIVATED');
}

function setEmergencyFlag(){ S.emergency=true; log('⚠ NON-RTOS emergency — loop complete','warn'); }

// Item 6: does this emergency actually involve QNX, and therefore require
// QNX's own confirmed RESET_EMERGENCY handshake before motion is allowed
// again? MANUAL/NON-RTOS emergencies never send anything to QNX in the
// first place (see triggerEmergency() above — only mode==='rtos' does),
// so there's nothing on the QNX side to "recover" and the instant local
// clear remains correct and safe for those, exactly as before.
function _emergencyNeedsQnxReset(){
  return S.emergencySource === 'rtos' || S.emergencySource === 'rtos_qnx';
}

// Router for the dashboard's single emergency-clear button: picks the
// safe path for the current situation rather than always doing the same
// thing, per Item 6 ("do not simply clear a UI flag or bypass the
// safety mechanism").
function handleEmergencyClearClick(){
  if(_emergencyNeedsQnxReset()){
    requestEmergencyReset();
  } else {
    clearEmergency();
  }
}

// Item 6: sends the explicit recovery request to QNX and waits. Does
// NOT touch S.emergency — that only changes when the bridge relays
// QNX's own EMERGENCY_CLEARED confirmation (see connectWS()'s
// onmessage handler for 'emergency_cleared'). This is a real two-way
// handshake, not a client-side flag flip.
function requestEmergencyReset(){
  if(S._resetPending){ toast('Already waiting for QNX confirmation…'); return; }
  if(!ws || ws.readyState!==1 || !_wsAuthed){
    toast('Bridge not connected/authenticated — cannot request reset');
    return;
  }
  S._resetPending = true;
  _updateSafetyLockUI();
  ws.send(JSON.stringify({type:'reset_emergency'}));
  log('🔓 RESET EMERGENCY requested — waiting for QNX confirmation…','warn');
  toast('Reset requested — waiting for QNX to confirm safe recovery…');
}

// Reflects the current emergency/lock state into the safety-lock panel
// (now anchored directly below the main EMERGENCY STOP alert inside
// #emerg-overlay — see index.html) and its action button. Called
// whenever S.emergency actually changes (see updateUI()) and right
// after a reset request is sent. The panel's own visibility is driven
// entirely by #emerg-overlay's 'show' class (toggled in loop() from
// S.emergency), so this function only needs to keep its *contents*
// (status text + button label/disabled state) correct — no separate
// show/hide bookkeeping needed here.
function _updateSafetyLockUI(){
  const btn = document.getElementById('btn-safety-action');
  const statusEl = document.getElementById('safety-lock-status');
  if(!btn || !statusEl) return;

  if(!S.emergency){
    return;
  }

  if(_emergencyNeedsQnxReset()){
    if(S._resetPending){
      statusEl.textContent = 'Reset sent — awaiting QNX confirmation…';
      btn.textContent = '⏳ WAITING FOR QNX…';
      btn.disabled = true;
    } else {
      statusEl.textContent = 'QNX reset required';
      btn.textContent = '🔓 RESET EMERGENCY';
      btn.disabled = false;
    }
  } else {
    statusEl.textContent = 'Local simulation halted — no QNX handshake needed';
    btn.textContent = '✔ CLEAR';
    btn.disabled = false;
  }
}

function clearEmergency(){
  S.emergency=false;
  S.nrEmergencyPending=false;
  S.emergencySource=null;
  S._resetPending=false;
  S.rtosRunning=false;
  S.rtosCycling=false;
  S.rtosCycleCount=0;
  _emCached=null;
  enableSliders();
  _updateCycleUI();
  _updateSafetyLockUI();
  // Reset stop button to default state
  const btn = document.getElementById('btn-stop-cycle');
  if(btn){ btn.textContent='⏹ STOP AFTER THIS CYCLE'; btn.style.borderColor='var(--amber)'; btn.style.color='var(--amber)'; btn.onclick=stopCycle; }
  log('Emergency cleared — system re-armed','ok');
  toast('Emergency cleared — safe to operate');
}

function toggleLoad(){
  S.load=!S.load;
  log(`CPU load simulation ${S.load?'ON (jitter active in NON-RTOS)':'OFF'}`,S.load?'warn':'ok');
  toast(S.load ? '⚙ Load added — watch for jitter in NON-RTOS mode' : 'Load removed');
}

function runMode(){
  // Called by ▶ RUN button (only shown in NON-RTOS mode)
  if(S.mode!=='nonrtos'){ toast('RUN button is for NON-RTOS mode only.'); return; }
  if(S.sequence.length===0){ toast('No sequence recorded. Use 📌 RECORD first.'); return; }
  if(S.emergency){ toast('Clear emergency first!'); return; }
  S.nonrtosRunning = true;
  S.nrPoseIdx = 0;
  S.nrPoseStart = performance.now();
  S.nrEmergencyPending = false;
  S.targets = [...S.sequence[0]];
  highlightCurrentPose(0);
  log(`NON-RTOS simulation started — ${S.sequence.length} poses, ${S.nrPoseDurationMs}ms/pose, SEQUENTIAL joints`,'warn');
  toast(`NON-RTOS: Running ${S.sequence.length} poses @ ${(S.nrPoseDurationMs/1000).toFixed(1)}s each`);
}

function stopSimulation(){
  // Stop NON-RTOS simulation
  S.nonrtosRunning = false;
  S.nrEmergencyPending = false;
  highlightCurrentPose(-1);
  log('NON-RTOS simulation stopped','warn');
  toast('Simulation stopped');
}

function stopRTOSReplay(){
  // If QNX is currently cycling, send a graceful SEQ_STOP so it
  // finishes its current pass before halting — never mid-motion.
  if(S.rtosCycling){ stopCycle(); return; }
  S.rtosRunning = false;
  S.rtosCycling = false;
  enableSliders();
  highlightCurrentPose(-1);
  _updateCycleUI();
  log('RTOS replay stopped','warn');
}

function stopReplay(){
  stopSimulation();
  stopRTOSReplay();
  S.replaying=false;
  log('Replay stopped','warn');
}

function highlightCurrentPose(idx){
  document.querySelectorAll('.seq-item').forEach((el,i)=>el.classList.toggle('playing', i===idx));
}

function toggleEdit(){
  S.editMode=!S.editMode;
  const btn=document.getElementById('btn-edit-toggle');
  const strip=document.getElementById('edit-strip');
  btn.className='tb-btn'+(S.editMode?' edit-active':'');
  btn.textContent=S.editMode?'✏ EXIT EDIT':'✏ EDIT MODE';
  strip.style.display=S.editMode?'flex':'none';

  const editHidePanels = [
    'operating-mode-head','operating-mode-section',
    'teach-record-head','teach-record-section',
    'system-status-head','system-status-section',
    'telemetry-head','telemetry-section'
  ];

  document.getElementById('panel-left').classList.toggle('hidden',S.editMode);
  document.getElementById('edit-panel-left').style.display=S.editMode?'block':'none';
  document.getElementById('edit-coord-section').style.display=S.editMode?'block':'none';

  editHidePanels.forEach(id => {
    const el = document.getElementById(id);
    if(el) el.style.display = S.editMode ? 'none' : '';
  });

  if(!S.editMode){
    transform.detach();
    document.getElementById('edit-actuation-panel').style.display='none';
    document.getElementById('calib-menu').classList.remove('visible');
    document.getElementById('axis-angle-overlay').innerHTML='';
    ['btn-act-x','btn-act-horiz','btn-act-vert'].forEach(id=>{const el=document.getElementById(id);if(el)el.classList.remove('active');});
    jointControlEditActive=false;
    const jceBtn=document.getElementById('jce-btn');
    if(jceBtn){jceBtn.classList.remove('active');jceBtn.textContent='⚙ JOINT CONTROL EDIT';}
  }
  log(S.editMode?'Edit mode ON — drag parts, set axes, calibrate joints':'Edit mode OFF','warn');
}
// ── Joint Control Edit toggle ─────────────────────────────────────
function toggleJointControlEdit(){
  jointControlEditActive = !jointControlEditActive;
  const btn = document.getElementById('jce-btn');
  btn.classList.toggle('active', jointControlEditActive);
  btn.textContent = jointControlEditActive ? '⚙ JOINT CTRL EDIT: ON' : '⚙ JOINT CONTROL EDIT';
  log('Joint Control Edit: ' + (jointControlEditActive?'ON':'OFF'), 'warn');
}

// ── Calibration pose saving ───────────────────────────────────────
function setCalibPose(slot){
  if(!transform.object) { toast('Select a part first'); return; }
  const obj = transform.object;
  // Find which pivot this object belongs to
  let targetPiv = null;
  if(arm) arm.pivots.forEach(p => { if(p === obj || p.children.includes(obj) || p.parent === obj) targetPiv = p; });
  if(!targetPiv) targetPiv = obj; // fallback: treat object itself as pivot

  // ── Key by stable pivot NAME (not UUID, which regenerates every session) ──
  const pivKey = targetPiv.name || ('pivot_idx_' + (arm ? arm.pivots.indexOf(targetPiv) : 'x'));

  if(!calibrationData[pivKey]) calibrationData[pivKey] = { pivRef: targetPiv };
  calibrationData[pivKey][slot] = targetPiv.quaternion.clone();

  const slotMap = { q0:'cpb-0', q90:'cpb-90', q180:'cpb-180' };
  const classMap = { q0:'q0-set', q90:'q90-set', q180:'q180-set' };
  const el = document.getElementById(slotMap[slot]);
  if(el){ el.className='cpb '+classMap[slot]; }

  toast('Saved ' + slot + ' pose for part');
  log('Calibration ' + slot + ' saved','ok');
  autoSave();
}

// ── Test calibration slider ───────────────────────────────────────
function testCalibSlider(val){
  document.getElementById('calib-test-val').textContent = val + '°';
  if(!transform.object || !arm) return;
  const obj = transform.object;
  let targetPiv = null;
  arm.pivots.forEach((p,i) => { if(p===obj || p.children.includes(obj) || p.parent === obj) targetPiv = p; });
  if(!targetPiv) return;
  const pivKey = targetPiv.name || ('pivot_idx_' + (arm ? arm.pivots.indexOf(targetPiv) : 'x'));
  const cd = calibrationData[pivKey];
  if(!cd || !cd.q0 || !cd.q90) { toast('Set 0° and 90° poses first'); return; }
  const v = parseFloat(val);
  const q = new THREE.Quaternion();
  if(v <= 90){
    const t = v / 90;
    q.slerpQuaternions(cd.q0, cd.q90, t);
  } else {
    if(cd.q180){
      const t = (v-90)/90;
      q.slerpQuaternions(cd.q90, cd.q180, t);
    } else {
      const t = v/90;
      q.slerpQuaternions(cd.q0, cd.q90, t);
    }
  }
  targetPiv.quaternion.copy(q);
}

// ── Coord input (right panel manual transform input) ──────────────
function updateCoordInputs(){
  if(!transform.object) return;
  const obj = transform.object;
  const setV = (id, v) => { const el=document.getElementById(id); if(el && document.activeElement!==el) el.value=parseFloat(v.toFixed(3)); };
  setV('ci-px', obj.position.x); setV('ci-py', obj.position.y); setV('ci-pz', obj.position.z);
  const D = 180/Math.PI;
  setV('ci-rx', obj.rotation.x*D); setV('ci-ry', obj.rotation.y*D); setV('ci-rz', obj.rotation.z*D);
}

function applyCoordInput(){
  if(!transform.object || !S.editMode) return;
  const obj = transform.object;
  const R = Math.PI/180;
  const gv = id => { const el=document.getElementById(id); return el ? parseFloat(el.value)||0 : 0; };
  obj.position.set(gv('ci-px'), gv('ci-py'), gv('ci-pz'));
  obj.rotation.set(gv('ci-rx')*R, gv('ci-ry')*R, gv('ci-rz')*R);
  autoSave();
}

// ── Axis angle overlay rendering ──────────────────────────────────
function updateAxisAngleOverlay(){
  if(!S.editMode || !transform.object || !renderer) { return; }
  const overlay = document.getElementById('axis-angle-overlay');
  if(!overlay) return;

  const obj = transform.object;
  // Update coord inputs continuously
  updateCoordInputs();

  if(transform.mode !== 'rotate'){ overlay.innerHTML=''; return; }

  const r = obj.rotation;
  const D = 180/Math.PI;
  const canvas = renderer.domElement;
  const rect = canvas.getBoundingClientRect();
  const W = rect.width, H = rect.height;

  // Project 3 axis tip positions to screen
  const worldPos = new THREE.Vector3();
  obj.getWorldPosition(worldPos);

  const projectToScreen = (wx,wy,wz) => {
    const v = new THREE.Vector4(wx,wy,wz,1);
    v.applyMatrix4(camera.matrixWorldInverse);
    v.applyMatrix4(camera.projectionMatrix);
    if(v.w===0) return null;
    return { x: (v.x/v.w+1)/2*W, y: (-v.y/v.w+1)/2*H };
  };

  const tipLen = 0.8;
  const xTip = projectToScreen(worldPos.x+tipLen, worldPos.y, worldPos.z);
  const yTip = projectToScreen(worldPos.x, worldPos.y+tipLen, worldPos.z);
  const zTip = projectToScreen(worldPos.x, worldPos.y, worldPos.z+tipLen);

  let html = '';
  const mkLabel = (tip, cls, txt) => {
    if(!tip) return '';
    return `<div class="aal ${cls}" style="left:${tip.x}px;top:${tip.y}px">${txt}</div>`;
  };
  html += mkLabel(xTip, 'aal-x', `X: ${(r.x*D).toFixed(1)}°`);
  html += mkLabel(yTip, 'aal-y', `Y: ${(r.y*D).toFixed(1)}°`);
  html += mkLabel(zTip, 'aal-z', `Z: ${(r.z*D).toFixed(1)}°`);
  overlay.innerHTML = html;
}

function editClick(e){
  if(!S.editMode||!arm||_dragJustFinished) return;
  const rect=renderer.domElement.getBoundingClientRect();
  const mouse=new THREE.Vector2(
    ((e.clientX-rect.left)/rect.width)*2-1,
   -((e.clientY-rect.top)/rect.height)*2+1
  );
  const ray=new THREE.Raycaster();
  ray.setFromCamera(mouse,camera);
  const hits=ray.intersectObjects(arm.allMeshes,true);
  if(hits.length>0){
    let obj=hits[0].object;

    let target = obj;
    while(target.parent && target.parent !== scene && !target.userData.isOffsetGroup){
      target = target.parent;
    }
    const attachTarget = target.userData.isOffsetGroup ? target : obj;
    transform.attach(attachTarget);

    // Find partId for display (search down from the act group, which is a child of the offset group)
    let pid = null;
    let actGrp = attachTarget.children.find(c => !c.isMesh); // the act group
    if(!actGrp) actGrp = attachTarget;

    actGrp.children.forEach(c => {
      if(!pid && c.userData && c.userData.partId) pid = c.userData.partId;
    });
    if(!pid && attachTarget.userData && attachTarget.userData.partId) pid = attachTarget.userData.partId;

    log('Selected: ' + (pid || attachTarget.name || 'Unknown'), 'info');
    document.getElementById('edit-actuation-panel').style.display='block';
    document.getElementById('edit-act-name').textContent = pid || attachTarget.name || 'Unknown';

    // Reflect active axis button state
    const clearAxisBtns = () => ['btn-act-x','btn-act-horiz','btn-act-vert'].forEach(id=>{const el=document.getElementById(id);if(el)el.classList.remove('active');});
    clearAxisBtns();
    if(pid && S.actuationAxes && S.actuationAxes[pid]){
      const axisMap = { X:'btn-act-x', Y:'btn-act-horiz', Z:'btn-act-vert' };
      const ab = document.getElementById(axisMap[S.actuationAxes[pid]]);
      if(ab) ab.classList.add('active');
    }

    // Update calibration menu
    if(jointControlEditActive){
      document.getElementById('calib-menu').classList.add('visible');
      document.getElementById('calib-part-lbl').textContent = pid || attachTarget.name || 'Unknown';
      // Use stable name key, matching how setCalibPose stores it
      const pivKey = attachTarget.name || ('pivot_idx_x');
      const cd = calibrationData[pivKey] || {};
      const s0  = document.getElementById('cpb-0');
      const s90 = document.getElementById('cpb-90');
      const s180= document.getElementById('cpb-180');
      if(s0)   s0.className  = 'cpb' + (cd.q0   ? ' q0-set'  : '');
      if(s90)  s90.className = 'cpb' + (cd.q90  ? ' q90-set' : '');
      if(s180) s180.className= 'cpb' + (cd.q180 ? ' q180-set': '');
    }

    updateCoordInputs();
  } else {
    transform.detach();
    document.getElementById('edit-actuation-panel').style.display='none';
    document.getElementById('calib-menu').classList.remove('visible');
    document.getElementById('axis-angle-overlay').innerHTML='';
    ['btn-act-x','btn-act-horiz','btn-act-vert'].forEach(id=>{const el=document.getElementById(id);if(el)el.classList.remove('active');});
  }
}

function setActuationAxis(axis){
  if(!transform.object) return;
  let pid = null;
  let actGrp = transform.object.children.find(c => !c.isMesh);
  if(!actGrp) actGrp = transform.object;

  actGrp.children.forEach(c => {
    if(!pid && c.userData && c.userData.partId) pid = c.userData.partId;
  });
  if(!pid && transform.object.userData && transform.object.userData.partId) pid = transform.object.userData.partId;
  if(!pid) return;
  if(!S.actuationAxes) S.actuationAxes = {};
  S.actuationAxes[pid] = axis;
  // Highlight active axis button
  ['btn-act-x','btn-act-horiz','btn-act-vert'].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.classList.remove('active');
  });
  const map = { X:'btn-act-x', Y:'btn-act-horiz', Z:'btn-act-vert' };
  const activeBtn = document.getElementById(map[axis]);
  if(activeBtn) activeBtn.classList.add('active');
  toast(`Actuation axis set to ${axis} for ${pid}`);
  autoSave();
}


// ── Stop cycling (RTOS only) ──────────────────────────────────────
// Sends SEQ_STOP to QNX via bridge. QNX finishes its current pass
// then sends SEQ_COMPLETE — the arm never halts mid-motion.
// Guard: only callable when mode === 'rtos' AND currently cycling.
function stopCycle(){
  if(S.mode !== 'rtos'){
    toast('STOP CYCLE is only available in RTOS mode'); return;
  }
  if(!S.rtosCycling){
    toast('Arm is not currently cycling'); return;
  }
  if(!ws||ws.readyState!==1||!_wsAuthed){
    toast('Bridge not connected/authenticated'); return;
  }
  ws.send(JSON.stringify({ type: 'stop_cycle' }));
  // Mark that stop was requested — button changes to "STOPPING…"
  S.rtosCycling = false;   // prevent double-sends
  const btn = document.getElementById('btn-stop-cycle');
  if(btn){
    btn.textContent = '⏳ STOPPING AFTER THIS CYCLE…';
    btn.style.borderColor = 'var(--fg2)';
    btn.style.color = 'var(--fg2)';
    btn.onclick = null;   // disable further clicks
  }
  log('⏹ STOP CYCLE sent → QNX will halt after completing current pass','warn');
  toast('Stop requested — arm finishes current cycle then halts');
}

// ── Cycle UI helper — show/hide stop button and counter badge ────
function _updateCycleUI(){
  const cyclingActive = S.mode === 'rtos' && S.rtosRunning && S.rtosCycling;
  const stopPending   = S.mode === 'rtos' && S.rtosRunning && !S.rtosCycling;

  // STOP CYCLE button row
  const row = document.getElementById('row-stop-cycle');
  const btn = document.getElementById('btn-stop-cycle');
  if(row) row.style.display = (cyclingActive || stopPending) ? '' : 'none';
  if(btn) btn.style.display = (cyclingActive || stopPending) ? '' : 'none';

  // Topbar cycle counter badge
  const badge = document.getElementById('tb-cycle-badge');
  if(badge) badge.style.display = (cyclingActive || stopPending) ? 'flex' : 'none';

  // Update cycle number
  const numEl = document.getElementById('tb-cycle-num');
  if(numEl) numEl.textContent = S.rtosCycleCount;
}




// ═══════════════════════════════════════════════════════════════════
//  TEACH & RECORD
// ═══════════════════════════════════════════════════════════════════
function recordPose(){
  const pose=[...S.angles];
  S.sequence.push(pose);
  const n=S.sequence.length;
  const list=document.getElementById('seq-list');
  const row=document.createElement('div');
  row.className='seq-item';
  row.dataset.idx=n-1;
  row.innerHTML=`<span class="seq-num">#${String(n).padStart(2,'0')}</span>`+
    pose.map((v,i)=>i===5 ? `<span style="color:${JOINTS[i].col}">${v.toFixed(0)}%</span>` : `<span style="color:${JOINTS[i].col}">${v>=0?'+':''}${v.toFixed(0)}°</span>`).join(' ');
  row.onclick=()=>{ S.targets=[...S.sequence[+row.dataset.idx]]; };
  list.appendChild(row);
  log(`Pose #${n} recorded`,'ok');
  document.getElementById('t-seq').textContent=S.sequence.length;
  autoSave();
}

function clearSeq(){
  S.sequence=[]; S.replaying=false;
  document.getElementById('seq-list').innerHTML='';
  document.getElementById('t-seq').textContent='0';
  log('Sequence cleared','warn');
  autoSave();
}

function sendToQNX(){
  if(!ws||ws.readyState!==1||!_wsAuthed){ toast('Bridge not connected/authenticated — start bridge.py first'); return; }
  if(S.sequence.length===0){ toast('No poses recorded. Use 📌 RECORD first.'); return; }
  if(S.emergency){ toast('Clear emergency first!'); return; }

  // Send as paired multi-joint poses for simultaneous RTOS actuation
  // Each pose: array of 6 angles → QNX moves ALL joints simultaneously
  const payload = {
    type: 'rtos_sequence',
    sequence: S.sequence.map(pose => pose.map(v => parseFloat(v.toFixed(2)))),
    pose_duration_ms: S.poseDurationMs,  // user-configurable deadline per pose (Phase 2)
    total_poses: S.sequence.length
  };
  ws.send(JSON.stringify(payload));

  // Enter RTOS running + cycling state
  S.rtosRunning    = true;
  S.rtosCycling    = true;
  S.rtosCycleCount = 0;
  S.rtosPoseIdx    = 0;
  S.rtosPoseStart  = performance.now();
  S._rtosSyncPending = true;   // next real angle packet hard-snaps the view (Bug 1 fix)
  disableSliders();
  highlightCurrentPose(0);
  _updateCycleUI();    // show STOP button and cycle counter badge
  log(`⬆ Sent ${S.sequence.length} poses to QNX @ ${S.poseDurationMs}ms/pose — cycling continuously until STOP`,'ok');
  toast(`RTOS: ${S.sequence.length} poses → QNX cycling. Press ⏹ STOP to halt after current pass.`);
}


// ═══════════════════════════════════════════════════════════════════
//  WEBSOCKET  (Phase 2: secured — wss:// + shared token)
// ═══════════════════════════════════════════════════════════════════
//
// CONTROL_TOKEN
// ─────────────
// Phase 2 extends the same shared-secret model used by the Communication
// Website (comm-dashboard/app.js) to this, the actual robotic control
// channel. It is the SAME token — one shared secret identifies any
// MATRIX-trusted browser client to the gateway, per PROJECT_DESCRIPTION.md
// Section 5. As with the observability token, this is NOT strong secret
// storage (anyone reading this file can read it) — the real protections
// are TLS in transit and the gateway's constant-time hash comparison.
// Paste the token printed by `python generate_token.py` below (same
// value you already pasted into comm-dashboard/app.js).
const CONTROL_TOKEN = "WuQ8Ie9QfNGj_KCcEAtxSJTrZH32rp9evKfW0NkU6rE";

let ws=null;
let _wsRetryTimer=null;
let _wsAuthed=false;
function connectWS(){
  log('Connecting to bridge.py…','warn');
  _wsAuthed=false;
  if(ws){ try{ws.close();}catch(e){} }
  ws=new WebSocket('wss://localhost:8765');
  ws.onopen=()=>{
    // Auth must be the FIRST message — bridge.py won't process anything
    // else, including the initial state snapshot, until this succeeds.
    ws.send(JSON.stringify({type:'auth', token: CONTROL_TOKEN}));
  };
  ws.onclose=()=>{
    document.getElementById('ws-dot').className='dot warn';
    document.getElementById('ws-lbl').textContent='OFFLINE';
    S.qnxConnected=false;
    _wsAuthed=false;
    log('Bridge disconnected. Retrying in 3s…','err');
    _wsRetryTimer=setTimeout(connectWS,3000);
  };
  ws.onerror=()=>{ log('WS error — is bridge.py running, and has generate_token.py been run?','err'); };
  ws.onmessage=e=>{
    let msg;
    try{ msg=JSON.parse(e.data); } catch(err){ return; }

    // ── Auth handshake result (must arrive before anything else) ────
    if(msg.type==='auth_result'){
      if(msg.ok){
        _wsAuthed=true;
        document.getElementById('ws-dot').className='dot on';
        document.getElementById('ws-lbl').textContent='ONLINE';
        log('✔ Bridge connected & authenticated','ok');
        toast('Bridge connected — QNX layer ready');
        if(_wsRetryTimer){ clearTimeout(_wsRetryTimer); _wsRetryTimer=null; }
      } else {
        log('✗ Bridge AUTH REJECTED — check CONTROL_TOKEN in app.js matches generate_token.py output','err');
        toast('Bridge auth rejected — check CONTROL_TOKEN in app.js');
      }
      return;
    }
    if(!_wsAuthed) return;   // ignore anything else until authenticated

    // ── Angle packets from QNX (RTOS live drive) ────────────────
    if(msg.type==='angles'){
      if(!S.emergency && S.rtosRunning){
        if(S._rtosSyncPending){
          // First real telemetry since SEND→QNX: snap the visualization
          // straight to QNX's true current position — no lerp sweep.
          S.angles = [...msg.angles];
          S.targets = [...msg.angles];
          S._rtosSyncPending = false;
          log('RTOS sync: view snapped to QNX current position','info');
        } else {
          S.targets=msg.angles;
        }
        if(msg.packets!=null) S.packets=msg.packets;
        // Watchdog: if QNX sends pose_idx, update highlight
        if(msg.pose_idx!=null) highlightCurrentPose(msg.pose_idx);
      }
    }

    // ── Init packet on first connect ────────────────────────────
    if(msg.type==='init'){
      if(!S.emergency) S.targets=msg.angles;
      if(msg.packets!=null) S.packets=msg.packets;
      S.qnxConnected=msg.qnx_connected||false;
    }

    // ── Emergency from QNX (Safety Task preemption) ─────────────
    if(msg.type==='emergency'){
      S.emergency=true;
      S.emergencySource='rtos_qnx';
      S._resetPending=false;
      S.rtosRunning=false;
      S.rtosCycling=false;
      S.nonrtosRunning=false;
      S._rtosSyncPending=false;
      enableSliders();
      highlightCurrentPose(-1);
      _updateCycleUI();
      _updateSafetyLockUI();
      log('🛑 EMERGENCY from QNX — Safety Task preempted!','err');
      toast('🛑 QNX Emergency Stop — arm halted mid-motion');
    }

    // ── Item 6: QNX confirmed the operator-requested recovery ───
    // This is the ONLY place a QNX-involved emergency actually clears.
    // Requesting a reset (requestEmergencyReset()) never clears state by
    // itself — only this confirmed round-trip does.
    if(msg.type==='emergency_cleared'){
      log('✔ QNX confirmed EMERGENCY_CLEARED — motion re-armed','ok');
      toast('QNX confirmed recovery — system READY');
      clearEmergency();
    }

    // ── Reset request acknowledged (informational only) ─────────
    if(msg.type==='reset_emergency_ack'){
      log(msg.msg || 'Reset request sent to QNX','warn');
    }

    // ── QNX connection status ────────────────────────────────────
    if(msg.type==='status'){
      S.qnxConnected=msg.qnx_connected;
      log(msg.qnx_connected?`QNX connected ← ${msg.addr}`:'QNX disconnected',msg.qnx_connected?'ok':'warn');
      if(msg.qnx_connected) toast(`QNX online: ${msg.addr}`);
    }

    // ── Watchdog hit from QNX ────────────────────────────────────
    if(msg.type==='watchdog'){
      S.wdgHits++;
      log(`⏱ RTOS Watchdog: deadline missed! (${msg.missed_ms}ms over)`,'err');
    }

    // ── RTOS pose changed (QNX advanced to next pose) ────────────
    if(msg.type==='pose_advance'){
      highlightCurrentPose(msg.pose_idx);
      log(`RTOS: Pose #${msg.pose_idx+1} executing (QNX)`,'ok');
    }

    // ── RTOS sequence complete (cycling stopped) ──────────────────
    if(msg.type==='seq_complete'){
      S.rtosRunning    = false;
      S.rtosCycling    = false;
      enableSliders();
      highlightCurrentPose(-1);
      _updateCycleUI();   // hide stop button and badge
      // Reset stop button appearance for next run
      const btn = document.getElementById('btn-stop-cycle');
      if(btn){ btn.textContent='⏹ STOP AFTER THIS CYCLE'; btn.style.borderColor='var(--amber)'; btn.style.color='var(--amber)'; btn.onclick=stopCycle; }
      log(`✔ RTOS cycling complete — ${S.rtosCycleCount} cycle${S.rtosCycleCount===1?'':'s'} executed`,'ok');
      toast(`RTOS stopped — ${S.rtosCycleCount} cycle${S.rtosCycleCount===1?'':'s'} completed`);
    }

    // ── Cycle completed (one full pass through all poses) ────────
    if(msg.type==='cycle_done'){
      S.rtosCycleCount = msg.cycle_num;
      const numEl = document.getElementById('tb-cycle-num');
      if(numEl) numEl.textContent = S.rtosCycleCount;
      highlightCurrentPose(0);   // reset highlight for next pass
      log(`🔁 Cycle #${msg.cycle_num} complete — looping`,'info');
    }

    // ── Stop cycle acknowledged ───────────────────────────────────
    if(msg.type==='stop_cycle_ack'){
      log(msg.msg,'warn');
    }

    // ── Sequence ack ─────────────────────────────────────────────
    if(msg.type==='seq_ack'){ log(msg.msg, msg.ok===false?'err':'ok'); toast(msg.msg); }
  };
}


// ═══════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════
function log(msg,type=''){
  const box=document.getElementById('log-box');
  if(!box) return;
  const d=document.createElement('div');
  const ts=new Date().toLocaleTimeString('en-GB',{hour12:false});
  d.className=`log-${type}`;
  d.textContent=`[${ts}] ${msg}`;
  box.appendChild(d);
  box.scrollTop=box.scrollHeight;
  while(box.children.length>50) box.removeChild(box.firstChild);
}

let _toastTimer=null;
function toast(msg){
  const el=document.getElementById('toast');
  el.textContent=msg; el.classList.add('show');
  if(_toastTimer) clearTimeout(_toastTimer);
  _toastTimer=setTimeout(()=>el.classList.remove('show'),3200);
}

// ═══════════════════════════════════════════════════════════════════
//  PROJECT PERSISTENCE — IndexedDB
// ═══════════════════════════════════════════════════════════════════
let currentProjectId = null;

const ProjectDB = {
  DB_NAME:'MATRIX_DB', DB_VER:3, db:null,

  async init(){
    return new Promise((res,rej)=>{
      const req=indexedDB.open(this.DB_NAME,this.DB_VER);
      req.onupgradeneeded=e=>{
        const db=e.target.result;
        if(!db.objectStoreNames.contains('projects')) db.createObjectStore('projects',{keyPath:'id'});
        if(!db.objectStoreNames.contains('files'))    db.createObjectStore('files',{keyPath:'key'});
      };
      req.onsuccess=e=>{this.db=e.target.result;res()};
      req.onerror=e=>rej(e.target.error);
    });
  },

  _tx(store,mode,fn){
    return new Promise((res,rej)=>{
      const tx=this.db.transaction(store,mode);
      const st=tx.objectStore(store);
      const req=fn(st);
      if(req){req.onsuccess=()=>res(req.result);req.onerror=()=>rej(req.error);}
      else{tx.oncomplete=()=>res();tx.onerror=()=>rej(tx.error);}
    });
  },

  loadAll(){ return this._tx('projects','readonly',s=>s.getAll()); },
  loadProject(id){ return this._tx('projects','readonly',s=>s.get(id)); },
  saveProject(data){ return this._tx('projects','readwrite',s=>s.put(data)); },

  async deleteProject(id){
    await this._tx('projects','readwrite',s=>s.delete(id));
    const all=await new Promise((res,rej)=>{
      const tx=this.db.transaction('files','readwrite');
      const req=tx.objectStore('files').getAll();
      req.onsuccess=()=>res(req.result); req.onerror=()=>rej(req.error);
    });
    for(const f of all.filter(f=>f.key.startsWith(id+'::'))){
      await this._tx('files','readwrite',s=>s.delete(f.key));
    }
  },

  async saveFilesForProject(id,filesObj,quantitiesObj){
    for(const [name,file] of Object.entries(filesObj)){
      const buf=await file.arrayBuffer();
      await this._tx('files','readwrite',s=>s.put({key:id+'::'+name,name,type:file.type||'',qty:quantitiesObj[name]||1,buf}));
    }
    // Update fileCount on project
    const proj=await this.loadProject(id)||{id};
    proj.fileCount=Object.keys(filesObj).length;
    await this.saveProject(proj);
  },

  async loadFilesForProject(id){
    const all=await new Promise((res,rej)=>{
      const tx=this.db.transaction('files','readonly');
      const req=tx.objectStore('files').getAll();
      req.onsuccess=()=>res(req.result); req.onerror=()=>rej(req.error);
    });
    return all.filter(f=>f.key.startsWith(id+'::'));
  }
};

// ═══════════════════════════════════════════════════════════════════
//  PROJECT ISOLATION — full runtime-state reset between projects
// ═══════════════════════════════════════════════════════════════════
// ROOT CAUSE of the previously reported cross-project leakage:
//
//   uploadedFiles / quantities / S.axisOffsets / S.actuationAxes /
//   S.savedTransforms / calibrationData are module-level (global) JS
//   objects. They were only ever ADDED to or CONDITIONALLY overwritten
//   when a project was opened (e.g. `if(proj.axisOffsets) S.axisOffsets
//   = proj.axisOffsets;`), never unconditionally cleared. Because part
//   and pivot names (Base.obj, J0_Base, J1_Shoulder, ...) are identical
//   across every project by construction, two projects that happen to
//   use the same uploaded filenames read and write the EXACT SAME keys
//   in these shared objects. So Project B silently inherited whatever
//   Project A (or any previously-opened project) had left behind —
//   this was never "stale state" in a vague sense, it was un-cleared
//   shared mutable state with colliding keys.
//
// Fix: every project switch (new project OR opening an existing one)
// now runs through this single reset function BEFORE any of that
// project's own saved data is applied, guaranteeing each project starts
// from a truly clean slate and can never observe leftovers from
// whatever was open before it. The IndexedDB schema itself was already
// correctly project-scoped (files keyed by `${projectId}::${filename}`,
// each project a separate record) — that architecture is untouched.
function resetProjectRuntimeState(){
  Object.keys(uploadedFiles).forEach(k => delete uploadedFiles[k]);
  Object.keys(quantities).forEach(k => delete quantities[k]);
  Object.keys(calibrationData).forEach(k => delete calibrationData[k]);

  S.axisOffsets      = {};
  S.actuationAxes     = {};
  S.savedTransforms   = null;
  S.sequence          = [];
  S.angles            = [90,90,90,90,90,0];
  S.targets           = [90,90,90,90,90,0];
  S.mode              = 'manual';
  S.poseDurationMs    = 1000;
  S.nrPoseDurationMs  = 1300;
  S.rtosRunning = S.rtosCycling = S.nonrtosRunning = false;
  S.rtosCycleCount    = 0;
  S.emergency = false; S.emergencySource = null; S._resetPending = false;
  S.wdgHits = 0; S.packets = 0;

  editState.history = [];
  editState.redo = [];

  axisClicks = [];
  axisCurrentFile = null;
  if(axisMesh && axisScene){ try{ axisScene.remove(axisMesh); }catch(e){} axisMesh = null; }
  if(axisHelper) axisHelper.visible = false;

  const seqList = document.getElementById('seq-list');
  if(seqList) seqList.innerHTML = '';
  const tSeq = document.getElementById('t-seq');
  if(tSeq) tSeq.textContent = '0';

  // Cleanly exit edit mode (if the previously-open project left it on)
  // so no stale selection/transform-gizmo carries over visually.
  if(S.editMode && typeof transform !== 'undefined' && transform){
    try{ toggleEdit(); }catch(e){}
  }
}

async function autoSave(){
  if(!currentProjectId) return;
  clearTimeout(_saveTimer); // Just in case any are pending
  const transforms=[];
  const seen = new Set();
  if(arm){
    scene.traverse(obj => {
      // Capture Offset Groups explicitly
      if(obj.name && obj.name.endsWith('_Offset')){
        transforms.push({
          name: obj.name,
          pos: [obj.position.x, obj.position.y, obj.position.z],
          rot: [obj.rotation.x, obj.rotation.y, obj.rotation.z]
        });
      }
      // Capture individual meshes with partId
      else if(obj.userData && obj.userData.partId && !seen.has(obj.userData.partId)){
        seen.add(obj.userData.partId);
        transforms.push({
          partId: obj.userData.partId,
          pos: [obj.position.x, obj.position.y, obj.position.z],
          rot: [obj.rotation.x, obj.rotation.y, obj.rotation.z]
        });
      }
    });
  }
  const camData=camera?{pos:[camera.position.x,camera.position.y,camera.position.z],
    target:[orbit.target.x,orbit.target.y,orbit.target.z]}:null;
  const existing=await ProjectDB.loadProject(currentProjectId)||{};

  const calibSerial = {};
  for(const [uuid, cd] of Object.entries(calibrationData)){
    calibSerial[uuid] = {};
    ['q0','q90','q180'].forEach(slot => {
      if(cd[slot]) calibSerial[uuid][slot] = [cd[slot].x, cd[slot].y, cd[slot].z, cd[slot].w];
    });
  }

  await ProjectDB.saveProject({...existing,id:currentProjectId,lastSaved:new Date().toISOString(),
    transforms,jointAngles:[...S.angles],jointTargets:[...S.targets],poseDurationMs:S.poseDurationMs,nrPoseDurationMs:S.nrPoseDurationMs,
    sequences:S.sequence.map(p=>[...p]),mode:S.mode,camera:camData, axisOffsets:S.axisOffsets, actuationAxes:S.actuationAxes, calibrationData:calibSerial});
  flashSaveIndicator();
}

let _siTimer=null;
function flashSaveIndicator(){
  const el=document.getElementById('save-indicator');
  el.classList.add('show'); clearTimeout(_siTimer);
  _siTimer=setTimeout(()=>el.classList.remove('show'),2200);
}

// ─── Restore state after arm is built ──────────────────────────
async function restoreProjectState(){
  if(!currentProjectId) return;
  const proj=await ProjectDB.loadProject(currentProjectId);
  if(!proj) return;
  if(proj.jointAngles){ S.angles=[...proj.jointAngles]; S.targets=[...(proj.jointTargets||proj.jointAngles)]; }
  if(proj.poseDurationMs) S.poseDurationMs = proj.poseDurationMs;
  if(proj.nrPoseDurationMs) S.nrPoseDurationMs = proj.nrPoseDurationMs;
  _syncPoseDurationDisplay();
  if(proj.mode) S.mode=proj.mode;
  // Unconditional replace (not merge) — S.axisOffsets/S.actuationAxes were
  // already reset to {} by resetProjectRuntimeState() before this project's
  // files were even loaded, so these are safe either way, but kept
  // unconditional here too so this function is correct even if ever called
  // in isolation in the future.
  S.axisOffsets = proj.axisOffsets || {};
  S.actuationAxes = proj.actuationAxes || {};

  // Restore calibration data (quaternion arrays → THREE.Quaternion).
  // calibrationData was already fully cleared by resetProjectRuntimeState()
  // before this project loaded, so this only ever contains THIS project's
  // saved calibration — no leftover pivot keys from a previous project.
  // Keys in storage are pivot names (e.g. "J0_Base"), which are stable across sessions.
  if(proj.calibrationData && arm){
    for(const [pivKey, cd] of Object.entries(proj.calibrationData)){
      calibrationData[pivKey] = {};
      ['q0','q90','q180'].forEach(slot => {
        if(cd[slot]) {
          const [x,y,z,w] = cd[slot];
          calibrationData[pivKey][slot] = new THREE.Quaternion(x,y,z,w);
          // Re-link pivRef by matching pivot name
          arm.pivots.forEach(p => { if(p.name === pivKey) calibrationData[pivKey].pivRef = p; });
        }
      });
    }
  }
  S.targets.forEach((v,i)=>{ const sl=document.getElementById(`js${i}`); if(sl) sl.value=v; });

  if(proj.transforms){
    S.savedTransforms = proj.transforms;
    if(arm && scene) {
      scene.traverse(obj => {
        if(obj.name && obj.name.endsWith('_Offset')){
          const t = S.savedTransforms.find(x => x.name === obj.name);
          if(t){ obj.position.set(...t.pos); obj.rotation.set(...t.rot); }
        }
        else if(obj.userData && obj.userData.partId){
          const t = S.savedTransforms.find(x => x.partId === obj.userData.partId);
          if(t){ obj.position.set(...t.pos); obj.rotation.set(...t.rot); }
        }
      });
    }
  } else {
    S.savedTransforms = null;
  }
  // Restore camera — must call orbit.update() or the new position is ignored
  if(proj.camera&&camera){
    camera.position.set(...proj.camera.pos);
    if(orbit){ orbit.target.set(...proj.camera.target); orbit.update(); }
  }
  if(proj.sequences&&proj.sequences.length>0){
    S.sequence=proj.sequences.map(p=>[...p]);
    const list=document.getElementById('seq-list'); list.innerHTML='';
    S.sequence.forEach((pose,n)=>{
      const row=document.createElement('div'); row.className='seq-item'; row.dataset.idx=n;
      row.innerHTML=`<span class="seq-num">#${String(n+1).padStart(2,'0')}</span>`+
        pose.map((v,i)=>i===5?`<span style="color:${JOINTS[i].col}">${v.toFixed(0)}%</span>`
          :`<span style="color:${JOINTS[i].col}">${v>=0?'+':''}${v.toFixed(0)}°</span>`).join(' ');
      row.onclick=()=>{S.targets=[...S.sequence[+row.dataset.idx]];};
      list.appendChild(row);
    });
    document.getElementById('t-seq').textContent=S.sequence.length;
  }
  log(`✔ Project "${proj.name}" fully restored`,'ok');
  toast(`Restored: ${proj.name}`);
}

// ─── Project Hub UI ────────────────────────────────────────────
async function showProjectHub(){
  autoSave(); // Force save before leaving!
  await ProjectDB.init();
  document.getElementById('loading').style.opacity='0';
  document.getElementById('loading').style.transition='opacity .4s';
  setTimeout(()=>{ document.getElementById('loading').style.display='none'; document.getElementById('project-hub').style.display='flex'; },400);
  await renderProjectCards();
  // Belt-and-suspenders isolation guard: once we're back at the hub, no
  // project is "open" anymore, so nothing should be able to autoSave()
  // against a stale id if some lingering timer/callback fires late.
  currentProjectId = null;
}

async function renderProjectCards(){
  const projects=await ProjectDB.loadAll();
  const grid=document.getElementById('proj-grid');
  if(!projects||projects.length===0){
    grid.innerHTML='<div class="hub-empty"><span>🤖</span>No projects yet.<br>Click \"+ New Project\" to begin.</div>'; return;
  }
  projects.sort((a,b)=>new Date(b.lastSaved||b.createdAt)-new Date(a.lastSaved||a.createdAt));
  grid.innerHTML='';
  projects.forEach(p=>{
    const d=new Date(p.lastSaved||p.createdAt);
    const dateStr=d.toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})+' '+d.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
    const card=document.createElement('div'); card.className='proj-card';
    card.innerHTML=`
      <div class="proj-card-name-wrap">
        <div class="proj-card-name" style="flex:1">${p.name||'Unnamed'}</div>
        <button class="proj-rename-btn" onclick="openRenameDialog('${p.id}','${(p.name||'').replace(/'/g,"\\'")}',event)">✏ RENAME</button>
      </div>
      <div class="proj-card-meta"><span>${dateStr}</span>
        ${p.fileCount?`<span class="proj-card-badge">${p.fileCount} FILES</span>`:''}
        ${(p.sequences||[]).length?`<span class="proj-card-badge">${p.sequences.length} POSES</span>`:''}
      </div>
      <div class="proj-card-actions">
        <button class="btn primary" style="flex:1;font-size:10px" onclick="openProject('${p.id}')">▶ OPEN</button>
        <button class="btn danger" style="flex:none;padding:7px 10px" onclick="deleteProjectConfirm('${p.id}',event)">🗑</button>
      </div>`;
    grid.appendChild(card);
  });
}

function openNewProjectDialog(){
  document.getElementById('proj-dialog').style.display='flex';
  setTimeout(()=>document.getElementById('proj-name-input').focus(),80);
}
function closeDialog(){
  document.getElementById('proj-dialog').style.display='none';
  document.getElementById('proj-name-input').value='';
}

// ── Rename project ─────────────────────────────────────────────
function openRenameDialog(id, currentName, e){
  e.stopPropagation();
  _renameTargetId = id;
  const inp = document.getElementById('rename-input');
  inp.value = currentName || '';
  document.getElementById('rename-dialog').style.display='flex';
  setTimeout(()=>inp.focus(), 80);
}
function closeRenameDialog(){
  document.getElementById('rename-dialog').style.display='none';
  _renameTargetId = null;
}
async function confirmRename(){
  const name = document.getElementById('rename-input').value.trim();
  if(!name || !_renameTargetId){ document.getElementById('rename-input').style.borderColor='var(--red)'; return; }
  const proj = await ProjectDB.loadProject(_renameTargetId) || { id: _renameTargetId };
  proj.name = name;
  await ProjectDB.saveProject(proj);
  closeRenameDialog();
  await renderProjectCards();
  // Update topbar if this is open project
  if(currentProjectId === _renameTargetId){
    const tbName = document.getElementById('tb-proj-name');
    if(tbName) tbName.textContent = name.toUpperCase();
  }
  toast(`Renamed to: ${name}`);
}
async function createProject(){
  const name=document.getElementById('proj-name-input').value.trim();
  if(!name){ document.getElementById('proj-name-input').style.borderColor='var(--red)'; return; }
  // Isolation fix: a brand-new project must never inherit whatever was
  // left in memory by a previously-opened project (models, calibration,
  // transforms, sequences, etc.) — see resetProjectRuntimeState().
  resetProjectRuntimeState();
  const id='p'+Date.now()+'_'+Math.random().toString(36).slice(2,6);
  await ProjectDB.saveProject({id,name,createdAt:new Date().toISOString(),lastSaved:new Date().toISOString(),
    fileCount:0,transforms:[],jointAngles:[90,90,90,90,90,0],jointTargets:[90,90,90,90,90,0],sequences:[],mode:'manual',camera:null,axisOffsets:{},actuationAxes:{},calibrationData:{}});
  currentProjectId=id;
  closeDialog();
  document.getElementById('project-hub').style.display='none';
  document.querySelector('.upload-header .logo span') && (document.querySelector('.upload-header .logo span').textContent=name.toUpperCase()+' — LOAD 3D MODELS');
  showUpload();
}
async function openProject(id){
  // Isolation fix: clear all in-memory project-specific state BEFORE
  // loading anything for this project, so identical filenames/pivot
  // names between projects can never carry over leftover configuration
  // from whichever project was open before this one.
  resetProjectRuntimeState();
  currentProjectId=id;
  const proj=await ProjectDB.loadProject(id);
  if(proj && proj.name) {
     const tbName = document.getElementById('tb-proj-name');
     if(tbName) tbName.textContent = proj.name.toUpperCase();
     document.querySelector('.upload-header .logo span') && (document.querySelector('.upload-header .logo span').textContent=proj.name.toUpperCase()+' — LOAD 3D MODELS');
  }
  const storedFiles=await ProjectDB.loadFilesForProject(id);
  if(storedFiles&&storedFiles.length>0){
    for(const sf of storedFiles){
      const blob=new Blob([sf.buf],{type:sf.type||'application/octet-stream'});
      uploadedFiles[sf.name]=new File([blob],sf.name,{type:sf.type||''});
      quantities[sf.name]=sf.qty||1;
    }
    // Unconditional (not merge/conditional) assignment — this project's
    // own saved values, or a clean empty object if it has none. This was
    // the exact bug: `if(proj.axisOffsets) S.axisOffsets = ...` left the
    // PREVIOUS project's S.axisOffsets in place whenever the new project
    // didn't have its own (or even when it did, before this fix a stray
    // reference could still alias data — always assigning fresh removes
    // any ambiguity).
    S.axisOffsets = proj.axisOffsets || {};
    S.actuationAxes = proj.actuationAxes || {};
    S.savedTransforms = proj.transforms || null;

    document.getElementById('project-hub').style.display='none';
    document.getElementById('main').style.display='flex';
    initDashboard();
    // Wait for ALL async model loads to finish before restoring transforms/camera.
    // This replaces the old fragile setTimeout(1400ms) which would race against
    // slow OBJ/STL XHR loads and restore into an empty scene.
    if(_pendingModelLoads > 0){
      _onAllModelsLoaded = restoreProjectState;
    } else {
      // All models were primitives (no files) — restore immediately
      requestAnimationFrame(restoreProjectState);
    }
  } else {
    document.getElementById('project-hub').style.display='none';
    showUpload();
    toast(`"${proj&&proj.name}" — upload models to continue`);
  }
}
function returnToAxisCalib(){
  showAxisCalibration();

  const backBtn = document.getElementById('btn-axis-back');
  if(backBtn) {
     backBtn.innerHTML = '◀ BACK TO DASHBOARD';
     backBtn.onclick = () => {
         document.getElementById('axis-screen').style.display='none';
         document.getElementById('main').style.display='flex';
         window.dispatchEvent(new Event('resize'));
     };
  }
  const launchBtn = document.getElementById('btn-finish-axis');
  if(launchBtn) {
     launchBtn.innerHTML = 'SAVE CALIBRATION & RETURN →';
  }
}
async function deleteProjectConfirm(id,e){
  e.stopPropagation();
  if(!confirm('Delete this project? This cannot be undone.')) return;
  await ProjectDB.deleteProject(id);
  await renderProjectCards();
}
function showUpload(){
  document.getElementById('loading').style.display='none';
  document.getElementById('upload-screen').style.display='flex';
  initPreviewRenderer();
}

// ═══════════════════════════════════════════════════════════════════
//  INACTIVITY-BASED AUTO-RETURN TO PROJECT HUB
//  + ACTIVE-SIMULATION GUARD
// ═══════════════════════════════════════════════════════════════════
// The render loop (loop()) already runs unconditionally via
// requestAnimationFrame regardless of tab visibility, so RTOS/NON-RTOS
// timing (WebSocket-driven RTOS angles, the local NON-RTOS pose ticker)
// is unaffected by tab switches — background-tab rAF throttling only
// slows down VISUAL repaint, never the underlying S.rtosRunning /
// S.rtosCycling / S.nonrtosRunning state machine, which is exactly what
// "the simulation may continue running" relies on.
//
// This section adds the "after prolonged inactivity, return to the
// Project Hub" behavior, and makes it explicitly skip that return while
// a simulation is actively running — re-checking periodically so that
// once the simulation stops, normal inactivity handling resumes on its
// own without any extra user action.
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes hidden/inactive
let _inactivityTimer = null;

function _simulationActive(){
  return !!(S.rtosRunning || S.rtosCycling || S.nonrtosRunning);
}

function _isDashboardOpen(){
  const el = document.getElementById('main');
  return !!el && el.style.display === 'flex';
}

function _armInactivityTimer(){
  clearTimeout(_inactivityTimer);
  _inactivityTimer = setTimeout(_checkInactivityTimeout, INACTIVITY_TIMEOUT_MS);
}

function _checkInactivityTimeout(){
  if(!_isDashboardOpen()) return;       // already left the dashboard — nothing to do
  if(document.hidden !== true) return;  // tab is visible again — no timeout
  if(_simulationActive()){
    // A simulation is actively running — do NOT return to the hub.
    // Re-check again after the same interval so that once the
    // simulation stops, the normal inactivity → hub behavior resumes
    // automatically on its own, with no extra action from the user.
    log('Inactivity timeout reached, but a simulation is active — staying on dashboard.','warn');
    _armInactivityTimer();
    return;
  }
  log('Inactivity timeout — auto-saving and returning to Project Hub.','warn');
  autoSave();
  showProjectHub();
}

document.addEventListener('visibilitychange', ()=>{
  if(document.hidden){
    if(_isDashboardOpen()) _armInactivityTimer();
  } else {
    clearTimeout(_inactivityTimer);
    _inactivityTimer = null;
  }
});

// Manual navigation guard: leaving to the Hub while a simulation is
// actively running would otherwise orphan it visually (the 3D scene and
// its telemetry listeners get torn down from the user's view, but QNX/
// the bridge would keep cycling or the local NON-RTOS loop would keep
// ticking with no one watching). Route the topbar "◀ HUB" button through
// this so an active simulation is always stopped cleanly first — reusing
// the SAME stop functions already used elsewhere (stopRTOSReplay /
// stopSimulation), not a parallel stop mechanism.
function goToHubFromDashboard(){
  if(_simulationActive()){
    const ok = confirm('A simulation is currently running. Stop it and return to the Project Hub?');
    if(!ok) return;
    if(S.rtosRunning) stopRTOSReplay();       // graceful SEQ_STOP if cycling
    if(S.nonrtosRunning) stopSimulation();
  }
  document.getElementById('main').style.display='none';
  showProjectHub();
}