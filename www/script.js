/* =========================================================
   WAVELENGTH — personal music player
   Vanilla JS + Supabase (cloud-synced library, favorites,
   recently played, and auth). YouTube IFrame Player API
   handles playback only — no backend server of our own.
   ========================================================= */

/* ---------------------------------------------------------
   0. SUPABASE CONFIGURATION
   ---------------------------------------------------------
   Get these two values from your Supabase project:
   Project Settings → API → "Project URL" and
   "Project API keys → anon / public".

   NEVER put your service_role / secret key here — only the
   public anon key, which is safe to ship in frontend code
   because Row Level Security restricts what it can do.
   --------------------------------------------------------- */
const SUPABASE_URL = "https://fjajgszcveobbuppwnxx.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_JsOrVimd6sAjLWfgSVgQJw_w4b_1nSs";

const sb = (typeof supabase !== 'undefined' && SUPABASE_URL.startsWith('http'))
  ? supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true },
    })
  : null;

/* ---------------------------------------------------------
   0b. LOCAL STORAGE KEYS (settings only — everything else
   that needs to sync across devices lives in Supabase)
   --------------------------------------------------------- */
const LS_KEYS = {
  settings: 'wl_settings',
  localFavorites: 'wl_local_favorites',
  localRecent: 'wl_local_recent',
};

const LOCAL_DB_NAME = 'WavelengthLocalMusic';
const LOCAL_DB_VERSION = 1;
const LOCAL_STORE = 'audioFiles';
let localDBPromise = null;
let localAudio = null;
let mediaSessionBound = false;

const state = {
  user: null,             // Supabase auth user, or null
  library: [],             // cloud YouTube songs
  localLibrary: [],        // IndexedDB-backed local audio songs
  localFavorites: [],
  localRecent: [],
  playbackSource: null,    // 'youtube' | 'local'
  favorites: [],           // [songId] (song.id = songs.id in Supabase)
  recent: [],              // [songId] most recent first
  queue: [],                // [songId] active playback context (kept in memory only)
  queuePos: -1,             // index into queue currently loaded
  shuffle: false,
  shuffleOrder: [],         // array of positions into `queue`
  shufflePos: -1,
  repeat: 'off',            // off | all | one
  sort: { youtube: 'added-desc', local: 'added-desc' },
  volume: 70,
  muted: false,
  isPlaying: false,
  playerReady: false,
  pendingAutoplay: false,
  currentTime: 0,
  currentDuration: 0,
};

let player = null;
let progressTimer = null;
let confirmCallback = null;
let realtimeChannel = null;

// ===============================
// DEMO SONGS (suggestions only)
// These are NOT part of your cloud library until you
// explicitly add one — clicking a suggestion adds it to
// Supabase like any other song.
// ===============================
const DEMO_SUGGESTIONS = [
  'https://www.youtube.com/watch?v=jfKfPfyJRdk',
  'https://www.youtube.com/watch?v=5qap5aO4i9A',
  'https://www.youtube.com/watch?v=2Vv-BfVoq4g',
];

/* ---------------------------------------------------------
   1. UTILITIES
   --------------------------------------------------------- */
function uid(){ return 'song_' + Date.now().toString(36) + Math.random().toString(36).slice(2,8); }

function escapeHtml(str){
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[c]));
}

function formatTime(sec){
  if(!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2,'0')}`;
}

function saveLS(key, val){
  try{ localStorage.setItem(key, JSON.stringify(val)); }catch(e){ console.warn('LocalStorage save failed', e); }
}
function loadLS(key, fallback){
  try{
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  }catch(e){ return fallback; }
}

function toast(msg){
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2600);
}

function findSong(id){ return state.library.find(s => s.id === id) || state.localLibrary.find(s => s.id === id); }
function getAllSongs(){ return [...state.library, ...state.localLibrary]; }
function isLocalSong(song){ return !!song && song.source === 'local'; }

/* ---------------------------------------------------------
   2. YOUTUBE URL PARSING + METADATA
   --------------------------------------------------------- */
function extractYouTubeId(url){
  if(!url) return null;
  url = url.trim();
  const patterns = [
    /youtube\.com\/watch\?(?:.*&)?v=([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /music\.youtube\.com\/watch\?(?:.*&)?v=([a-zA-Z0-9_-]{11})/,
  ];
  for(const p of patterns){
    const m = url.match(p);
    if(m) return m[1];
  }
  try{
    const u = new URL(url);
    const v = u.searchParams.get('v');
    if(v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
  }catch(e){ /* not a valid absolute URL */ }
  return null;
}

// Resolves the best available thumbnail, falling back gracefully.
function resolveThumbnail(videoId){
  return new Promise((resolve) => {
    const maxres = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
    const hq = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    const img = new Image();
    img.onload = () => {
      // YouTube serves a 120x90 grey placeholder when maxres doesn't exist.
      if(img.naturalWidth > 120) resolve(maxres);
      else resolve(hq);
    };
    img.onerror = () => resolve(hq);
    img.src = maxres;
  });
}

// Uses YouTube's official oEmbed endpoint (no API key required) to get
// the video title and channel/author name. Falls back gracefully if
// the request fails (e.g. offline, opened from file://, video removed).
async function resolveMetadata(videoId, originalUrl){
  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent('https://www.youtube.com/watch?v=' + videoId)}&format=json`;
  try{
    const res = await fetch(oembedUrl);
    if(!res.ok) throw new Error('oEmbed request failed');
    const data = await res.json();
    return {
      title: data.title || 'Untitled Track',
      artist: data.author_name || 'Unknown Artist',
    };
  }catch(e){
    return { title: 'Untitled Track', artist: 'Unknown Artist' };
  }
}

/* ---------------------------------------------------------
   3. PERSISTENCE — settings stay local; everything else
   (library, favorites, recently played) lives in Supabase
   so it follows the account across devices.
   --------------------------------------------------------- */
function loadSettings(){
  const s = loadLS(LS_KEYS.settings, {});
  state.volume = typeof s.volume === 'number' ? s.volume : 70;
  state.muted = !!s.muted;
  state.shuffle = !!s.shuffle;
  state.repeat = s.repeat || 'off';
  state.sort = { youtube: s.sort?.youtube || 'added-desc', local: s.sort?.local || 'added-desc' };
  state.localFavorites = loadLS(LS_KEYS.localFavorites, []);
  state.localRecent = loadLS(LS_KEYS.localRecent, []);
}
function persistSettings(){
  saveLS(LS_KEYS.settings, {
    volume: state.volume, muted: state.muted, shuffle: state.shuffle, repeat: state.repeat, sort: state.sort
  });
}

function mapSongRow(row){
  return {
    id: row.id,
    ytid: row.youtube_id,
    youtube_url: row.youtube_url,
    title: row.title,
    artist: row.artist,
    thumb: row.thumbnail,
    addedAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
  };
}

/* ---------------------------------------------------------
   LOCAL MUSIC — IndexedDB, never uploaded
   --------------------------------------------------------- */
function getNativeMediaSession(){
  try{
    return window.Capacitor?.Plugins?.MediaSession || window.Capacitor?.Plugins?.['MediaSession'] || null;
  }catch(e){ return null; }
}
let nativeMediaSessionBound=false;
let lastNativePositionPush=0;

async function updateNativeMediaSession(){
  const ms=getNativeMediaSession();
  if(!ms) return false;
  const song=getCurrentSong();
  try{
    if(!song){
      await ms.setPlaybackState({playbackState:'none'});
      return true;
    }
    await ms.setMetadata({
      title:song.title || 'Unknown title',
      artist:song.artist || '',
      album:isLocalSong(song) ? 'Wavelength · Local Music' : 'Wavelength · YouTube Music'
    });
    await ms.setPlaybackState({playbackState:state.isPlaying?'playing':'paused'});
    if(!nativeMediaSessionBound){
      const bind=(action,fn)=>ms.setActionHandler({action},fn).catch(()=>{});
      bind('play',()=>{ if(!state.isPlaying) togglePlayPause(); });
      bind('pause',()=>{ if(state.isPlaying) togglePlayPause(); });
      bind('previoustrack',()=>prev());
      bind('nexttrack',()=>next(false));
      bind('seekbackward',(d)=>seekBy(-(d?.seekTime || 10)));
      bind('seekforward',(d)=>seekBy(d?.seekTime || 10));
      bind('seekto',(d)=>{ if(typeof d?.seekTime==='number') seekToSeconds(d.seekTime); });
      bind('stop',()=>{ if(state.isPlaying) togglePlayPause(); });
      nativeMediaSessionBound=true;
    }
    return true;
  }catch(e){ console.warn('Native Media Session update failed',e); return false; }
}

async function setNativeMediaPosition(force=false){
  const ms=getNativeMediaSession();
  if(!ms) return;
  const now=Date.now();
  if(!force && now-lastNativePositionPush<900) return;
  const dur=Number(state.currentDuration)||0, pos=Number(state.currentTime)||0;
  if(dur>0 && Number.isFinite(dur)){
    lastNativePositionPush=now;
    try{ await ms.setPositionState({duration:Math.max(dur,0.001),position:Math.min(Math.max(pos,0),Math.max(dur,0.001)),playbackRate:1}); }catch(e){}
  }
}

