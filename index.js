// ════════════════════════════════════════════════════════
// CRESCENT HUB — Server completo
// Spotify + Auth + Alexa TTS + Lembretes programados
// ════════════════════════════════════════════════════════

const express  = require('express');
const cors     = require('cors');
const axios    = require('axios');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const cron     = require('node-cron');
const AlexaRemote = require('alexa-remote2');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3001;
app.use(cors());
app.use(express.json());

// ─── Supabase ────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ─── Auth config ─────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'crescent_secret';

const normCpf = (v) => String(v || '').replace(/\D/g, '');
const maskCpf = (v) => {
  const d = normCpf(v);
  return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
};

// ════════════════════════════════════════════════════════
// ALEXA REMOTE — TTS e anúncios no Echo Dot
// ════════════════════════════════════════════════════════

const SOUNDS = {
  fanfarra:    'soundbank://soundlibrary/musical/amzn_sfx_trumpet_fanfare_01',
  campainha:   'soundbank://soundlibrary/home/amzn_sfx_doorbell_01',
  aplauso:     'soundbank://soundlibrary/human/amzn_sfx_crowd_applause_01',
  corneta:     'soundbank://soundlibrary/musical/amzn_sfx_horn_01',
  notificacao: 'soundbank://soundlibrary/computers/amzn_sfx_ui_notification_01',
};

let alexa        = null;
let alexaOk      = false;
let alexaDevices = [];

function initAlexa() {
  if (!process.env.AMAZON_EMAIL || !process.env.AMAZON_PASSWORD) {
    console.log('⚠️  Alexa: configure AMAZON_EMAIL e AMAZON_PASSWORD no .env do Render');
    return;
  }
  alexa = new AlexaRemote();
  alexa.init({
    email:            process.env.AMAZON_EMAIL,
    password:         process.env.AMAZON_PASSWORD,
    alexaServiceHost: 'alexa.amazon.com',
    listeningPort:    0,
    useWsMqtt:        false,
    logger:           false,
  }, (err) => {
    if (err) { console.error('❌ Alexa init:', err.message); return; }
    alexaOk = true;
    console.log('🔊 Alexa Remote conectada!');
    alexa.getDevices((e, data) => {
      if (!e && data?.devices) {
        alexaDevices = data.devices;
        console.log(`🔊 ${alexaDevices.length} dispositivo(s) Alexa encontrado(s):`);
        alexaDevices.forEach(d => console.log(`   • ${d.accountName} (${d.deviceFamily})`));
      }
    });
  });
}
initAlexa();

