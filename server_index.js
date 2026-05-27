// CRESCENT HUB — Server completo
// Spotify Festival + Autenticação CPF + Gestão de Funcionários

const express  = require('express');
const cors     = require('cors');
const axios    = require('axios');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3001;
app.use(cors());
app.use(express.json());

const supabase     = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const JWT_SECRET   = process.env.JWT_SECRET || 'crescent_secret';
const CLIENT_ID    = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET= process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || `http://localhost:${PORT}/callback`;
const SKIP_NEEDED  = parseInt(process.env.SKIP_VOTES_NEEDED) || 3;

const normCpf = (v) => String(v||'').replace(/\D/g,'');
const maskCpf = (v) => { const d=normCpf(v); return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/,'$1.$2.$3-$4'); };

// ── Auth middleware ──────────────────────────────────────
function requireAuth(req,res,next){
  const h=req.headers.authorization||'';
  const t=h.startsWith('Bearer ')?h.slice(7):null;
  if(!t) return res.status(401).json({error:'Token não fornecido'});
  try{ req.user=jwt.verify(t,JWT_SECRET); next(); }
  catch{ res.status(401).json({error:'Token inválido ou expirado'}); }
}
function requireAdmin(req,res,next){
  requireAuth(req,res,()=>{
    if(req.user.role!=='admin') return res.status(403).json({error:'Acesso restrito a administradores'});
    next();
  });
}

// ── Setup (primeiro admin) ────────────────────────────────
app.get('/api/auth/setup', async(req,res)=>{
  const {count}=await supabase.from('employees').select('id',{count:'exact',head:true});
  if(count>0) return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0f6fc"><div style="background:white;border-radius:20px;padding:40px;display:inline-block;box-shadow:0 4px 30px rgba(0,0,0,.1)"><div style="font-size:48px">✅</div><h2 style="color:#1A6FB5">Sistema já configurado</h2><p style="color:#666">Existem ${count} funcionário(s). Faça login normalmente.</p></div></body></html>`);
  res.send(`<html><head><meta charset="utf-8"><title>Setup</title></head><body style="margin:0;font-family:-apple-system,sans-serif;background:linear-gradient(135deg,#F0F6FC,#E8F3FB);min-height:100vh;display:flex;align-items:center;justify-content:center"><div style="background:white;border-radius:20px;padding:48px;width:360px;box-shadow:0 8px 40px rgba(0,0,0,.12)"><div style="font-size:40px;text-align:center">🚀</div><h2 style="color:#1A6FB5;text-align:center;margin:8px 0 6px">Crescent Hub</h2><p style="color:#666;text-align:center;margin:0 0 28px;font-size:14px">Criar primeiro administrador</p><form method="POST" action="/api/auth/setup"><label style="display:block;font-size:13px;font-weight:600;color:#3A5068;margin-bottom:5px">Nome completo</label><input name="name" required placeholder="Nicolas Andrade" style="width:100%;padding:11px 14px;border:1.5px solid #ddd;border-radius:10px;font-size:14px;margin-bottom:14px;box-sizing:border-box"/><label style="display:block;font-size:13px;font-weight:600;color:#3A5068;margin-bottom:5px">CPF (só números)</label><input name="cpf" required placeholder="12345678900" maxlength="11" style="width:100%;padding:11px 14px;border:1.5px solid #ddd;border-radius:10px;font-size:14px;margin-bottom:14px;box-sizing:border-box"/><p style="font-size:12px;color:#888;margin:0 0 20px">💡 A senha inicial será o próprio CPF.</p><button type="submit" style="width:100%;padding:13px;background:linear-gradient(135deg,#1A6FB5,#2E8DD4);color:white;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer">Criar Administrador</button></form></div></body></html>`);
});

app.post('/api/auth/setup', express.urlencoded({extended:true}), async(req,res)=>{
  const {count}=await supabase.from('employees').select('id',{count:'exact',head:true});
  if(count>0) return res.status(400).send('Sistema já configurado.');
  const name=(req.body.name||'').trim();
  const cpf=normCpf(req.body.cpf);
  if(!name||cpf.length!==11) return res.status(400).send('Nome e CPF de 11 dígitos obrigatórios.');
  const password_hash=await bcrypt.hash(cpf,10);
  const {error}=await supabase.from('employees').insert({name,cpf,password_hash,role:'admin'});
  if(error) return res.status(500).send('Erro: '+error.message);
  res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0f6fc"><div style="background:white;border-radius:20px;padding:40px;display:inline-block;box-shadow:0 4px 30px rgba(0,0,0,.1)"><div style="font-size:48px">✅</div><h2 style="color:#1A6FB5">Admin criado!</h2><p><strong>Nome:</strong> ${name}</p><p><strong>CPF:</strong> ${maskCpf(cpf)}</p><p><strong>Senha inicial:</strong> ${cpf}</p><p style="color:#888;font-size:13px">Feche e acesse o Crescent Hub.</p></div></body></html>`);
});