function updateMediaSession(){
  // Native Android MediaSession is used inside the Capacitor app.
  void updateNativeMediaSession();
  if(!('mediaSession' in navigator)) return;
  const song=getCurrentSong();
  try{
    if(!song){
      navigator.mediaSession.metadata=null;
      navigator.mediaSession.playbackState='none';
      return;
    }
    navigator.mediaSession.metadata=new MediaMetadata({
      title: song.title || 'Unknown title',
      artist: song.artist || '',
      album: isLocalSong(song) ? 'Wavelength · Local Music' : 'Wavelength · YouTube Music'
    });
    navigator.mediaSession.playbackState=state.isPlaying ? 'playing' : 'paused';
    if(!mediaSessionBound){
      const safe=(name,fn)=>{ try{ navigator.mediaSession.setActionHandler(name,fn); }catch(e){ /* unsupported action in this browser */ } };
      safe('play',()=>{ if(!state.isPlaying) togglePlayPause(); });
      safe('pause',()=>{ if(state.isPlaying) togglePlayPause(); });
      safe('previoustrack',()=>prev());
      safe('nexttrack',()=>next(false));
      safe('seekbackward',(d)=>seekBy(-(d.seekOffset||10)));
      safe('seekforward',(d)=>seekBy(d.seekOffset||10));
      safe('seekto',(d)=>{ if(typeof d.seekTime==='number') seekToSeconds(d.seekTime); });
      mediaSessionBound=true;
    }
  }catch(e){ console.warn('Media Session update failed',e); }
}
function setMediaPosition(){
  void setNativeMediaPosition();
  if(!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  const dur=Number(state.currentDuration)||0, pos=Number(state.currentTime)||0;
  if(dur>0 && Number.isFinite(dur)){
    try{ navigator.mediaSession.setPositionState({duration:Math.max(dur,0.001), position:Math.min(Math.max(pos,0),Math.max(dur,0.001)), playbackRate:1}); }catch(e){}
  }
}
function seekBy(delta){
  const nextTime=Math.max(0,(Number(state.currentTime)||0)+delta);
  seekToSeconds(nextTime);
}
function seekToSeconds(seconds){
  const song=getCurrentSong(); if(!song) return;
  const dur=Number(state.currentDuration)||0;
  const t=dur>0 ? Math.min(Math.max(seconds,0),dur) : Math.max(seconds,0);
  if(isLocalSong(song) && localAudio){ localAudio.currentTime=t; }
  else if(player && player.seekTo){ player.seekTo(t,true); }
  state.currentTime=t;
  setMediaPosition();
}

function openLocalDB(){
  if(localDBPromise) return localDBPromise;
  localDBPromise = new Promise((resolve, reject) => {
    if(!('indexedDB' in window)){ reject(new Error('IndexedDB is not supported by this browser.')); return; }
    const req = indexedDB.open(LOCAL_DB_NAME, LOCAL_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if(!db.objectStoreNames.contains(LOCAL_STORE)){
        const store = db.createObjectStore(LOCAL_STORE, { keyPath: 'id' });
        store.createIndex('fingerprint', 'fingerprint', { unique: true });
        store.createIndex('title', 'title');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Could not open local music storage.'));
  });
  return localDBPromise;
}

async function getLocalRecords(){
  const db = await openLocalDB();
  return new Promise((resolve,reject)=>{
    const req = db.transaction(LOCAL_STORE,'readonly').objectStore(LOCAL_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function putLocalRecord(record){
  const db = await openLocalDB();
  return new Promise((resolve,reject)=>{
    const req = db.transaction(LOCAL_STORE,'readwrite').objectStore(LOCAL_STORE).put(record);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function deleteLocalRecord(id){
  const db = await openLocalDB();
  return new Promise((resolve,reject)=>{
    const req = db.transaction(LOCAL_STORE,'readwrite').objectStore(LOCAL_STORE).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function getLocalRecord(id){
  const db = await openLocalDB();
  return new Promise((resolve,reject)=>{
    const req = db.transaction(LOCAL_STORE,'readonly').objectStore(LOCAL_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

function localFingerprint(file){
  return `${file.name}::${file.size}::${file.lastModified || 0}::${file.type || ''}`;
}

function localSongFromRecord(r){
  return {
    id:r.id, source:'local', title:r.title || r.name || 'Untitled Track',
    artist:r.artist || 'Local file', name:r.name, type:r.type, size:r.size,
    duration:r.duration || 0, fingerprint:r.fingerprint, addedAt:r.addedAt || Date.now(),
  };
}

async function loadLocalLibrary(){
  try{
    if(navigator.storage?.persist){ try{ await navigator.storage.persist(); }catch(e){} }
    const records = await getLocalRecords();
    state.localLibrary = records.map(localSongFromRecord).sort((a,b)=>b.addedAt-a.addedAt);
    setLocalStatus();
  }catch(e){
    console.warn('Local library load failed',e);
    state.localLibrary=[];
    setLocalStatus('Local music storage is unavailable in this browser.');
  }
}

function setLocalStatus(msg){
  const el=document.getElementById('localStorageStatus');
  if(!el) return;
  if(msg){ el.textContent=msg; el.classList.add('error'); return; }
  const count=state.localLibrary.length;
  el.classList.remove('error');
  el.textContent=count ? `${count} song${count===1?'':'s'} stored offline on this device.` : 'No local music yet. Scan your Music folder to add songs.';
}

function parseLocalName(name){
  const base=name.replace(/\.[^.]+$/,'').replace(/[_]+/g,' ').trim();
  const parts=base.split(/\s+-\s+/);
  if(parts.length>=2) return {artist:parts.shift().trim() || 'Local file', title:parts.join(' - ').trim() || base};
  return {artist:'Local file', title:base || 'Untitled Track'};
}

async function importLocalFiles(files){
  const audioFiles=Array.from(files||[]).filter(f=>f && (f.type.startsWith('audio/') || /\.(mp3|m4a|aac|wav|ogg|flac|opus)$/i.test(f.name)));
  if(!audioFiles.length){ toast('No supported audio files were found.'); return; }
  let added=0, skipped=0;
  try{
    await openLocalDB();
    const existing=new Set(state.localLibrary.map(s=>s.fingerprint));
    for(const file of audioFiles){
      const fp=localFingerprint(file);
      if(existing.has(fp)){ skipped++; continue; }
      const meta=parseLocalName(file.name);
      const id='local_'+uid().slice(5);
      let duration=0;
      try{ duration=await getAudioDuration(file); }catch(e){}
      await putLocalRecord({id, fingerprint:fp, name:file.name, type:file.type, size:file.size, lastModified:file.lastModified || 0, title:meta.title, artist:meta.artist, duration, blob:file, addedAt:Date.now()});
      existing.add(fp); added++;
    }
    await loadLocalLibrary();
    renderAll();
    toast(added ? `Added ${added} local song${added===1?'':'s'}${skipped?` · ${skipped} already added`:''}` : 'All selected songs are already in your library.');
  }catch(e){
    console.error('Local import failed',e);
    toast(e?.name==='QuotaExceededError' ? 'Device storage is full. Remove some local songs and try again.' : 'Could not store local music on this device.');
  }
}

function getAudioDuration(file){
  return new Promise((resolve,reject)=>{
    const audio=document.createElement('audio');
    const url=URL.createObjectURL(file);
    const cleanup=()=>{ URL.revokeObjectURL(url); audio.removeAttribute('src'); audio.load(); };
    audio.preload='metadata';
    audio.onloadedmetadata=()=>{ const d=Number.isFinite(audio.duration)?audio.duration:0; cleanup(); resolve(d); };
    audio.onerror=()=>{ cleanup(); reject(new Error('metadata')); };
    audio.src=url;
  });
}

async function scanLocalMusic(){
  const btn=document.getElementById('scanLocalBtn');
  if(btn) btn.disabled=true;
  try{
    if(window.showDirectoryPicker){
      const dir=await window.showDirectoryPicker({mode:'read'});
      const files=[];
      async function walk(handle){
        for await(const entry of handle.values()) {
          if(entry.kind==='file'){
            const f=await entry.getFile();
            if(f.type.startsWith('audio/') || /\.(mp3|m4a|aac|wav|ogg|flac|opus)$/i.test(f.name)) files.push(f);
          } else if(entry.kind==='directory'){
            await walk(entry);
          }
        }
      }
      await walk(dir);
      await importLocalFiles(files);
    } else {
      document.getElementById('localFilesInput').click();
    }
  }catch(e){
    if(e?.name!=='AbortError') toast('Could not access that folder. Please grant access and try again.');
  }finally{ if(btn) btn.disabled=false; }
}

async function removeLocalSong(id){
  const song=findSong(id); if(!song || !isLocalSong(song)) return;
  openConfirm('Remove local song?', `“${song.title}” will be removed from this device.`, async()=>{
    try{
      if(state.queue.includes(id)){
        const pos=state.queue.indexOf(id);
        if(pos===state.queuePos){ state.isPlaying=false; stopLocalAudio(); state.queue=[]; state.queuePos=-1; }
        else { state.queue.splice(pos,1); if(pos<state.queuePos) state.queuePos--; }
      }
      await deleteLocalRecord(id);
      state.localLibrary=state.localLibrary.filter(s=>s.id!==id);
      state.localFavorites=state.localFavorites.filter(x=>x!==id);
      state.localRecent=state.localRecent.filter(x=>x!==id);
      saveLS(LS_KEYS.localFavorites,state.localFavorites); saveLS(LS_KEYS.localRecent,state.localRecent);
      renderAll(); updateNowPlayingUI(); toast('Removed from this device');
    }catch(e){ toast('Could not remove the local song.'); }
  });
}

async function toggleLocalFavorite(id){
  if(state.localFavorites.includes(id)) state.localFavorites=state.localFavorites.filter(x=>x!==id);
  else state.localFavorites.unshift(id);
  saveLS(LS_KEYS.localFavorites,state.localFavorites); renderAll(); updateNowPlayingUI();
}

function addLocalRecent(id){
  state.localRecent=[id,...state.localRecent.filter(x=>x!==id)].slice(0,20);
  saveLS(LS_KEYS.localRecent,state.localRecent);
}

async function getLocalBlobUrl(song){
  const record=await getLocalRecord(song.id);
  if(!record?.blob) throw new Error('Local file is unavailable.');
  return URL.createObjectURL(record.blob);
}

function stopLocalAudio(){
  if(localAudio){
    try{ localAudio.pause(); localAudio.removeAttribute('src'); localAudio.load(); }catch(e){}
    if(localAudio._wlUrl){ try{ URL.revokeObjectURL(localAudio._wlUrl); }catch(e){} localAudio._wlUrl=null; }
  }
}

async function loadLocalSong(song, autoplay=true){
  try{
    const url=await getLocalBlobUrl(song);
    if(player && state.playbackSource !== 'local' && player.pauseVideo){ try{ player.pauseVideo(); }catch(e){} }
    if(!localAudio){
      localAudio=document.createElement('audio');
      localAudio.preload='metadata';
      localAudio.addEventListener('play',()=>{ state.isPlaying=true; startProgressTimer(); updatePlayPauseUI(); updateMediaSession(); });
      localAudio.addEventListener('pause',()=>{ state.isPlaying=false; stopProgressTimer(); updatePlayPauseUI(); updateMediaSession(); });
      localAudio.addEventListener('ended',()=>{ state.isPlaying=false; stopProgressTimer(); updateMediaSession(); handleSongEnded(); });
      localAudio.addEventListener('error',()=>{ toast('This local file cannot be played by this browser.'); state.isPlaying=false; updatePlayPauseUI(); updateMediaSession(); });
      document.body.appendChild(localAudio); // keep it attached — more reliable across WebView versions than a detached element
    }
    if(localAudio._wlUrl) URL.revokeObjectURL(localAudio._wlUrl);
    localAudio._wlUrl=url;
    localAudio.src=url; localAudio.volume=state.muted?0:state.volume/100;
    state.playbackSource='local';
    state.currentTime=0;
    state.currentDuration=song.duration||0;
    updateMediaSession();
    updateNowPlayingUI();
    addLocalRecent(song.id);
    renderAll(true);
    if(autoplay) await localAudio.play();
  }catch(e){ console.error(e); toast('This local file is no longer available. Rescan your Music folder.'); }
}

/* ---------- connection banner ---------- */
function setConnError(hasError){
  document.getElementById('connBanner').classList.toggle('hidden', !hasError);
}

/* ---------- cloud fetches ---------- */
async function fetchLibrary(){
  if(!sb || !state.user) return;
  try{
    const { data, error } = await sb
      .from('songs')
      .select('*')
      .order('created_at', { ascending: false });
    if(error) throw error;
    state.library = data.map(mapSongRow);
    setConnError(false);
  }catch(e){
    console.warn('fetchLibrary failed', e);
    setConnError(true);
  }
}

async function fetchFavorites(){
  if(!sb || !state.user) return;
  try{
    const { data, error } = await sb
      .from('favorites')
      .select('song_id')
      .order('created_at', { ascending: false });
    if(error) throw error;
    state.favorites = data.map(r => r.song_id);
    setConnError(false);
  }catch(e){
    console.warn('fetchFavorites failed', e);
    setConnError(true);
  }
}

async function fetchRecentlyPlayed(){
  if(!sb || !state.user) return;
  try{
    const { data, error } = await sb
      .from('recently_played')
      .select('song_id')
      .order('played_at', { ascending: false })
      .limit(20);
    if(error) throw error;
    state.recent = data.map(r => r.song_id);
    setConnError(false);
  }catch(e){
    console.warn('fetchRecentlyPlayed failed', e);
    setConnError(true);
  }
}

async function loadCloudData(){
  await Promise.all([fetchLibrary(), fetchFavorites(), fetchRecentlyPlayed()]);
  await loadLocalLibrary();
  renderAll();
  updateNowPlayingUI();
}

/* ---------- realtime sync across devices ---------- */
function subscribeRealtime(){
  if(!sb || !state.user || realtimeChannel) return;
  realtimeChannel = sb
    .channel('wl-sync-' + state.user.id)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'songs', filter: `user_id=eq.${state.user.id}` },
      () => fetchLibrary().then(renderAll))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'favorites', filter: `user_id=eq.${state.user.id}` },
      () => fetchFavorites().then(() => { renderAll(); updateNowPlayingUI(); }))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'recently_played', filter: `user_id=eq.${state.user.id}` },
      () => fetchRecentlyPlayed().then(renderAll))
    .subscribe();
}
function unsubscribeRealtime(){
  if(realtimeChannel){ sb.removeChannel(realtimeChannel); realtimeChannel = null; }
}

/* ---------- demo suggestions (not part of the cloud library
   until explicitly added) ---------- */
async function quickAddDemo(url, btn){
  const result = await addSongFromUrl(url);
  if(result.ok){
    toast(`Added "${result.song.title}"`);
  } else {
    toast(result.error);
    // re-enable so the user can retry (e.g. after a network hiccup) —
    // on success the button disappears anyway since renderAll() redraws
    // the empty state once the library is non-empty
    if(btn) btn.disabled = false;
  }
}

/* ---------------------------------------------------------
   3b. AUTHENTICATION
   --------------------------------------------------------- */
function showAuthScreen(){
  document.getElementById('authScreen').classList.remove('hidden');
  document.getElementById('appShell').classList.add('hidden');
  document.getElementById('playerBar').classList.add('hidden');
}
function showApp(){
  document.getElementById('authScreen').classList.add('hidden');
  document.getElementById('appShell').classList.remove('hidden');
  document.getElementById('playerBar').classList.remove('hidden');
  document.getElementById('accountEmail').textContent = state.user?.email || '—';
}

function switchAuthForm(target){
  document.getElementById('authLoginForm').classList.toggle('hidden', target !== 'login');
  document.getElementById('authSignupForm').classList.toggle('hidden', target !== 'signup');
}

function setAuthStatus(el, msg, kind){
  el.textContent = msg;
  el.className = 'modal-status' + (kind ? ' ' + kind : '');
}

async function handleLogin(e){
  e.preventDefault();
  if(!sb){ toast('Supabase is not configured yet — see script.js.'); return; }
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const statusEl = document.getElementById('loginStatus');
  const btn = document.getElementById('loginSubmit');
  if(!email || !password){ setAuthStatus(statusEl, 'Enter your email and password.', 'err'); return; }

  btn.disabled = true;
  setAuthStatus(statusEl, 'Logging in…');
  try{
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if(error) throw error;
    state.user = data.user;
    setAuthStatus(statusEl, '', '');
    onAuthenticated();
  }catch(e){
    setAuthStatus(statusEl, e.message || 'Login failed. Check your credentials and try again.', 'err');
  }finally{
    btn.disabled = false;
  }
}

async function handleSignup(e){
  e.preventDefault();
  if(!sb){ toast('Supabase is not configured yet — see script.js.'); return; }
  const email = document.getElementById('signupEmail').value.trim();
  const password = document.getElementById('signupPassword').value;
  const statusEl = document.getElementById('signupStatus');
  const btn = document.getElementById('signupSubmit');
  if(!email || password.length < 6){ setAuthStatus(statusEl, 'Enter an email and a password of at least 6 characters.', 'err'); return; }

  btn.disabled = true;
  setAuthStatus(statusEl, 'Creating your account…');
  try{
    const { data, error } = await sb.auth.signUp({ email, password });
    if(error) throw error;
    if(data.session){
      state.user = data.user;
      onAuthenticated();
    } else {
      setAuthStatus(statusEl, 'Account created — check your email to confirm, then log in.', 'ok');
      setTimeout(() => switchAuthForm('login'), 1800);
    }
  }catch(e){
    setAuthStatus(statusEl, e.message || 'Could not create account. Try again.', 'err');
  }finally{
    btn.disabled = false;
  }
}

async function handleLogout(){
  if(!sb) return;
  unsubscribeRealtime();
  await sb.auth.signOut();
  state.user = null;
  state.library = []; state.favorites = []; state.recent = [];
  state.queue = []; state.queuePos = -1;
  if(player && player.stopVideo){ try{ player.stopVideo(); }catch(e){} }
  state.isPlaying = false;
  showAuthScreen();
}

async function onAuthenticated(){
  showApp();
  await loadCloudData();
  subscribeRealtime();
}

async function initAuth(){
  if(!sb){
    // Supabase isn't configured — surface this clearly instead of failing silently.
    showAuthScreen();
    setAuthStatus(document.getElementById('loginStatus'),
      'Supabase isn\'t configured yet. Add your project URL and anon key at the top of script.js.', 'err');
    return;
  }
  const { data: { session } } = await sb.auth.getSession();
  if(session?.user){
    state.user = session.user;
    await onAuthenticated();
  } else {
    showAuthScreen();
  }

  sb.auth.onAuthStateChange((event, session) => {
    if(event === 'SIGNED_OUT'){
      state.user = null;
      showAuthScreen();
    }
  });
}

/* ---------------------------------------------------------
   4. YOUTUBE IFRAME PLAYER
   --------------------------------------------------------- */
function onYouTubeIframeAPIReady(){
  player = new YT.Player('ytPlayerHost', {
    height: '100%',
    width: '100%',
    playerVars: {
      autoplay: 0,
      controls: 0,
      disablekb: 1,
      fs: 0,
      modestbranding: 1,
      rel: 0,
      playsinline: 1,
    },
    events: {
      onReady: onPlayerReady,
      onStateChange: onPlayerStateChange,
      onError: onPlayerError,
    }
  });
}
window.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;

function onPlayerReady(){
  state.playerReady = true;
  player.setVolume(state.muted ? 0 : state.volume);
  if(state.pendingAutoplay && state.queuePos >= 0){
    state.pendingAutoplay = false;
    loadCurrentIntoPlayer(true);
  }
}

function onPlayerStateChange(e){
  if(state.playbackSource==='local') return;
  if(!window.YT) return;
  const S = YT.PlayerState;
  if(e.data === S.PLAYING){
    state.isPlaying = true;
    startProgressTimer();
    updatePlayPauseUI();
    updateMediaSession();
    markNowPlayingActive(true);
  } else if(e.data === S.PAUSED){
    state.isPlaying = false;
    stopProgressTimer();
    updatePlayPauseUI();
    updateMediaSession();
    markNowPlayingActive(false);
  } else if(e.data === S.ENDED){
    state.isPlaying = false;
    stopProgressTimer();
    updatePlayPauseUI();
    updateMediaSession();
    handleSongEnded();
  } else if(e.data === S.BUFFERING){
    // no-op, UI keeps last known state
  }
}

function onPlayerError(e){
  const codes = {2:'Invalid video.', 5:'Playback error.', 100:'Video not found or was removed.',
    101:"This song can't be embedded here.", 150:"This song can't be embedded here."};
  const msg = codes[e.data] || 'Playback error.';
  toast(`⚠️ ${msg}`);
  const song = getCurrentSong();
  if(song){
    showInlineError(`"${song.title}" isn't available for playback. You can remove it from your library or try another version.`);
  }
  // auto-advance after a short delay so a broken song doesn't stall playback
  setTimeout(() => next(true), 1400);
}

function showInlineError(msg){
  toast(msg);
}

function loadCurrentIntoPlayer(autoplay){
  const song = getCurrentSong();
  if(!song) return;
  if(isLocalSong(song)){ loadLocalSong(song, autoplay); return; }
  state.playbackSource='youtube';
  updateMediaSession();
  if(!state.playerReady || !player || !player.loadVideoById){ state.pendingAutoplay=autoplay; return; }
  stopLocalAudio();
  if(autoplay) player.loadVideoById(song.ytid); else player.cueVideoById(song.ytid);
  updateNowPlayingUI();
  addToRecent(song.id);
  renderAll(true);
}

/* ---------------------------------------------------------
   5. QUEUE / PLAYBACK CONTROL
   --------------------------------------------------------- */
function getCurrentSong(){
  if(state.queuePos < 0 || state.queuePos >= state.queue.length) return null;
  return findSong(state.queue[state.queuePos]);
}

// Starts playback of `songId` within the given context list (array of song ids).
function playFromContext(contextIds, songId){
  const ids = contextIds.filter(id => findSong(id));
  const idx = ids.indexOf(songId);
  if(idx === -1) return;
  state.queue = ids;
  state.queuePos = idx;
  if(state.shuffle) rebuildShuffleOrder(true);
  playCurrent();
}

function playCurrent(){ loadCurrentIntoPlayer(true); }

function togglePlayPause(){
  const song = getCurrentSong();
  if(!song){
    // nothing loaded yet — start from the top of the library
    if(getAllSongs().length){
      const all=getAllSongs();
      playFromContext(all.map(s => s.id), all[0].id);
    }
    return;
  }
  if(isLocalSong(song)){
    if(!localAudio || !localAudio.src){ loadLocalSong(song,true); return; }
    if(state.isPlaying) localAudio.pause(); else localAudio.play().catch(()=>toast('Tap play again to start local audio.'));
    return;
  }
  if(!state.playerReady){ state.pendingAutoplay = true; return; }
  if(state.isPlaying) player.pauseVideo();
  else player.playVideo();
}

function handleSongEnded(){
  if(state.repeat === 'one'){
    if(isLocalSong(getCurrentSong())){ localAudio.currentTime=0; localAudio.play().catch(()=>{}); }
    else { player.seekTo(0); player.playVideo(); }
    return;
  }
  next(true);
}

function next(fromAuto){
  if(!state.queue.length) return;
  if(state.shuffle){
    state.shufflePos++;
    if(state.shufflePos >= state.shuffleOrder.length){
      if(state.repeat === 'all'){
        rebuildShuffleOrder(false);
        state.shufflePos = 0;
      } else {
        state.shufflePos = state.shuffleOrder.length - 1;
        if(fromAuto){ state.isPlaying = false; updatePlayPauseUI(); return; }
        return;
      }
    }
    state.queuePos = state.shuffleOrder[state.shufflePos];
  } else {
    state.queuePos++;
    if(state.queuePos >= state.queue.length){
      if(state.repeat === 'all'){ state.queuePos = 0; }
      else { state.queuePos = state.queue.length - 1; return; }
    }
  }
  playCurrent();
}

function prev(){
  if(!state.queue.length) return;
  // if we're more than 3s into the song, restart it instead of going back
  if(isLocalSong(getCurrentSong())){
    if(localAudio && localAudio.currentTime > 3){ localAudio.currentTime=0; return; }
  } else if(player && player.getCurrentTime && player.getCurrentTime() > 3){
    player.seekTo(0); return;
  }
  if(state.shuffle){
    state.shufflePos = Math.max(0, state.shufflePos - 1);
    state.queuePos = state.shuffleOrder[state.shufflePos];
  } else {
    state.queuePos = Math.max(0, state.queuePos - 1);
  }
  playCurrent();
}

function rebuildShuffleOrder(keepCurrentFirst){
  const positions = state.queue.map((_, i) => i);
  const currentPos = state.queuePos;
  const rest = positions.filter(p => p !== currentPos);
  for(let i = rest.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  state.shuffleOrder = keepCurrentFirst ? [currentPos, ...rest] : rest;
  state.shufflePos = 0;
}

function toggleShuffle(){
  state.shuffle = !state.shuffle;
  if(state.shuffle) rebuildShuffleOrder(true);
  persistSettings();
  updateShuffleRepeatUI();
}

function cycleRepeat(){
  const order = ['off','all','one'];
  const idx = order.indexOf(state.repeat);
  state.repeat = order[(idx + 1) % order.length];
  persistSettings();
  updateShuffleRepeatUI();
}

function addToQueueExplicit(songId){
  if(state.queue.length === 0){
    playFromContext([songId], songId);
    toast('Added to queue');
    return;
  }
  state.queue.splice(state.queuePos + 1, 0, songId);
  if(state.shuffle){
    state.shuffleOrder.splice(state.shufflePos + 1, 0, state.queuePos + 1);
  }
  toast('Added to queue');
  renderQueueView();
}

function removeFromQueue(pos){
  if(pos === state.queuePos) return; // don't remove the currently playing song this way
  state.queue.splice(pos, 1);
  if(pos < state.queuePos) state.queuePos--;
  state.shuffleOrder = state.shuffleOrder
    .filter(p => p !== pos)
    .map(p => (p > pos ? p - 1 : p));
  renderQueueView();
}

function clearQueue(){
  const current = state.queue[state.queuePos];
  state.queue = current ? [current] : [];
  state.queuePos = current ? 0 : -1;
  if(state.shuffle) rebuildShuffleOrder(true);
  renderQueueView();
  toast('Queue cleared');
}

/* ---------------------------------------------------------
   6. PROGRESS / SEEK / VOLUME
   --------------------------------------------------------- */
function startProgressTimer(){
  stopProgressTimer();
  progressTimer = setInterval(updateProgressUI, 400);
  updateProgressUI();
}
function stopProgressTimer(){ clearInterval(progressTimer); progressTimer = null; }

function updateProgressUI(){
  let cur = 0, dur = 0;
  const current=getCurrentSong();
  if(isLocalSong(current)){
    if(!localAudio) return;
    cur=localAudio.currentTime||0; dur=localAudio.duration||current.duration||0;
  } else {
    if(!player || !player.getCurrentTime) return;
    try{ cur=player.getCurrentTime()||0; dur=player.getDuration()||0; }catch(e){ return; }
  }
  state.currentTime = cur;
  state.currentDuration = dur;
  setMediaPosition();
  const pct = dur ? (cur / dur) * 100 : 0;

  document.getElementById('pbTimeCurrent').textContent = formatTime(cur);
  document.getElementById('pbTimeTotal').textContent = formatTime(dur);
  document.getElementById('pbSeekFill').style.width = pct + '%';
  document.getElementById('pbSeekThumb').style.left = pct + '%';
  document.getElementById('playerProgressFill').style.width = pct + '%';

  document.getElementById('npcTimeCurrent').textContent = formatTime(cur);
  document.getElementById('npcTimeTotal').textContent = formatTime(dur);
  document.getElementById('npcSeekFill').style.width = pct + '%';
  document.getElementById('npcSeekThumb').style.left = pct + '%';
  const npFill=document.getElementById('npSeekFill');
  const npThumb=document.getElementById('npSeekThumb');
  const npCur=document.getElementById('npTimeCurrent');
  const npDur=document.getElementById('npTimeTotal');
  if(npFill) npFill.style.width=pct+'%';
  if(npThumb) npThumb.style.left=pct+'%';
  if(npCur) npCur.textContent=formatTime(cur);
  if(npDur) npDur.textContent=formatTime(dur);
}

function seekToRatio(bar, clientX){
  if(!state.currentDuration) return;
  const rect=bar.getBoundingClientRect();
  const ratio=Math.min(1,Math.max(0,(clientX-rect.left)/rect.width));
  const target=state.currentDuration*ratio;
  if(isLocalSong(getCurrentSong())){ if(localAudio) localAudio.currentTime=target; }
  else if(player && player.seekTo) player.seekTo(target,true);
  state.currentTime=target;
  setMediaPosition();
  updateProgressUI();
}

function setupSeekBar(barEl){
  let dragging = false;
  barEl.addEventListener('mousedown', (e) => { dragging = true; seekToRatio(barEl, e.clientX); });
  window.addEventListener('mousemove', (e) => { if(dragging) seekToRatio(barEl, e.clientX); });
  window.addEventListener('mouseup', () => dragging = false);
  barEl.addEventListener('touchstart', (e) => { dragging = true; seekToRatio(barEl, e.touches[0].clientX); }, {passive:true});
  barEl.addEventListener('touchmove', (e) => { if(dragging) seekToRatio(barEl, e.touches[0].clientX); }, {passive:true});
  barEl.addEventListener('touchend', () => dragging = false);
}

function setVolume(vol){
  state.volume = Math.min(100, Math.max(0, vol));
  state.muted = state.volume === 0 ? state.muted : false;
  if(player && player.setVolume) player.setVolume(state.muted ? 0 : state.volume);
  if(localAudio) localAudio.volume=state.muted?0:state.volume/100;
  updateVolumeUI();
  persistSettings();
}
function toggleMute(){
  state.muted = !state.muted;
  if(player && player.setVolume) player.setVolume(state.muted ? 0 : state.volume);
  if(localAudio) localAudio.volume=state.muted?0:state.volume/100;
  updateVolumeUI();
  persistSettings();
}
function setVolumeFromRatio(bar, clientX){
  const rect = bar.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  setVolume(Math.round(ratio * 100));
}

/* ---------------------------------------------------------
   7. LIBRARY / FAVORITES / RECENT MUTATIONS
   --------------------------------------------------------- */
async function addSongFromUrl(url){
  if(!sb || !state.user){
    return { ok:false, error: "You're not logged in." };
  }
  const videoId = extractYouTubeId(url);
  if(!videoId){
    return { ok:false, error: "That doesn't look like a valid YouTube link." };
  }
  if(state.library.some(s => s.ytid === videoId)){
    return { ok:false, error: 'This song is already in your library.' };
  }

  let meta;
  try{ meta = await resolveMetadata(videoId, url); }
  catch(e){ meta = { title:'Untitled Track', artist:'Unknown Artist' }; }

  try{
    const { data, error } = await sb
      .from('songs')
      .insert({
        user_id: state.user.id,
        youtube_id: videoId,
        youtube_url: url.trim(),
        title: meta.title,
        artist: meta.artist,
        thumbnail: null,
      })
      .select()
      .single();

    if(error){
      // unique constraint violation = already in the library
      if(error.code === '23505'){
        return { ok:false, error: 'This song is already in your library.' };
      }
      throw error;
    }

    const song = mapSongRow(data);
    state.library.unshift(song);
    setConnError(false);
    renderAll();
    return { ok:true, song };
  }catch(e){
    console.warn('addSongFromUrl failed', e);
    setConnError(true);
    return { ok:false, error: 'Unable to reach your music library. Check your internet connection and try again.' };
  }
}

function requestRemoveSong(songId){
  const song = findSong(songId);
  if(!song) return;
  openConfirm(
    'Remove this song?',
    `"${song.title}" will be removed from your library. This can't be undone.`,
    () => removeSong(songId)
  );
}

async function removeSong(songId){
  if(!sb || !state.user) return;
  try{
    const { error } = await sb.from('songs').delete().eq('id', songId);
    if(error) throw error;
    setConnError(false);
  }catch(e){
    console.warn('removeSong failed', e);
    setConnError(true);
    toast('Could not remove the song — check your connection.');
    return;
  }

  state.library = state.library.filter(s => s.id !== songId);
  state.favorites = state.favorites.filter(id => id !== songId);
  state.recent = state.recent.filter(id => id !== songId);
  const queuePosOfRemoved = state.queue.indexOf(songId);
  if(queuePosOfRemoved !== -1){
    const wasCurrent = queuePosOfRemoved === state.queuePos;
    state.queue.splice(queuePosOfRemoved, 1);
    if(queuePosOfRemoved < state.queuePos) state.queuePos--;

    // keep the shuffle order in sync with the shortened queue —
    // otherwise Next/Prev can point at the wrong positions once
    // shuffle is re-enabled or already active
    state.shuffleOrder = state.shuffleOrder
      .filter(p => p !== queuePosOfRemoved)
      .map(p => (p > queuePosOfRemoved ? p - 1 : p));

    if(wasCurrent){
      state.isPlaying = false;
      if(state.queue.length === 0){
        state.queuePos = -1;
        if(player && player.stopVideo) player.stopVideo();
      } else {
        state.queuePos = Math.min(state.queuePos, state.queue.length - 1);
        // load (but don't autoplay) whatever is now current, so the
        // player actually matches what the UI shows — otherwise the
        // iframe still has the just-deleted song loaded, and hitting
        // play would resume that instead of the new current song
        cueCurrentWithoutPlaying();
      }
    }
    if(state.shuffle) state.shufflePos = state.shuffleOrder.indexOf(state.queuePos);
  }
  renderAll();
  updateNowPlayingUI();
  toast('Removed from library');
}

function cueCurrentWithoutPlaying(){
  const song = getCurrentSong();
  if(!song || !state.playerReady || !player || !player.cueVideoById) return;
  player.cueVideoById(song.ytid);
}

async function toggleFavorite(songId){
  if(!sb || !state.user) return;
  const isFav = state.favorites.includes(songId);

  // optimistic UI update
  if(isFav) state.favorites = state.favorites.filter(id => id !== songId);
  else state.favorites.unshift(songId);
  renderAll();
  updateNowPlayingUI();

  try{
    if(isFav){
      const { error } = await sb.from('favorites').delete()
        .eq('user_id', state.user.id).eq('song_id', songId);
      if(error) throw error;
    } else {
      const { error } = await sb.from('favorites').insert({
        user_id: state.user.id, song_id: songId,
      });
      if(error && error.code !== '23505') throw error;
    }
    setConnError(false);
  }catch(e){
    console.warn('toggleFavorite failed', e);
    setConnError(true);
    // revert optimistic update on failure
    if(isFav) state.favorites.unshift(songId);
    else state.favorites = state.favorites.filter(id => id !== songId);
    renderAll();
    updateNowPlayingUI();
    toast('Could not update favorites — check your connection.');
  }
}

async function addToRecent(songId){
  // local UI update first so playback never waits on the network
  state.recent = [songId, ...state.recent.filter(id => id !== songId)].slice(0, 20);
  renderAll(true);

  if(!sb || !state.user) return;
  try{
    const { error } = await sb.from('recently_played').upsert({
      user_id: state.user.id,
      song_id: songId,
      played_at: new Date().toISOString(),
    }, { onConflict: 'user_id,song_id' });
    if(error) throw error;

    // trim to the latest 20 entries for this user
    const { data: rows, error: selErr } = await sb
      .from('recently_played')
      .select('id')
      .order('played_at', { ascending: false });
    if(!selErr && rows && rows.length > 20){
      const staleIds = rows.slice(20).map(r => r.id);
      await sb.from('recently_played').delete().in('id', staleIds);
    }
    setConnError(false);
  }catch(e){
    console.warn('addToRecent failed', e);
    setConnError(true);
  }
}

/* ---------------------------------------------------------
   8. RENDERING
   --------------------------------------------------------- */
function sortSongs(songs, mode){
  const list=[...songs];
  const text=(v)=>String(v||'').toLocaleLowerCase();
  switch(mode){
    case 'title-asc': return list.sort((a,b)=>text(a.title).localeCompare(text(b.title),undefined,{numeric:true,sensitivity:'base'}));
    case 'title-desc': return list.sort((a,b)=>text(b.title).localeCompare(text(a.title),undefined,{numeric:true,sensitivity:'base'}));
    case 'artist-asc': return list.sort((a,b)=>text(a.artist).localeCompare(text(b.artist),undefined,{numeric:true,sensitivity:'base'}) || text(a.title).localeCompare(text(b.title),undefined,{sensitivity:'base'}));
    case 'duration-desc': return list.sort((a,b)=>(Number(b.duration)||0)-(Number(a.duration)||0));
    case 'duration-asc': return list.sort((a,b)=>(Number(a.duration)||0)-(Number(b.duration)||0));
    default: return list.sort((a,b)=>(Number(b.addedAt)||0)-(Number(a.addedAt)||0));
  }
}

function applySortControls(){
  const y=document.getElementById('youtubeSort');
  const l=document.getElementById('localSort');
  if(y) y.value=state.sort.youtube;
  if(l) l.value=state.sort.local;
}

// Small status icon used everywhere instead of album art: a music
// note by default, swapping to an animated equalizer via CSS when
// the containing row/card carries .is-current (+ .is-playing for the
// animation). `withPlayHover` adds a play-triangle that CSS reveals
// on :hover, for icons that double as a play button.
function statusIconHTML(withPlayHover){
  return `<svg class="ri-note" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg><span class="ri-eq"><i></i><i></i><i></i></span>${withPlayHover ? '<svg class="ri-play" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>' : ''}`;
}

function songCardHTML(song, opts = {}){
  const isFav = isLocalSong(song) ? state.localFavorites.includes(song.id) : state.favorites.includes(song.id);
  const current = getCurrentSong();
  const isCurrent = !!(current && current.id === song.id);
  const isPlaying = isCurrent && state.isPlaying;
  return `
  <div class="song-card ${isCurrent ? 'is-current' : ''} ${isPlaying ? 'is-playing' : ''}" data-id="${song.id}">
    <button class="song-row-icon" data-action="play" title="${isPlaying ? 'Pause' : 'Play'}">
      ${statusIconHTML(true)}
    </button>
    <div class="song-card-info">
      <p class="song-card-title">${escapeHtml(song.title)}</p>
      <p class="song-card-artist">${escapeHtml(song.artist)}</p>
    </div>
    <button class="song-row-fav ${isFav ? 'active' : ''}" data-action="fav" title="${isFav ? 'Remove favorite' : 'Add to favorites'}">
      <svg viewBox="0 0 24 24" fill="${isFav ? 'currentColor' : 'none'}"><path d="M12 20.3s-7-4.3-9.3-8.7C.9 8 2.4 4.7 5.7 4.7c1.9 0 3.3 1 4.3 2.5 1-1.5 2.4-2.5 4.3-2.5 3.3 0 4.8 3.3 3 6.9-2.3 4.4-9.3 8.7-9.3 8.7z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>
    </button>
    <div class="song-card-menu-wrap">
      <button class="song-card-menu-btn" data-action="menu" title="More">⋮</button>
      <div class="dropdown hidden" data-menu>
        <button data-action="play">▶ Play</button>
        <button data-action="queue">＋ Add to queue</button>
        <button data-action="fav">${isFav ? '♥ Remove favorite' : '♡ Add to favorites'}</button>
        <button data-action="remove" class="danger">✕ ${isLocalSong(song) ? 'Remove from device' : 'Remove from library'}</button>
      </div>
    </div>
  </div>`;
}

function emptyStateHTML(title, sub, showAdd, showDemo){
  return `<div class="empty-state">
    <h3>${escapeHtml(title)}</h3>
    <p>${escapeHtml(sub)}</p>
    ${showAdd ? '<button class="solid-btn" data-action="open-add">+ Add Song</button>' : ''}
    ${showDemo ? `<div class="demo-row">
      <span>or try one:</span>
      ${DEMO_SUGGESTIONS.map((u, i) => `<button class="ghost-btn sm" data-action="demo-add" data-url="${escapeHtml(u)}">Demo song ${i+1}</button>`).join('')}
    </div>` : ''}
  </div>`;
}

function renderGrid(containerId, songs, emptyTitle, emptySub, showAdd, showDemo){
  const el = document.getElementById(containerId);
  if(!songs.length){
    el.innerHTML = emptyStateHTML(emptyTitle, emptySub, showAdd, showDemo);
    return;
  }
  el.innerHTML = songs.map(s => songCardHTML(s)).join('');
}

function renderAll(skipHeavy){
  const all=getAllSongs();
  const favorites=[...state.favorites.map(findSong).filter(Boolean), ...state.localFavorites.map(findSong).filter(Boolean)];
  const recent=[...state.recent.map(findSong).filter(Boolean), ...state.localRecent.map(findSong).filter(Boolean)].slice(0,20);
  const youtubeSongs=sortSongs(state.library, state.sort.youtube);
  const localSongs=sortSongs(state.localLibrary, state.sort.local);
  renderGrid('homeLibraryGrid', youtubeSongs, 'Your YouTube library is empty', 'Add a YouTube song to build your cloud playlist.', true, true);
  renderGrid('homeLocalGrid', localSongs, 'No local music', 'Scan your Music folder to add offline songs.', false);
  renderGrid('libraryGrid', youtubeSongs, 'Your YouTube library is empty', 'Add a YouTube song to build your cloud playlist.', true, true);
  renderGrid('favoritesGrid', favorites, 'No favorites yet', 'Tap the heart on any song to save it here.', false);
  renderGrid('recentGrid', recent, 'Nothing played yet', 'Songs you play will show up here.', false);
  renderGrid('recentRow', recent.slice(0,10), 'Nothing played yet', 'Play a song to see it here.', false);
  renderGrid('favRow', favorites.slice(0,10), 'No favorites yet', 'Tap the heart to save songs here.', false);
  renderGrid('localGrid', localSongs, 'No local music', 'Scan your Music folder to add offline songs.', false);
  applySearchFilter();
  applySortControls();
  if(!skipHeavy) renderQueueView();
  attachCardListeners();
  setLocalStatus();
}

function attachCardListeners(){
  document.querySelectorAll('.grid, .hscroll').forEach(container => {
    if(container._bound) return;
    container._bound = true;
    container.addEventListener('click', onCardContainerClick);
  });
}

function onCardContainerClick(e){
  const menuBtn = e.target.closest('[data-action="menu"]');
  const card = e.target.closest('.song-card');
  const addBtn = e.target.closest('[data-action="open-add"]');
  const demoBtn = e.target.closest('[data-action="demo-add"]');

  if(addBtn){ openAddSongModal(); return; }
  if(demoBtn){ demoBtn.disabled = true; quickAddDemo(demoBtn.dataset.url, demoBtn); return; }
  if(!card) return;
  const songId = card.dataset.id;

  // close other open menus
  document.querySelectorAll('.dropdown').forEach(d => { if(d !== menuBtn?.nextElementSibling) d.classList.add('hidden'); });

  if(menuBtn){
    e.stopPropagation();
    const dd = card.querySelector('[data-menu]');
    dd.classList.toggle('hidden');
    return;
  }
  const action = e.target.closest('[data-action]')?.dataset.action;
  const song = findSong(songId);
  const contextIds = currentGridContextIds(card.closest('.grid, .hscroll'));

  if(action === 'fav'){ if(isLocalSong(song)) toggleLocalFavorite(songId); else toggleFavorite(songId); return; }
  if(action === 'remove'){ if(isLocalSong(song)) removeLocalSong(songId); else requestRemoveSong(songId); return; }
  if(action === 'queue'){ addToQueueExplicit(songId); return; }
  // default (art click, play button, or bare card click) = play
  playFromContext(contextIds, songId);
}

function currentGridContextIds(container){
  return Array.from(container.querySelectorAll('.song-card')).map(c => c.dataset.id);
}

document.addEventListener('click', (e) => {
  if(!e.target.closest('.song-card-menu-wrap')){
    document.querySelectorAll('.dropdown').forEach(d => d.classList.add('hidden'));
  }
});

function renderQueueView(){
  const el = document.getElementById('queueList');
  if(!state.queue.length){
    el.innerHTML = emptyStateHTML('Queue is empty', 'Play a song or add one to your queue to see it here.', false);
    return;
  }
  const order = state.shuffle ? state.shuffleOrder : state.queue.map((_, i) => i);
  const startFrom = Math.max(0, state.shuffle ? state.shufflePos : state.queuePos);
  const upcoming = order.slice(startFrom);

  el.innerHTML = upcoming.map((pos, i) => {
    const song = findSong(state.queue[pos]);
    if(!song) return '';
    const isCurrent = i === 0;
    const isPlaying = isCurrent && state.isPlaying;
    return `
    <div class="queue-row ${isCurrent ? 'is-current' : ''} ${isPlaying ? 'is-playing' : ''}" data-pos="${pos}">
      <span class="queue-num">${isCurrent ? '▶' : String(i).padStart(2,'0')}</span>
      <span class="queue-row-icon">${statusIconHTML(false)}</span>
      <div class="queue-meta">
        <div class="t">${escapeHtml(song.title)}</div>
        <div class="a">${escapeHtml(song.artist)}</div>
      </div>
      ${isCurrent ? '' : `<button class="queue-row-remove" data-action="remove-queue" title="Remove">✕</button>`}
    </div>`;
  }).join('');
}

document.getElementById('queueList').addEventListener('click', (e) => {
  const row = e.target.closest('.queue-row');
  if(!row) return;
  const pos = Number(row.dataset.pos);
  if(e.target.closest('[data-action="remove-queue"]')){ removeFromQueue(pos); return; }
  // clicking a queue row jumps to it
  if(state.shuffle){
    const shufflePosIdx = state.shuffleOrder.indexOf(pos);
    if(shufflePosIdx !== -1) state.shufflePos = shufflePosIdx;
  }
  state.queuePos = pos;
  playCurrent();
});

/* ---- Full Now Playing view ---- */
function openNowPlaying(){
  if(!getCurrentSong()){ toast('Play a song first.'); return; }
  switchView('now-playing');
  updateFullNowPlayingUI();
}

function updateFullNowPlayingUI(){
  const song=getCurrentSong();
  const title=document.getElementById('npTitle');
  if(!title) return;
  if(!song){
    title.textContent='Nothing playing';
    document.getElementById('npArtist').textContent='Choose a song to start listening.';
    document.getElementById('npSource').textContent='—';
    return;
  }
  title.textContent=song.title || 'Untitled Track';
  document.getElementById('npArtist').textContent=song.artist || 'Unknown Artist';
  document.getElementById('npSource').textContent=isLocalSong(song) ? 'LOCAL MUSIC · OFFLINE' : 'YOUTUBE MUSIC';
  const fav=isLocalSong(song) ? state.localFavorites.includes(song.id) : state.favorites.includes(song.id);
  document.getElementById('npHeart').classList.toggle('active',fav);
  document.getElementById('npShuffle').classList.toggle('active',state.shuffle);
  document.getElementById('npRepeat').classList.toggle('active',state.repeat!=='off');
  document.getElementById('npRepeatOneBadge').classList.toggle('hidden',state.repeat!=='one');
  const playPath='<path d="M8 5.5v13l11-6.5z"/>';
  const pausePath='<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>';
  document.getElementById('npPlayIcon').innerHTML=state.isPlaying?pausePath:playPath;
  document.getElementById('npPlayPause').title=state.isPlaying?'Pause':'Play';
  document.getElementById('npTimeCurrent').textContent=formatTime(state.currentTime);
  document.getElementById('npTimeTotal').textContent=formatTime(state.currentDuration);
  const pct=state.currentDuration?(state.currentTime/state.currentDuration)*100:0;
  document.getElementById('npSeekFill').style.width=pct+'%';
  document.getElementById('npSeekThumb').style.left=pct+'%';
  document.getElementById('npHeart').classList.toggle('active',fav);
  document.getElementById('npRecord').classList.toggle('playing',state.isPlaying);
}

/* ---- Now playing hero + bottom bar ---- */
function updateNowPlayingUI(){
  const song = getCurrentSong();
  const npcEmpty = document.getElementById('npcEmpty');
  const npcContent = document.getElementById('npcContent');

  if(!song){
    npcEmpty.classList.remove('hidden');
    npcContent.classList.add('hidden');
    document.getElementById('pbTitle').textContent = 'No song selected';
    document.getElementById('pbArtist').textContent = '—';
    state.currentTime=0; state.currentDuration=0;
    updateMediaSession();
    document.getElementById('pbThumb').classList.remove('playing');
    syncRowPlayingState();
    updateFullNowPlayingUI();
    return;
  }
  npcEmpty.classList.add('hidden');
  npcContent.classList.remove('hidden');
  document.getElementById('npcTitle').textContent = song.title;
  document.getElementById('npcArtist').textContent = song.artist;

  document.getElementById('pbTitle').textContent = song.title;
  document.getElementById('pbArtist').textContent = song.artist;

  const isFav = isLocalSong(song) ? state.localFavorites.includes(song.id) : state.favorites.includes(song.id);
  document.getElementById('pbHeart').classList.toggle('active', isFav);

  updateShuffleRepeatUI();
  updatePlayPauseUI();
  updateMediaSession();
  updateVolumeUI();
  syncRowPlayingState();
  updateFullNowPlayingUI();
}

// Keeps the small status icon (note / animated equalizer) in sync on
// every song row currently on screen — across the library grid,
// search results, favorites, recently played, and Home's preview
// rows — without needing a full re-render on every play/pause toggle.
function syncRowPlayingState(){
  const song = getCurrentSong();
  document.querySelectorAll('.song-card[data-id]').forEach(card => {
    const isCurrent = !!(song && card.dataset.id === song.id);
    card.classList.toggle('is-current', isCurrent);
    card.classList.toggle('is-playing', isCurrent && state.isPlaying);
  });
  const currentQueueRow = document.querySelector('#queueList .queue-row.is-current');
  if(currentQueueRow) currentQueueRow.classList.toggle('is-playing', state.isPlaying);
}

function markNowPlayingActive(playing){
  document.getElementById('npcContent').classList.toggle('playing', playing);
  document.getElementById('pbThumb').classList.toggle('playing', playing);
  syncRowPlayingState();
}

function updatePlayPauseUI(){
  const playing = state.isPlaying;
  const playPath = '<path d="M8 5.5v13l11-6.5z"/>';
  const pausePath = '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>';
  document.getElementById('npcPlayIcon').innerHTML = playing ? pausePath : playPath;
  document.getElementById('pbPlayIcon').innerHTML = playing ? pausePath : playPath;
  document.getElementById('npcPlayPause').title = playing ? 'Pause' : 'Play';
  document.getElementById('pbPlayPause').title = playing ? 'Pause' : 'Play';
  const npIcon=document.getElementById('npPlayIcon');
  if(npIcon) npIcon.innerHTML=playing ? pausePath : playPath;
  const npBtn=document.getElementById('npPlayPause');
  if(npBtn) npBtn.title=playing?'Pause':'Play';
  const npRecord=document.getElementById('npRecord');
  if(npRecord) npRecord.classList.toggle('playing',playing);
  markNowPlayingActive(playing);
}

function updateShuffleRepeatUI(){
  document.getElementById('npcShuffle').classList.toggle('active', state.shuffle);
  document.getElementById('pbShuffle').classList.toggle('active', state.shuffle);

  const repeatActive = state.repeat !== 'off';
  document.getElementById('npcRepeat').classList.toggle('active', repeatActive);
  document.getElementById('pbRepeat').classList.toggle('active', repeatActive);
  document.getElementById('repeatOneBadge').classList.toggle('hidden', state.repeat !== 'one');
  document.getElementById('pbRepeatOneBadge').classList.toggle('hidden', state.repeat !== 'one');
  document.getElementById('npShuffle')?.classList.toggle('active', state.shuffle);
  document.getElementById('npRepeat')?.classList.toggle('active', state.repeat !== 'off');
  document.getElementById('npRepeatOneBadge')?.classList.toggle('hidden', state.repeat !== 'one');
}

function updateVolumeUI(){
  const pct = state.muted ? 0 : state.volume;
  document.getElementById('volFill').style.width = pct + '%';
  document.getElementById('volThumb').style.left = pct + '%';
  const icon = document.getElementById('pbVolIcon');
  if(state.muted || state.volume === 0){
    icon.innerHTML = '<path d="M4 9v6h4l5 4V5L8 9H4z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M17 9l4 6M21 9l-4 6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>';
  } else {
    icon.innerHTML = '<path d="M4 9v6h4l5 4V5L8 9H4z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M16.5 8.5a5 5 0 0 1 0 7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>';
  }
}

/* ---------------------------------------------------------
   9. SEARCH
   --------------------------------------------------------- */
function applySearchFilter(){
  const q = document.getElementById('topSearchInput').value.trim().toLowerCase();
  const grid = document.getElementById('searchGrid');
  if(!q){
    grid.innerHTML = `<div class="empty-state"><h3>Search your music</h3><p>Start typing a song title or artist name.</p></div>`;
    return;
  }
  const results = getAllSongs().filter(s =>
    s.title.toLowerCase().includes(q) || s.artist.toLowerCase().includes(q)
  );
  if(!results.length){
    grid.innerHTML = emptyStateHTML('No results', `Nothing matches "${q}".`, false);
    return;
  }
  grid.innerHTML = results.map(s => songCardHTML(s)).join('');
}

/* ---------------------------------------------------------
   10. VIEW NAVIGATION
   --------------------------------------------------------- */
function switchView(view){
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById(`view-${view}`)?.classList.remove('hidden');
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  closeSidebarMobile();
  if(view === 'search') document.getElementById('topSearchInput').focus();
}

function closeSidebarMobile(){
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarScrim').classList.remove('show');
}

/* ---------------------------------------------------------
   11. MODALS
   --------------------------------------------------------- */
function openAddSongModal(){
  document.getElementById('addSongOverlay').classList.remove('hidden');
  document.getElementById('addSongInput').value = '';
  document.getElementById('addSongStatus').textContent = '';
  document.getElementById('addSongStatus').className = 'modal-status';
  document.getElementById('addSongInput').focus();
}
function closeAddSongModal(){
  document.getElementById('addSongOverlay').classList.add('hidden');
}

async function handleSubmitAddSong(){
  const input = document.getElementById('addSongInput');
  const statusEl = document.getElementById('addSongStatus');
  const btn = document.getElementById('submitAddSong');
  const url = input.value.trim();
  if(!url){
    statusEl.textContent = 'Paste a YouTube link first.';
    statusEl.className = 'modal-status err';
    return;
  }
  btn.disabled = true;
  statusEl.className = 'modal-status';
  statusEl.innerHTML = `<span class="spinner"></span> Fetching song details…`;

  const result = await addSongFromUrl(url);
  btn.disabled = false;

  if(!result.ok){
    statusEl.textContent = result.error;
    statusEl.className = 'modal-status err';
    return;
  }
  statusEl.textContent = `Added "${result.song.title}"`;
  statusEl.className = 'modal-status ok';
  toast('Song added to your library');
  setTimeout(closeAddSongModal, 700);
}

function openConfirm(title, sub, onConfirm){
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmSub').textContent = sub;
  document.getElementById('confirmOverlay').classList.remove('hidden');
  confirmCallback = onConfirm;
}
function closeConfirm(){
  document.getElementById('confirmOverlay').classList.add('hidden');
  confirmCallback = null;
}

/* ---------------------------------------------------------
   12. EVENT WIRING
   --------------------------------------------------------- */
function initEvents(){
  document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
  document.querySelectorAll('[data-view-link]').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.viewLink));
  });

  document.getElementById('openAddSong').addEventListener('click', openAddSongModal);
  document.getElementById('mobileAddBtn').addEventListener('click', openAddSongModal);
  document.getElementById('closeAddSong').addEventListener('click', closeAddSongModal);
  document.getElementById('cancelAddSong').addEventListener('click', closeAddSongModal);
  document.getElementById('submitAddSong').addEventListener('click', handleSubmitAddSong);
  document.getElementById('scanLocalBtn').addEventListener('click', scanLocalMusic);
  document.getElementById('rescanLocalBtn').addEventListener('click', scanLocalMusic);
  document.getElementById('modalScanLocalBtn').addEventListener('click', async()=>{ closeAddSongModal(); await scanLocalMusic(); switchView('local'); });
  document.getElementById('localFilesInput').addEventListener('change', async(e)=>{ await importLocalFiles(e.target.files); e.target.value=''; switchView('local'); });
  document.getElementById('addSongInput').addEventListener('keydown', (e) => { if(e.key === 'Enter') handleSubmitAddSong(); });
  document.getElementById('addSongOverlay').addEventListener('click', (e) => { if(e.target.id === 'addSongOverlay') closeAddSongModal(); });

  document.getElementById('confirmCancel').addEventListener('click', closeConfirm);
  document.getElementById('confirmOk').addEventListener('click', () => { confirmCallback?.(); closeConfirm(); });
  document.getElementById('confirmOverlay').addEventListener('click', (e) => { if(e.target.id === 'confirmOverlay') closeConfirm(); });

  // Playback controls (hero + bottom bar, mirrored)
  ['npcPlayPause','pbPlayPause'].forEach(id => document.getElementById(id).addEventListener('click', togglePlayPause));
  ['npcNext','pbNext'].forEach(id => document.getElementById(id).addEventListener('click', () => next(false)));
  ['npcPrev','pbPrev'].forEach(id => document.getElementById(id).addEventListener('click', prev));
  ['npcShuffle','pbShuffle'].forEach(id => document.getElementById(id).addEventListener('click', toggleShuffle));
  ['npcRepeat','pbRepeat','npRepeat'].forEach(id => document.getElementById(id)?.addEventListener('click', cycleRepeat));
  document.getElementById('npShuffle')?.addEventListener('click', toggleShuffle);
  document.getElementById('npPrev')?.addEventListener('click', prev);
  document.getElementById('npNext')?.addEventListener('click', () => next(false));
  document.getElementById('npPlayPause')?.addEventListener('click', togglePlayPause);
  document.getElementById('npHeart')?.addEventListener('click', () => { const s=getCurrentSong(); if(s){ isLocalSong(s)?toggleLocalFavorite(s.id):toggleFavorite(s.id); } });
  document.getElementById('npMute')?.addEventListener('click', toggleMute);
  document.getElementById('npQueue')?.addEventListener('click', () => switchView('queue'));
  document.getElementById('npBack')?.addEventListener('click', () => switchView('home'));
  setupSeekBar(document.getElementById('npSeekBar'));

  setupSeekBar(document.getElementById('npcSeekBar'));
  setupSeekBar(document.getElementById('pbSeekBar'));
  document.querySelector('.player-progress-track').addEventListener('click', (e) => seekToRatio(e.currentTarget, e.clientX));

  document.getElementById('pbHeart').addEventListener('click', () => {
    const song = getCurrentSong();
    if(song){ if(isLocalSong(song)) toggleLocalFavorite(song.id); else toggleFavorite(song.id); }
  });

  document.getElementById('pbMuteBtn').addEventListener('click', toggleMute);
  const volBar = document.getElementById('volBar');
  let volDragging = false;
  volBar.addEventListener('mousedown', (e) => { volDragging = true; setVolumeFromRatio(volBar, e.clientX); });
  window.addEventListener('mousemove', (e) => { if(volDragging) setVolumeFromRatio(volBar, e.clientX); });
  window.addEventListener('mouseup', () => volDragging = false);

  document.getElementById('pbQueueBtn').addEventListener('click', () => switchView('queue'));
  ['pbMetaOpen','pbThumb'].forEach(id => {
    const el=document.getElementById(id);
    el?.addEventListener('click', openNowPlaying);
    el?.addEventListener('keydown', e => { if(e.key==='Enter' || e.key===' '){ e.preventDefault(); openNowPlaying(); } });
  });
  document.getElementById('youtubeSort')?.addEventListener('change', e => { state.sort.youtube=e.target.value; persistSettings(); renderAll(); });
  document.getElementById('localSort')?.addEventListener('change', e => { state.sort.local=e.target.value; persistSettings(); renderAll(); });
  document.getElementById('clearQueueBtn').addEventListener('click', clearQueue);

  document.getElementById('topSearchInput').addEventListener('input', () => {
    applySearchFilter();
    if(document.getElementById('view-search').classList.contains('hidden')) switchView('search');
  });

  // mobile sidebar
  document.getElementById('hamburgerBtn').addEventListener('click', () => {
    document.getElementById('sidebar').classList.add('open');
    document.getElementById('sidebarScrim').classList.add('show');
  });
  document.getElementById('sidebarScrim').addEventListener('click', closeSidebarMobile);

  // keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if(['INPUT','TEXTAREA'].includes(document.activeElement.tagName)) return;
    if(e.code === 'Space'){ e.preventDefault(); togglePlayPause(); }
    if(e.code === 'ArrowRight' && e.shiftKey) next(false);
    if(e.code === 'ArrowLeft' && e.shiftKey) prev();
  });

  // ---- auth ----
  document.getElementById('authLoginForm').addEventListener('submit', handleLogin);
  document.getElementById('authSignupForm').addEventListener('submit', handleSignup);
  document.getElementById('showSignup').addEventListener('click', () => switchAuthForm('signup'));
  document.getElementById('showLogin').addEventListener('click', () => switchAuthForm('login'));
  document.getElementById('logoutBtn').addEventListener('click', handleLogout);

  // ---- connection retry ----
  document.getElementById('connRetryBtn').addEventListener('click', async () => {
    if(state.user) await loadCloudData();
  });
}

/* ---------------------------------------------------------
   13. INIT
   --------------------------------------------------------- */
async function init(){
  loadSettings();
  initEvents();
  updateVolumeUI();
  updateShuffleRepeatUI();
  checkDesktopSiteMode();
  await loadLocalLibrary();
  await initAuth();
}

// "Request desktop site" makes the browser report a fake wide
// viewport (usually ~980px), which media queries can't see through —
// the page really is laid out at that width, just visually shrunk to
// fit the screen. screen.width/height reflect the real hardware
// display and aren't affected by that toggle, so a mismatch is a
// reliable signal. Nudge the person to turn it off rather than
// silently rendering small/zoomed.
function checkDesktopSiteMode(){
  try{
    const physicallySmall = Math.min(window.screen.width, window.screen.height) < 560;
    const reportedWide = window.innerWidth > 880;
    if(!physicallySmall || !reportedWide) return;
    if(sessionStorage.getItem('dismissedDesktopModeNotice')) return;

    const bar = document.createElement('div');
    bar.className = 'desktop-mode-banner';
    bar.innerHTML = `
      <span>This looks like "Desktop site" mode on a phone — turn it off in your browser menu for the real mobile layout.</span>
      <button type="button" aria-label="Dismiss">&times;</button>
    `;
    bar.querySelector('button').addEventListener('click', () => {
      bar.remove();
      try{ sessionStorage.setItem('dismissedDesktopModeNotice', '1'); }catch(e){}
    });
    document.body.prepend(bar);
  }catch(e){ /* non-critical, fail silently */ }
}

document.addEventListener('DOMContentLoaded', init);