async function speakOnAlexa(text, opts = {}) {
  if (!alexa || !alexaOk) throw new Error('Alexa não inicializada. Configure AMAZON_EMAIL e AMAZON_PASSWORD no Render.');
  const serial = opts.device
    || process.env.ALEXA_DEVICE_SERIAL
    || alexaDevices.find(d => d.deviceFamily?.toLowerCase().includes('echo'))?.serialNumber;
  if (!serial) throw new Error('Nenhum dispositivo Echo encontrado. Configure ALEXA_DEVICE_SERIAL no Render.');
  const soundTag = opts.sound && SOUNDS[opts.sound] ? `<audio src="${SOUNDS[opts.sound]}"/><break time="800ms"/>` : '';
  const ssml = `<speak>${soundTag}${text}</speak>`;
  return new Promise((resolve, reject) => {
    alexa.sendSequenceCommand(serial, 'speak', ssml, (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

// ── Cron: verifica lembretes a cada minuto (horário de Brasília) ──
cron.schedule('* * * * *', async () => {
  try {
    const brt   = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const hhmm  = `${String(brt.getHours()).padStart(2,'0')}:${String(brt.getMinutes()).padStart(2,'0')}`;
    const today = brt.toISOString().split('T')[0];
    const { data: reminders } = await supabase
      .from('reminders').select('*').eq('active', true).eq('time', hhmm).neq('last_triggered', today);
    for (const r of (reminders || [])) {
      const rDate = r.date ? new Date(r.date + 'T12:00:00') : null;
      const shouldFire =
        r.repeat === 'daily' ||
        (r.repeat === 'weekly'  && rDate && rDate.getDay()  === brt.getDay()) ||
        (r.repeat === 'monthly' && rDate && rDate.getDate() === brt.getDate()) ||
        (r.repeat === 'never'   && r.date === today);
      if (!shouldFire) continue;
      console.log(`🔔 "${r.title}" — ${hhmm} — disparando Alexa...`);
      try {
        await speakOnAlexa(r.message || r.title, { sound: r.sound, device: r.alexa_device });
        await supabase.from('reminders').update({ last_triggered: today }).eq('id', r.id);
        console.log(`✅ Alexa anunciou: "${r.title}"`);
      } catch (e) { console.error(`❌ Falha ao anunciar "${r.title}":`, e.message); }
    }
  } catch (e) { console.error('⚠️  Cron:', e.message); }
});
console.log('⏰ Cron de lembretes iniciado (verifica a cada minuto)');

// ── Middlewares de autenticação ───────────────────────────
function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!t) return res.status(401).json({ error: 'Token não fornecido' });
  try { req.user = jwt.verify(t, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token inválido ou expirado' }); }
}
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Acesso restrito a administradores' });
    next();
  });
}

// ═══════════════════════════════════════════════════════
// SETUP — Cria o primeiro admin (só funciona se DB vazio)
// ═══════════════════════════════════════════════════════

app.get('/api/auth/setup', async (req, res) => {
  const { count } = await supabase.from('employees').select('id', { count: 'exact', head: true });
  if (count > 0) return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0f6fc"><div style="background:white;border-radius:20px;padding:40px;display:inline-block;box-shadow:0 4px 30px rgba(0,0,0,.1)"><div style="font-size:48px">✅</div><h2 style="color:#1A6FB5">Sistema já configurado</h2><p style="color:#666">Existem ${count} funcionário(s). Faça login normalmente.</p></div></body></html>`);
  res.send(`<html><head><meta charset="utf-8"><title>Setup</title></head><body style="margin:0;font-family:-apple-system,sans-serif;background:linear-gradient(135deg,#F0F6FC,#E8F3FB);min-height:100vh;display:flex;align-items:center;justify-content:center"><div style="background:white;border-radius:20px;padding:48px;width:360px;box-shadow:0 8px 40px rgba(0,0,0,.12)"><div style="font-size:40px;text-align:center">🚀</div><h2 style="color:#1A6FB5;text-align:center;margin:8px 0 6px">Crescent Hub</h2><p style="color:#666;text-align:center;margin:0 0 28px;font-size:14px">Criar primeiro administrador</p><form method="POST" action="/api/auth/setup"><label style="display:block;font-size:13px;font-weight:600;color:#3A5068;margin-bottom:5px">Nome completo</label><input name="name" required placeholder="Nicolas Andrade" style="width:100%;padding:11px 14px;border:1.5px solid #ddd;border-radius:10px;font-size:14px;margin-bottom:14px;box-sizing:border-box"/><label style="display:block;font-size:13px;font-weight:600;color:#3A5068;margin-bottom:5px">CPF (só números)</label><input name="cpf" required placeholder="12345678900" maxlength="11" style="width:100%;padding:11px 14px;border:1.5px solid #ddd;border-radius:10px;font-size:14px;margin-bottom:14px;box-sizing:border-box"/><p style="font-size:12px;color:#888;margin:0 0 20px">💡 A senha inicial será o próprio CPF.</p><button type="submit" style="width:100%;padding:13px;background:linear-gradient(135deg,#1A6FB5,#2E8DD4);color:white;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer">Criar Administrador</button></form></div></body></html>`);
});

app.post('/api/auth/setup', express.urlencoded({ extended: true }), async (req, res) => {
  const { count } = await supabase.from('employees').select('id', { count: 'exact', head: true });
  if (count > 0) return res.status(400).send('Sistema já configurado.');
  const name = (req.body.name || '').trim();
  const cpf  = normCpf(req.body.cpf);
  if (!name || cpf.length !== 11) return res.status(400).send('Nome e CPF de 11 dígitos obrigatórios.');
  const password_hash = await bcrypt.hash(cpf, 10);
  const { error } = await supabase.from('employees').insert({ name, cpf, password_hash, role: 'admin' });
  if (error) return res.status(500).send('Erro: ' + error.message);
  res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#f0f6fc"><div style="background:white;border-radius:20px;padding:40px;display:inline-block;box-shadow:0 4px 30px rgba(0,0,0,.1)"><div style="font-size:48px">✅</div><h2 style="color:#1A6FB5">Admin criado!</h2><p><strong>Nome:</strong> ${name}</p><p><strong>CPF:</strong> ${maskCpf(cpf)}</p><p><strong>Senha inicial:</strong> ${cpf}</p><p style="color:#888;font-size:13px">Feche e acesse o Crescent Hub.</p></div></body></html>`);
});

// ═══════════════════════════════════════════════════════
// AUTH — Login / Perfil / Trocar senha
// ═══════════════════════════════════════════════════════

app.post('/api/auth/login', async (req, res) => {
  const { cpf: raw, password } = req.body;
  if (!raw || !password) return res.status(400).json({ error: 'CPF e senha obrigatórios' });
  const cpf = normCpf(raw);
  const { data: emp } = await supabase.from('employees').select('*').eq('cpf', cpf).eq('active', true).single();
  if (!emp) return res.status(401).json({ error: 'CPF não encontrado ou conta inativa' });
  const ok = await bcrypt.compare(password, emp.password_hash);
  if (!ok) return res.status(401).json({ error: 'Senha incorreta' });
  const token = jwt.sign({ id: emp.id, name: emp.name, cpf: emp.cpf, role: emp.role }, JWT_SECRET, { expiresIn: '10h' });
  console.log(`🔐 Login: ${emp.name} (${maskCpf(cpf)}) — ${emp.role}`);
  res.json({ token, user: { id: emp.id, name: emp.name, cpf: emp.cpf, role: emp.role } });
});

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: req.user }));