// ── Login / Me ────────────────────────────────────────────
app.post('/api/auth/login', async(req,res)=>{
  const {cpf:raw,password}=req.body;
  if(!raw||!password) return res.status(400).json({error:'CPF e senha obrigatórios'});
  const cpf=normCpf(raw);
  const {data:emp}=await supabase.from('employees').select('*').eq('cpf',cpf).eq('active',true).single();
  if(!emp) return res.status(401).json({error:'CPF não encontrado ou conta inativa'});
  const ok=await bcrypt.compare(password,emp.password_hash);
  if(!ok) return res.status(401).json({error:'Senha incorreta'});
  const token=jwt.sign({id:emp.id,name:emp.name,cpf:emp.cpf,role:emp.role},JWT_SECRET,{expiresIn:'10h'});
  console.log(`🔐 Login: ${emp.name} (${maskCpf(cpf)}) — ${emp.role}`);
  res.json({token,user:{id:emp.id,name:emp.name,cpf:emp.cpf,role:emp.role}});
});

app.get('/api/auth/me', requireAuth, (req,res)=>res.json({user:req.user}));

app.put('/api/auth/change-password', requireAuth, async(req,res)=>{
  const {currentPassword,newPassword}=req.body;
  if(!currentPassword||!newPassword) return res.status(400).json({error:'Preencha senha atual e nova'});
  const {data:emp}=await supabase.from('employees').select('password_hash').eq('id',req.user.id).single();
  if(!(await bcrypt.compare(currentPassword,emp.password_hash))) return res.status(401).json({error:'Senha atual incorreta'});
  await supabase.from('employees').update({password_hash:await bcrypt.hash(newPassword,10)}).eq('id',req.user.id);
  res.json({ok:true});
});

// ── CRUD Funcionários (admin only) ───────────────────────
app.get('/api/employees', requireAdmin, async(req,res)=>{
  const {data,error}=await supabase.from('employees').select('id,name,cpf,role,active,created_at,updated_at').order('name');
  if(error) return res.status(500).json({error:error.message});
  res.json({employees:data.map(e=>({...e,cpf:maskCpf(e.cpf)}))});
});

app.post('/api/employees', requireAdmin, async(req,res)=>{
  const {name:n,cpf:rc,role='employee',password}=req.body;
  const name=(n||'').trim(); const cpf=normCpf(rc);
  if(!name) return res.status(400).json({error:'Nome obrigatório'});
  if(cpf.length!==11) return res.status(400).json({error:'CPF deve ter 11 dígitos'});
  const pwd=normCpf(password||cpf);
  const password_hash=await bcrypt.hash(pwd,10);
  const {data,error}=await supabase.from('employees').insert({name,cpf,password_hash,role,active:true}).select('id,name,cpf,role,active,created_at').single();
  if(error){ if(error.code==='23505') return res.status(409).json({error:'CPF já cadastrado'}); return res.status(500).json({error:error.message}); }
  console.log(`➕ Criado: ${name} (${maskCpf(cpf)}) — ${role}`);
  res.json({employee:{...data,cpf:maskCpf(data.cpf)}});
});

app.put('/api/employees/:id', requireAdmin, async(req,res)=>{
  const {name,role,active}=req.body;
  const u={updated_at:new Date().toISOString()};
  if(name!==undefined) u.name=name.trim();
  if(role!==undefined) u.role=role;
  if(active!==undefined) u.active=active;
  const {data,error}=await supabase.from('employees').update(u).eq('id',req.params.id).select('id,name,cpf,role,active').single();
  if(error) return res.status(500).json({error:error.message});
  res.json({employee:{...data,cpf:maskCpf(data.cpf)}});
});

app.put('/api/employees/:id/password', requireAdmin, async(req,res)=>{
  const {password}=req.body;
  if(!password) return res.status(400).json({error:'Senha obrigatória'});
  const password_hash=await bcrypt.hash(normCpf(password)||password,10);
  const {error}=await supabase.from('employees').update({password_hash,updated_at:new Date().toISOString()}).eq('id',req.params.id);
  if(error) return res.status(500).json({error:error.message});
  res.json({ok:true});
});