// Perfil completo do usuário logado (campos extras: salário, endereço, etc.)
app.get('/api/auth/profile', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('employees').select('*').eq('id', req.user.id).single();
  if (error) return res.status(500).json({ error: error.message });
  const { password_hash, ...safe } = data;
  res.json({ profile: { ...safe, cpf: maskCpf(safe.cpf) } });
});

app.put('/api/auth/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Preencha senha atual e nova' });
  const { data: emp } = await supabase.from('employees').select('password_hash').eq('id', req.user.id).single();
  if (!(await bcrypt.compare(currentPassword, emp.password_hash))) return res.status(401).json({ error: 'Senha atual incorreta' });
  await supabase.from('employees').update({ password_hash: await bcrypt.hash(newPassword, 10) }).eq('id', req.user.id);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════
// FUNCIONÁRIOS — CRUD (admin only)
// ═══════════════════════════════════════════════════════

app.get('/api/employees', requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from('employees').select('id,name,cpf,role,active,created_at,updated_at').order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ employees: data.map(e => ({ ...e, cpf: maskCpf(e.cpf) })) });
});

app.post('/api/employees', requireAdmin, async (req, res) => {
  const { name: n, cpf: rc, role = 'employee', password } = req.body;
  const name = (n || '').trim();
  const cpf  = normCpf(rc);
  if (!name)             return res.status(400).json({ error: 'Nome obrigatório' });
  if (cpf.length !== 11) return res.status(400).json({ error: 'CPF deve ter 11 dígitos' });
  const password_hash = await bcrypt.hash(normCpf(password || cpf), 10);
  const { data, error } = await supabase.from('employees').insert({ name, cpf, password_hash, role, active: true }).select('id,name,cpf,role,active,created_at').single();
  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'CPF já cadastrado' });
    return res.status(500).json({ error: error.message });
  }
  console.log(`➕ Criado: ${name} (${maskCpf(cpf)}) — ${role}`);
  res.json({ employee: { ...data, cpf: maskCpf(data.cpf) } });
});

app.put('/api/employees/:id', requireAdmin, async (req, res) => {
  const { name, role, active } = req.body;
  const u = { updated_at: new Date().toISOString() };
  if (name   !== undefined) u.name   = name.trim();
  if (role   !== undefined) u.role   = role;
  if (active !== undefined) u.active = active;
  const { data, error } = await supabase.from('employees').update(u).eq('id', req.params.id).select('id,name,cpf,role,active').single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ employee: { ...data, cpf: maskCpf(data.cpf) } });
});

app.put('/api/employees/:id/password', requireAdmin, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Senha obrigatória' });
  const password_hash = await bcrypt.hash(normCpf(password) || password, 10);
  const { error } = await supabase.from('employees').update({ password_hash, updated_at: new Date().toISOString() }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Histórico salarial do usuário logado
app.get('/api/auth/salary-history', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('salary_history')
    .select('*')
    .eq('employee_id', req.user.id)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ history: data || [] });
});

// Histórico salarial de um funcionário (admin)
app.get('/api/employees/:id/salary-history', requireAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('salary_history').select('*').eq('employee_id', req.params.id)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ history: data || [] });
});

// Adicionar registro manual de histórico salarial
app.post('/api/employees/:id/salary-history', requireAdmin, async (req, res) => {
  const { salary, event, date } = req.body;
  if (!salary) return res.status(400).json({ error: 'Salário obrigatório' });
  const months = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
  const now = new Date();
  const dateStr = date || `${months[now.getMonth()]}/${String(now.getFullYear()).slice(2)}`;
  const { data, error } = await supabase.from('salary_history').insert({
    employee_id: req.params.id,
    date: dateStr, salary: Number(salary),
    event: event || 'Atualização de salário',
    created_by: req.user.name,
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ record: data });
});

// Buscar perfil completo de um funcionário (admin)
app.get('/api/employees/:id', requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from('employees').select('*').eq('id', req.params.id).single();
  if (error) return res.status(500).json({ error: error.message });
  const { password_hash, ...safe } = data;
  res.json({ employee: { ...safe, cpf: maskCpf(safe.cpf) } });
});

// Atualizar perfil completo (admin pode editar todos os campos)
app.put('/api/employees/:id/profile', requireAdmin, async (req, res) => {
  const allowed = ['name','role','active','rg','birth_date','email','phone','street','district',
    'city','state','cep','category','cargo','admission','salary','inss','ir','vt','va','dependents'];
  const u = { updated_at: new Date().toISOString() };
  allowed.forEach(k => { if (req.body[k] !== undefined) u[k] = req.body[k]; });

  // Se o salário mudou, registra no histórico
  if (req.body.salary !== undefined) {
    const { data: old } = await supabase.from('employees').select('salary').eq('id', req.params.id).single();
    const oldSalary = Number(old?.salary) || 0;
    const newSalary = Number(req.body.salary);
    if (newSalary > 0 && newSalary !== oldSalary) {
      const months = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
      const now = new Date();
      const dateStr = `${months[now.getMonth()]}/${String(now.getFullYear()).slice(2)}`;
      const pct = oldSalary > 0
        ? `${newSalary > oldSalary ? '+' : ''}${(((newSalary - oldSalary) / oldSalary) * 100).toFixed(1)}%`
        : null;
      await supabase.from('salary_history').insert({
        employee_id: req.params.id,
        date: dateStr,
        salary: newSalary,
        pct,
        event: req.body.salary_event || (oldSalary === 0 ? 'Admissão' : 'Atualização salarial'),
        created_by: req.user.name,
      });
    }
  }

  const { data, error } = await supabase.from('employees').update(u).eq('id', req.params.id).select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  const { password_hash, ...safe } = data;
  res.json({ employee: { ...safe, cpf: maskCpf(safe.cpf) } });
});

// ════════════════════════════════════════════════════════
// CALENDÁRIO DE EVENTOS
// ════════════════════════════════════════════════════════

app.get('/api/events', async (req, res) => {
  const { data, error } = await supabase
    .from('calendar_events').select('*').order('event_date', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ events: data });
});

app.post('/api/events', requireAdmin, async (req, res) => {
  const { title, event_date, event_time, type, description } = req.body;
  if (!title || !event_date) return res.status(400).json({ error: 'Título e data obrigatórios' });
  const auth = req.user;
  const { data, error } = await supabase.from('calendar_events')
    .insert({ title, event_date, event_time: event_time||'Dia todo', type: type||'Evento', description, created_by: auth.name })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  console.log(`📅 Evento criado: ${title} em ${event_date}`);
  res.json({ event: data });
});

app.put('/api/events/:id', requireAdmin, async (req, res) => {
  const { title, event_date, event_time, type, description } = req.body;
  const u = { updated_at: new Date().toISOString() };
  if (title       !== undefined) u.title       = title;
  if (event_date  !== undefined) u.event_date  = event_date;
  if (event_time  !== undefined) u.event_time  = event_time;
  if (type        !== undefined) u.type        = type;
  if (description !== undefined) u.description = description;
  const { data, error } = await supabase.from('calendar_events').update(u).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ event: data });
});