// ── Spotify ───────────────────────────────────────────────
let tokens={access:null,refresh:null,expiresAt:0};
app.get('/login',(req,res)=>{
  const scope='user-read-playback-state user-modify-playback-state user-read-currently-playing';
  const p=new URLSearchParams({response_type:'code',client_id:CLIENT_ID,scope,redirect_uri:REDIRECT_URI,state:Math.random().toString(36).slice(2)});
  res.redirect(`https://accounts.spotify.com/authorize?${p}`);
});
app.get('/callback',async(req,res)=>{
  const {code,error}=req.query;
  if(error) return res.status(400).send('Erro: '+error);
  try{
    const r=await axios.post('https://accounts.spotify.com/api/token',new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:REDIRECT_URI}),{headers:{Authorization:`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,'Content-Type':'application/x-www-form-urlencoded'}});
    const {access_token,refresh_token,expires_in}=r.data;
    tokens={access:access_token,refresh:refresh_token,expiresAt:Date.now()+(expires_in-60)*1000};
    await supabase.from('settings').upsert({key:'spotify_refresh_token',value:refresh_token});
    res.send('<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0f6fc"><div style="background:white;border-radius:20px;padding:40px;display:inline-block;box-shadow:0 4px 30px rgba(0,0,0,.1)"><div style="font-size:48px">🎵</div><h2 style="color:#1A6FB5">Spotify conectado!</h2><p style="color:#666">Feche e volte ao Crescent Hub.</p></div></body></html>');
  }catch(e){console.error('❌ Callback:',e.response?.data||e.message);res.status(500).send('Erro ao autenticar.');}
});
async function ensureToken(){
  if(!tokens.refresh){const{data}=await supabase.from('settings').select('value').eq('key','spotify_refresh_token').single();if(data?.value)tokens.refresh=data.value;else throw new Error('Spotify não autenticado.');}
  if(!tokens.access||Date.now()>=tokens.expiresAt){
    const r=await axios.post('https://accounts.spotify.com/api/token',new URLSearchParams({grant_type:'refresh_token',refresh_token:tokens.refresh}),{headers:{Authorization:`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,'Content-Type':'application/x-www-form-urlencoded'}});
    tokens.access=r.data.access_token;tokens.expiresAt=Date.now()+(r.data.expires_in-60)*1000;
    if(r.data.refresh_token){tokens.refresh=r.data.refresh_token;await supabase.from('settings').upsert({key:'spotify_refresh_token',value:tokens.refresh});}
  }
  return tokens.access;
}
async function spotify(method,path,data){const t=await ensureToken();return axios({method,url:`https://api.spotify.com/v1${path}`,headers:{Authorization:`Bearer ${t}`,'Content-Type':'application/json'},data:data||undefined});}