app.delete('/api/events/:id', requireAdmin, async (req, res) => {
  const { error } = await supabase.from('calendar_events').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ─── Spotify config ──────────────────────────────────────
const CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI  = process.env.REDIRECT_URI || `http://localhost:${PORT}/callback`;
const SKIP_NEEDED   = parseInt(process.env.SKIP_VOTES_NEEDED) || 4;

// Token em memória (persiste refresh_token no Supabase para sobreviver restarts)
let tokens = { access: null, refresh: null, expiresAt: 0 };

// ═══════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════
// ALEXA — Endpoints
// ════════════════════════════════════════════════════════

app.get('/api/alexa/status', (req, res) => {
  res.json({ ok: alexaOk, configured: !!(process.env.AMAZON_EMAIL && process.env.AMAZON_PASSWORD) });
});

app.get('/api/alexa/devices', requireAuth, (req, res) => {
  if (!alexaOk) return res.json({ ok: false, devices: [], msg: 'Alexa não configurada' });
  alexa.getDevices((err, data) => {
    if (err) return res.json({ ok: false, devices: [], msg: err.message });
    alexaDevices = data?.devices || [];
    res.json({ ok: true, devices: alexaDevices.map(d => ({ serial: d.serialNumber, name: d.accountName, type: d.deviceFamily })) });
  });
});

// Testar anúncio imediatamente (admin)
app.post('/api/alexa/speak', requireAdmin, async (req, res) => {
  const { text, sound, device } = req.body;
  if (!text) return res.status(400).json({ error: 'Texto obrigatório' });
  try {
    await speakOnAlexa(text, { sound, device });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Proxy de imagem — resolve CORS para extração de cores via Canvas
app.get('/api/image-proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('URL required');
  try {
    const r = await axios.get(decodeURIComponent(url), { responseType: 'stream' });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', r.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    r.data.pipe(res);
  } catch { res.status(500).send('proxy error'); }
});

// SPOTIFY AUTH
// ═══════════════════════════════════════════════════════

app.get('/login', (req, res) => {
  const scope = [
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-read-currently-playing',
  ].join(' ');

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     CLIENT_ID,
    scope,
    redirect_uri:  REDIRECT_URI,
    state: Math.random().toString(36).slice(2),
  });

  res.redirect(`https://accounts.spotify.com/authorize?${params}`);
});

app.get('/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send(`Erro Spotify: ${error}`);

  try {
    const r = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
      { headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, refresh_token, expires_in } = r.data;
    tokens = { access: access_token, refresh: refresh_token, expiresAt: Date.now() + (expires_in - 60) * 1000 };

    // Persiste para sobreviver restart
    await supabase.from('settings').upsert({ key: 'spotify_refresh_token', value: refresh_token });

    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Conectado</title></head>
<body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  background:linear-gradient(135deg,#F0F6FC,#E8F3FB);min-height:100vh;
  display:flex;align-items:center;justify-content:center">
  <div style="background:white;border-radius:20px;padding:48px;text-align:center;
    box-shadow:0 8px 40px rgba(0,0,0,0.12);max-width:400px">
    <div style="font-size:56px;margin-bottom:16px">🎵</div>
    <h2 style="color:#1A6FB5;margin:0 0 10px;font-size:22px">Spotify conectado!</h2>
    <p style="color:#666;margin:0">Pode fechar essa janela e voltar ao Crescent Hub.</p>
  </div>
</body></html>`);
  } catch (err) {
    console.error('❌ Callback error:', err.response?.data || err.message);
    res.status(500).send('Erro ao autenticar no Spotify. Tente novamente.');
  }
});

function basicAuth() {
  return `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;
}

async function ensureToken() {
  // Carrega refresh token salvo se não tiver em memória
  if (!tokens.refresh) {
    const { data } = await supabase.from('settings').select('value').eq('key', 'spotify_refresh_token').single();
    if (data?.value) tokens.refresh = data.value;
    else throw new Error('Spotify não autenticado. Acesse /login primeiro.');
  }

  if (!tokens.access || Date.now() >= tokens.expiresAt) {
    const r = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh }),
      { headers: { Authorization: basicAuth(), 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    tokens.access     = r.data.access_token;
    tokens.expiresAt  = Date.now() + (r.data.expires_in - 60) * 1000;
    if (r.data.refresh_token) {
      tokens.refresh = r.data.refresh_token;
      await supabase.from('settings').upsert({ key: 'spotify_refresh_token', value: tokens.refresh });
    }
  }
  return tokens.access;
}

// Wrapper para chamadas à Spotify Web API
async function spotify(method, path, data) {
  const token = await ensureToken();
  return axios({
    method,
    url:     `https://api.spotify.com/v1${path}`,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data:    data || undefined,
  });
}

// ═══════════════════════════════════════════════════════
// STATUS
// ═══════════════════════════════════════════════════════

app.get('/api/status', async (req, res) => {
  try {
    const r = await spotify('get', '/me');
    res.json({ ok: true, user: r.data.display_name, email: r.data.email });
  } catch {
    res.json({ ok: false });
  }
});

// ═══════════════════════════════════════════════════════
// BUSCA DE MÚSICAS
// ═══════════════════════════════════════════════════════

app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  if (!q?.trim()) return res.status(400).json({ error: 'Query vazia' });

  try {
    const r = await spotify('get', `/search?q=${encodeURIComponent(q)}&type=track&limit=8&market=BR`);
    const tracks = r.data.tracks.items.map(t => ({
      id:           t.id,
      uri:          t.uri,
      title:        t.name,
      artist:       t.artists.map(a => a.name).join(', '),
      album:        t.album.name,
      album_art:    t.album.images[1]?.url || t.album.images[0]?.url || null,
      duration_ms:  t.duration_ms,
      duration_str: `${Math.floor(t.duration_ms / 60000)}:${String(Math.floor((t.duration_ms % 60000) / 1000)).padStart(2, '0')}`,
    }));
    res.json({ tracks });
  } catch (err) {
    console.error('❌ Search:', err.response?.data || err.message);
    res.status(500).json({ error: 'Erro na busca. Spotify autenticado?' });
  }
});

// ═══════════════════════════════════════════════════════
// FILA (QUEUE)
// ═══════════════════════════════════════════════════════

app.post('/api/queue', async (req, res) => {
  const { uri, spotify_id, title, artist, album_art, requested_by, duration_ms, duration_str } = req.body;
  if (!uri || !title || !requested_by) return res.status(400).json({ error: 'Dados incompletos' });

  // Próxima posição
  const { data: max } = await supabase
    .from('queue').select('position')
    .in('status', ['pending', 'playing'])
    .order('position', { ascending: false }).limit(1);
  const position = (max?.[0]?.position ?? -1) + 1;

  const { data, error } = await supabase.from('queue').insert({
    spotify_uri: uri, spotify_id, title, artist, album_art,
    requested_by, duration_ms, duration_str, position, status: 'pending',
  }).select().single();

  if (error) return res.status(500).json({ error: error.message });
  console.log(`➕ Queue: ${title} por ${requested_by} (pos ${position})`);

  // ── Auto-start: dispara sempre que a fila estava vazia ──────
  // Verifica se esta é a única música pendente (fila estava vazia antes)
  try {
    const { count: pendingCount } = await supabase
      .from('queue').select('id', { count: 'exact', head: true }).eq('status', 'pending');

    if (pendingCount === 1) {
      // Fila estava vazia — verifica se o player está parado
      const { data: playerState } = await supabase
        .from('player_state').select('is_playing, current_song_id').eq('id', 1).single();

      const somethingPlaying = playerState?.is_playing && playerState?.current_song_id;

      if (!somethingPlaying) {
        // Auto-seleciona dispositivo se nenhum estiver salvo
        const { data: devSetting } = await supabase
          .from('settings').select('value').eq('key', 'device_id').single();

        if (!devSetting?.value) {
          const devR = await spotify('get', '/me/player/devices').catch(() => null);
          const devices = devR?.data?.devices || [];
          if (devices.length > 0) {
            await supabase.from('settings').upsert({ key: 'device_id', value: devices[0].id });
            console.log(`🔊 Dispositivo auto-selecionado: ${devices[0].name}`);
          }
        }

        await startPlaying(data);
        console.log(`▶️  Auto-start: "${title}" — fila estava vazia`);
      }
    }
  } catch (err) {
    // Não falha o request — música fica na fila para play manual
    console.error('⚠️  Auto-start falhou:', err.response?.data?.error?.message || err.message);
  }

  res.json({ song: data });
});

app.delete('/api/queue/:id', async (req, res) => {
  const { error } = await supabase.from('queue').update({ status: 'removed' }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════
// CONTROLES DO PLAYER
// ═══════════════════════════════════════════════════════

// Começa a tocar a primeira música da fila
app.post('/api/player/play', async (req, res) => {
  try {
    const next = await getNextSong();
    if (!next) return res.status(404).json({ error: 'Fila vazia' });
    await startPlaying(next);
    res.json({ ok: true, song: next });
  } catch (err) {
    console.error('❌ Play:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error?.message || 'Erro ao tocar' });
  }
});

// Pausa
app.post('/api/player/pause', async (req, res) => {
  try {
    await spotify('put', '/me/player/pause');
    await supabase.from('player_state').upsert({ id: 1, is_playing: false, updated_at: new Date().toISOString() });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error?.message || 'Erro ao pausar' });
  }
});

// Retoma
app.post('/api/player/resume', async (req, res) => {
  try {
    await spotify('put', '/me/player/play');
    await supabase.from('player_state').upsert({ id: 1, is_playing: true, updated_at: new Date().toISOString() });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error?.message || 'Erro ao retomar' });
  }
});

// Pula para a próxima (manual)
app.post('/api/player/next', async (req, res) => {
  try {
    await advanceQueue('manual_skip');
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ Next:', err.message);
    res.status(500).json({ error: 'Erro ao pular' });
  }
});

// ═══════════════════════════════════════════════════════
// VOTOS PARA PULAR
// ═══════════════════════════════════════════════════════

app.post('/api/vote/skip', async (req, res) => {
  const { user_id, song_id } = req.body;
  if (!user_id || !song_id) return res.status(400).json({ error: 'Dados incompletos' });

  // Bloqueia voto duplicado
  const { data: existing } = await supabase
    .from('skip_votes').select('id').eq('song_id', song_id).eq('user_id', user_id).single();
  if (existing) return res.status(409).json({ error: 'Você já votou' });

  const { error } = await supabase.from('skip_votes').insert({ song_id, user_id });
  if (error) return res.status(500).json({ error: error.message });

  // Conta votos
  const { count } = await supabase
    .from('skip_votes').select('id', { count: 'exact', head: true }).eq('song_id', song_id);

  console.log(`👎 Voto skip: ${count}/${SKIP_NEEDED}`);

  if (count >= SKIP_NEEDED) {
    await advanceQueue('vote_skip');
    return res.json({ ok: true, skipped: true, votes: count, needed: SKIP_NEEDED });
  }

  res.json({ ok: true, skipped: false, votes: count, needed: SKIP_NEEDED });
});

// ═══════════════════════════════════════════════════════
// DISPOSITIVOS SPOTIFY
// ═══════════════════════════════════════════════════════

app.get('/api/devices', async (req, res) => {
  try {
    const r = await spotify('get', '/me/player/devices');
    res.json({ devices: r.data.devices });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar dispositivos' });
  }
});

app.post('/api/devices/select', async (req, res) => {
  const { device_id } = req.body;
  try {
    await spotify('put', '/me/player', { device_ids: [device_id], play: false });
    await supabase.from('settings').upsert({ key: 'device_id', value: device_id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao selecionar dispositivo' });
  }
});

// ═══════════════════════════════════════════════════════
// FUNÇÕES INTERNAS
// ═══════════════════════════════════════════════════════

async function getNextSong() {
  const { data } = await supabase
    .from('queue').select('*').eq('status', 'pending')
    .order('position', { ascending: true }).limit(1);
  return data?.[0] || null;
}

async function startPlaying(song) {
  // Marca música atual como tocada
  await supabase.from('queue').update({ status: 'played' }).eq('status', 'playing');

  // Verifica se tem dispositivo preferido salvo
  const { data: devSetting } = await supabase
    .from('settings').select('value').eq('key', 'device_id').single();

  let deviceId = devSetting?.value;

  // ── Passo 1: Se tem dispositivo salvo, acorda ele antes de tocar ──
  // O Spotify fica "dormindo" quando idle; transferir o playback o acorda.
  if (deviceId) {
    await spotify('put', '/me/player', { device_ids: [deviceId], play: false }).catch(() => {});
    await new Promise(r => setTimeout(r, 600)); // aguarda o Spotify acordar
  }

  // ── Passo 2: Envia o comando de play ──
  const playBody = { uris: [song.spotify_uri] };
  if (deviceId) playBody.device_id = deviceId;

  try {
    await spotify('put', '/me/player/play', playBody);
  } catch (playErr) {
    // Fallback: nenhum contexto ativo — descobre dispositivos disponíveis
    console.warn('⚠️  Play falhou, tentando descobrir dispositivo...', playErr.response?.data?.error?.message || playErr.message);
    const devR = await spotify('get', '/me/player/devices').catch(() => null);
    const devices = devR?.data?.devices || [];

    if (devices.length > 0) {
      const active = devices.find(d => d.is_active) || devices[0];
      deviceId = active.id;

      // Salva o dispositivo encontrado para uso futuro
      await supabase.from('settings').upsert({ key: 'device_id', value: deviceId });
      console.log(`🔊 Dispositivo redescoberto: ${active.name}`);

      // Acorda e toca
      await spotify('put', '/me/player', { device_ids: [deviceId], play: false }).catch(() => {});
      await new Promise(r => setTimeout(r, 600));
      await spotify('put', '/me/player/play', { uris: [song.spotify_uri], device_id: deviceId });
    } else {
      // Nenhum dispositivo ativo — não consegue tocar
      console.error('❌ Nenhum dispositivo Spotify disponível. Abra o Spotify em algum dispositivo.');
      // Reverte o status da música para pending para não perder ela da fila
      await supabase.from('queue').update({ status: 'pending' }).eq('id', song.id);
      return;
    }
  }

  // Atualiza estado no banco
  await supabase.from('queue').update({ status: 'playing' }).eq('id', song.id);
  await supabase.from('player_state').upsert({
    id: 1,
    is_playing:          true,
    current_song_id:     song.id,
    current_spotify_id:  song.spotify_id,
    updated_at:          new Date().toISOString(),
  });

  // Limpa votos de skip desta música
  await supabase.from('skip_votes').delete().eq('song_id', song.id);

  console.log(`▶️  Tocando: ${song.title} — ${song.artist}`);
}

async function advanceQueue(reason = 'auto') {
  // Pega o que estava tocando
  const { data: state } = await supabase
    .from('player_state').select('current_song_id').eq('id', 1).single();

  if (state?.current_song_id) {
    const newStatus = reason === 'vote_skip' ? 'skipped' : 'played';
    await supabase.from('queue').update({ status: newStatus }).eq('id', state.current_song_id);
    console.log(`⏭  ${reason}: marcou ${state.current_song_id} como ${newStatus}`);
  }

  const next = await getNextSong();
  if (!next) {
    // Fila acabou
    await supabase.from('player_state').upsert({
      id: 1, is_playing: false,
      current_song_id: null, current_spotify_id: null,
      updated_at: new Date().toISOString(),
    });
    console.log('🎵 Fila vazia — playback encerrado.');
    return;
  }

  await startPlaying(next);
}

// ═══════════════════════════════════════════════════════
// MONITOR DE PLAYBACK (a cada 4 segundos)
// Sincroniza Spotify → Crescent em tempo real.
// Detecta faixas externas (Alexa, Spotify manual) e
// insere na fila para aparecer no UI.
// ═══════════════════════════════════════════════════════

let lastKnownSpotifyId = null;   // último ID visto no Spotify
let lastQueueSongId    = null;   // último ID da fila Crescent que iniciamos
let nearEndTriggered   = false;
let wasPlaying         = false;

/** Formata ms → "3:45" */
function fmtMs(ms) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Chamada quando o Spotify toca algo que NÃO está na fila do Crescent.
 * Insere a faixa como "playing" com requested_by = 'Alexa 🎙️'
 * para aparecer no UI normalmente.
 */
async function syncExternalTrack(item) {
  const spotifyId  = item.id;
  const uri        = item.uri;
  const title      = item.name;
  const artist     = item.artists?.map(a => a.name).join(', ') || 'Desconhecido';
  const album_art  = item.album?.images?.[0]?.url || null;
  const duration_ms = item.duration_ms;
  const duration_str = fmtMs(duration_ms);

  // Calcula posição após o último item da fila
  const { data: max } = await supabase
    .from('queue').select('position')
    .in('status', ['pending', 'playing'])
    .order('position', { ascending: false }).limit(1);
  const position = (max?.[0]?.position ?? -1) + 1;

  // Marca qualquer outra música como 'playing' → 'played'
  await supabase.from('queue').update({ status: 'played' }).eq('status', 'playing');

  // Insere a faixa externa diretamente como tocando
  const { data: inserted } = await supabase.from('queue').insert({
    spotify_uri: uri,
    spotify_id: spotifyId,
    title, artist, album_art,
    requested_by: 'Alexa 🎙️',
    duration_ms, duration_str,
    position,
    status: 'playing',
  }).select().single();

  if (!inserted) return null;

  // Atualiza player_state para apontar para esta entrada
  await supabase.from('player_state').upsert({
    id: 1,
    is_playing:         true,
    current_song_id:    inserted.id,
    current_spotify_id: spotifyId,
    updated_at:         new Date().toISOString(),
  });

  console.log(`📡 Faixa externa sincronizada: "${title}" — ${artist} (Alexa/Spotify)`);
  return inserted;
}

async function monitorPlayback() {
  try {
    const r = await spotify('get', '/me/player/currently-playing');

    // ── 204 / nada tocando ────────────────────────────────
    if (r.status === 204 || !r.data?.item) {
      if (lastKnownSpotifyId) {
        const { data: state } = await supabase
          .from('player_state')
          .select('current_spotify_id, is_playing, current_song_id')
          .eq('id', 1).single();

        if (state?.is_playing === true && state?.current_spotify_id === lastKnownSpotifyId) {
          if (state?.current_song_id) {
            // Era uma música da fila → avança normalmente
            console.log('🎵 Playback parou (204) — avançando fila...');
            await advanceQueue('auto');
          } else {
            // Era faixa externa sem ID na fila → apenas limpa estado
            await supabase.from('player_state').upsert({
              id: 1, is_playing: false,
              current_song_id: null, current_spotify_id: null,
              updated_at: new Date().toISOString(),
            });
          }
        }
      }
      lastKnownSpotifyId = null;
      lastQueueSongId    = null;
      nearEndTriggered   = false;
      wasPlaying         = false;
      return;
    }

    const { item, progress_ms, is_playing } = r.data;
    const spotifyId = item.id;
    const remaining = item.duration_ms - progress_ms;

    // ── Pausado ───────────────────────────────────────────
    if (!is_playing) {
      if (wasPlaying) {
        // Atualiza is_playing no banco sem avançar fila
        await supabase.from('player_state').upsert({
          id: 1, is_playing: false,
          updated_at: new Date().toISOString(),
        });
      }
      wasPlaying = false;
      return;
    }

    // ── Tocando ───────────────────────────────────────────
    wasPlaying = true;

    // ── Nova faixa detectada no Spotify ───────────────────
    if (lastKnownSpotifyId !== spotifyId) {
      console.log(`🎵 Spotify: "${item.name}" — ${item.artists?.map(a=>a.name).join(', ')}`);

      const { data: state } = await supabase
        .from('player_state')
        .select('current_spotify_id, is_playing, current_song_id')
        .eq('id', 1).single();

      // Se a faixa anterior era da fila do Crescent → avança (marca como played)
      if (
        lastKnownSpotifyId &&
        state?.current_spotify_id === lastKnownSpotifyId &&
        state?.current_song_id   // tinha um ID na fila
      ) {
        const newStatus = 'played';
        await supabase.from('queue').update({ status: newStatus }).eq('id', state.current_song_id);
        console.log(`⏭  Faixa anterior marcada como played: ${state.current_song_id}`);
      }

      // Verifica se a nova faixa está na fila do Crescent (pending OU já playing via startPlaying)
      const { data: queueMatch } = await supabase
        .from('queue')
        .select('*')
        .eq('spotify_id', spotifyId)
        .in('status', ['pending', 'playing'])
        .order('position', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (queueMatch) {
        if (queueMatch.status === 'pending') {
          // ✅ Faixa estava pendente — marca como playing
          await supabase.from('queue').update({ status: 'playing' }).eq('id', queueMatch.id);
          await supabase.from('player_state').upsert({
            id: 1,
            is_playing:         true,
            current_song_id:    queueMatch.id,
            current_spotify_id: spotifyId,
            updated_at:         new Date().toISOString(),
          });
          lastQueueSongId = queueMatch.id;
          console.log(`✅ Faixa da fila (pending→playing): "${queueMatch.title}"`);
        } else {
          // ✅ Faixa já foi marcada como playing pelo startPlaying — não sobrescrever
          lastQueueSongId = queueMatch.id;
          console.log(`✅ Faixa da fila (já playing): "${queueMatch.title}" — pedido por ${queueMatch.requested_by}`);
        }
      } else {
        // 📡 Faixa externa (Alexa, Spotify manual, etc.) → sincroniza no UI
        const ext = await syncExternalTrack(item);
        if (ext) lastQueueSongId = ext.id;
      }

      nearEndTriggered   = false;
      lastKnownSpotifyId = spotifyId;
    }

    // ── Pré-transição nos últimos 8 segundos ──────────────
    if (remaining < 8000 && remaining > 500 && !nearEndTriggered) {
      const next = await getNextSong();
      if (next) {
        nearEndTriggered = true;
        console.log(`⏳ ${Math.round(remaining / 1000)}s restantes — preparando: ${next.title}`);
      }
    }

    if (remaining > 15000) nearEndTriggered = false;

  } catch (err) {
    const status = err.response?.status;
    if (status && [401, 404, 429].includes(status)) return;
    console.error('⚠️  Monitor:', err.response?.data?.error?.message || err.message);
  }
}

setInterval(monitorPlayback, 4000);
console.log('🔁 Monitor de playback iniciado (4s) — sincroniza Spotify + Alexa em tempo real');

// ═══════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`\n🚀  Crescent Hub – Festival Server`);
  console.log(`    http://localhost:${PORT}`);
  console.log(`    Setup:  http://localhost:${PORT}/api/auth/setup`);
  console.log(`    Login:  http://localhost:${PORT}/login`);
  console.log(`    Status: http://localhost:${PORT}/api/status\n`);
});