app.get('/api/status',async(req,res)=>{try{const r=await spotify('get','/me');res.json({ok:true,user:r.data.display_name});}catch{res.json({ok:false});}});
app.get('/api/search',async(req,res)=>{const{q}=req.query;if(!q?.trim())return res.status(400).json({error:'Query vazia'});try{const r=await spotify('get',`/search?q=${encodeURIComponent(q)}&type=track&limit=8&market=BR`);res.json({tracks:r.data.tracks.items.map(t=>({id:t.id,uri:t.uri,title:t.name,artist:t.artists.map(a=>a.name).join(', '),album_art:t.album.images[1]?.url||t.album.images[0]?.url||null,duration_ms:t.duration_ms,duration_str:`${Math.floor(t.duration_ms/60000)}:${String(Math.floor((t.duration_ms%60000)/1000)).padStart(2,'0')}`}))});}catch{res.status(500).json({error:'Erro na busca'});}});
app.post('/api/queue',async(req,res)=>{const{uri,spotify_id,title,artist,album_art,requested_by,duration_ms,duration_str}=req.body;if(!uri||!title||!requested_by)return res.status(400).json({error:'Dados incompletos'});const{data:max}=await supabase.from('queue').select('position').in('status',['pending','playing']).order('position',{ascending:false}).limit(1);const position=(max?.[0]?.position??-1)+1;const{data,error}=await supabase.from('queue').insert({spotify_uri:uri,spotify_id,title,artist,album_art,requested_by,duration_ms,duration_str,position,status:'pending'}).select().single();if(error)return res.status(500).json({error:error.message});res.json({song:data});});
app.delete('/api/queue/:id',async(req,res)=>{await supabase.from('queue').update({status:'removed'}).eq('id',req.params.id);res.json({ok:true});});
app.post('/api/player/play',async(req,res)=>{try{const n=await getNextSong();if(!n)return res.status(404).json({error:'Fila vazia'});await startPlaying(n);res.json({ok:true,song:n});}catch(e){res.status(500).json({error:e.response?.data?.error?.message||'Erro'});}});
app.post('/api/player/pause',async(req,res)=>{try{await spotify('put','/me/player/pause');await supabase.from('player_state').upsert({id:1,is_playing:false,updated_at:new Date().toISOString()});res.json({ok:true});}catch(e){res.status(500).json({error:e.response?.data?.error?.message||'Erro'});}});
app.post('/api/player/resume',async(req,res)=>{try{await spotify('put','/me/player/play');await supabase.from('player_state').upsert({id:1,is_playing:true,updated_at:new Date().toISOString()});res.json({ok:true});}catch(e){res.status(500).json({error:e.response?.data?.error?.message||'Erro'});}});
app.post('/api/player/next',async(req,res)=>{try{await advanceQueue('manual_skip');res.json({ok:true});}catch{res.status(500).json({error:'Erro'});}});
app.post('/api/vote/skip',async(req,res)=>{const{user_id,song_id}=req.body;if(!user_id||!song_id)return res.status(400).json({error:'Dados incompletos'});const{data:ex}=await supabase.from('skip_votes').select('id').eq('song_id',song_id).eq('user_id',user_id).single();if(ex)return res.status(409).json({error:'Você já votou'});await supabase.from('skip_votes').insert({song_id,user_id});const{count}=await supabase.from('skip_votes').select('id',{count:'exact',head:true}).eq('song_id',song_id);if(count>=SKIP_NEEDED){await advanceQueue('vote_skip');return res.json({ok:true,skipped:true,votes:count,needed:SKIP_NEEDED});}res.json({ok:true,skipped:false,votes:count,needed:SKIP_NEEDED});});
app.get('/api/devices',async(req,res)=>{try{const r=await spotify('get','/me/player/devices');res.json({devices:r.data.devices});}catch{res.status(500).json({error:'Erro'});}});
app.post('/api/devices/select',async(req,res)=>{try{await spotify('put','/me/player',{device_ids:[req.body.device_id],play:false});await supabase.from('settings').upsert({key:'device_id',value:req.body.device_id});res.json({ok:true});}catch{res.status(500).json({error:'Erro'});}});

async function getNextSong(){const{data}=await supabase.from('queue').select('*').eq('status','pending').order('position',{ascending:true}).limit(1);return data?.[0]||null;}
async function startPlaying(song){await supabase.from('queue').update({status:'played'}).eq('status','playing');const{data:dev}=await supabase.from('settings').select('value').eq('key','device_id').single();const body={uris:[song.spotify_uri]};if(dev?.value)body.device_id=dev.value;await spotify('put','/me/player/play',body);await supabase.from('queue').update({status:'playing'}).eq('id',song.id);await supabase.from('player_state').upsert({id:1,is_playing:true,current_song_id:song.id,current_spotify_id:song.spotify_id,updated_at:new Date().toISOString()});await supabase.from('skip_votes').delete().eq('song_id',song.id);console.log(`▶️  ${song.title} — ${song.artist}`);}
async function advanceQueue(r='auto'){const{data:s}=await supabase.from('player_state').select('current_song_id').eq('id',1).single();if(s?.current_song_id)await supabase.from('queue').update({status:r==='vote_skip'?'skipped':'played'}).eq('id',s.current_song_id);const n=await getNextSong();if(!n){await supabase.from('player_state').upsert({id:1,is_playing:false,current_song_id:null,current_spotify_id:null,updated_at:new Date().toISOString()});return;}await startPlaying(n);}
let lastSid=null,nearEnd=false;
async function monitorPlayback(){try{const r=await spotify('get','/me/player/currently-playing');if(r.status===204||!r.data?.item){lastSid=null;nearEnd=false;return;}const{item,progress_ms,is_playing}=r.data;if(!is_playing)return;const id=item.id;const rem=item.duration_ms-progress_ms;const{data:st}=await supabase.from('player_state').select('current_spotify_id').eq('id',1).single();if(lastSid&&lastSid!==id&&st?.current_spotify_id===lastSid)await advanceQueue('auto');lastSid=id;if(rem<8000&&rem>500&&!nearEnd&&st?.current_spotify_id===id)nearEnd=true;if(rem>15000)nearEnd=false;}catch(e){const s=e.response?.status;if(s&&[401,404,429].includes(s))return;console.error('⚠️  Monitor:',e.response?.data?.error?.message||e.message);}}
setInterval(monitorPlayback,4000);

app.listen(PORT,()=>{console.log(`\n🚀  Crescent Hub Server\n    http://localhost:${PORT}\n    Setup: http://localhost:${PORT}/api/auth/setup\n    Spotify: http://localhost:${PORT}/login\n`);});
