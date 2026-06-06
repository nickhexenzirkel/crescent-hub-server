// ════════════════════════════════════════════════════════
// CRESCENT HUB — Server completo
// Spotify + Auth + Alexa TTS + Lembretes programados
// ════════════════════════════════════════════════════════

const { spawn, exec: execCP } = require('child_process');
const path     = require('path');
const fs       = require('fs');

// Instala Chromium em segundo plano para não bloquear a inicialização do servidor
execCP('npx playwright install chromium', (err) => {
  if (err) console.warn('⚠️  playwright install aviso:', err.message);
  else console.log('🎭 Playwright Chromium pronto.');
});

// ─── YT-DLP: baixa o binário uma vez por sessão ──────────────────────────────
const YTDLP_BIN     = '/tmp/yt-dlp';
const YTCOOKIES_FILE = '/tmp/yt-cookies.txt';
let ytdlpReady   = false;
let ytCookiesOk  = false;

// Escreve cookies do env var em arquivo (necessário para IPs de cloud)
if (process.env.YOUTUBE_COOKIES) {
  try {
    fs.writeFileSync(YTCOOKIES_FILE, process.env.YOUTUBE_COOKIES, 'utf8');
    ytCookiesOk = true;
    console.log('🍪 YouTube cookies carregados do ambiente.');
  } catch(e) {
    console.warn('⚠️  Não foi possível salvar cookies:', e.message);
  }
}

(function ensureYtDlp() {
  // Sempre atualiza para garantir versão mais recente (bypass do bot-check muda com frequência)
  console.log('🎵 Atualizando yt-dlp...');
  execCP(
    `curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" -o ${YTDLP_BIN} && chmod +x ${YTDLP_BIN}`,
    (e) => {
      if (e) {
        console.error('❌ yt-dlp update falhou:', e.message);
        // tenta usar versão já instalada
        execCP(`${YTDLP_BIN} --version`, (e2) => { if (!e2) ytdlpReady = true; });
      } else {
        ytdlpReady = true;
        console.log('🎵 yt-dlp atualizado.');
      }
    }
  );
})();

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
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.options('*', cors());
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
  const hasCredentials = process.env.AMAZON_EMAIL && process.env.AMAZON_PASSWORD;
  const hasRegData     = !!process.env.ALEXA_REGISTRATION_DATA;

  if (!hasCredentials && !hasRegData) {
    console.log('⚠️  Alexa: configure AMAZON_EMAIL/AMAZON_PASSWORD ou ALEXA_REGISTRATION_DATA no Render');
    return;
  }

  alexa = new AlexaRemote();

  const config = {
    alexaServiceHost: 'alexa.amazon.com',
    listeningPort:    0,
    useWsMqtt:        false,
    logger:           false,
  };

  if (hasRegData) {
    try {
      const reg = JSON.parse(process.env.ALEXA_REGISTRATION_DATA);
      config.formerRegistrationData = reg;
      if (reg.macDms)      config.macDms     = reg.macDms;
      if (reg.amazonPage)  config.amazonPage = reg.amazonPage;
      if (reg.localCookie) config.cookie     = reg.localCookie;
      console.log('🔑 Alexa: usando ALEXA_REGISTRATION_DATA');
    } catch {
      console.error('❌ ALEXA_REGISTRATION_DATA inválido — verifique o JSON');
      return;
    }
  } else {
    config.email    = process.env.AMAZON_EMAIL;
    config.password = process.env.AMAZON_PASSWORD;
  }

  alexa.init(config, (err) => {
    if (err) {
      // Ignora erro de login por browser (registration data expirada) — não polui logs
      if (err.message?.includes('open http')) {
        console.warn('⚠️  Alexa: registration data expirada. Regere ALEXA_REGISTRATION_DATA no Render.');
      } else {
        console.error('❌ Alexa init:', err.message);
      }
      return;
    }
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
// Deduplicação via Set em memória — evita depender de last_triggered no banco.
const firedReminders = new Set();

cron.schedule('* * * * *', async () => {
  try {
    const brt   = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const hhmm  = `${String(brt.getHours()).padStart(2,'0')}:${String(brt.getMinutes()).padStart(2,'0')}`;
    const today = brt.toISOString().split('T')[0];

    // Limpa entradas do dia anterior para não acumular memória indefinidamente
    if (hhmm === '00:01') firedReminders.clear();

    const { data: reminders, error: qErr } = await supabase
      .from('reminders').select('*').eq('active', true);

    if (qErr) { console.error('⚠️  Cron query:', qErr.message); return; }

    for (const r of (reminders || [])) {
      // Só processa reminders com horário definido que bate com agora
      if (!r.time || r.time.slice(0, 5) !== hhmm) continue;

      // Deduplicação: cada reminder dispara no máximo 1x por dia por horário
      const fireKey = `${r.id}_${today}_${hhmm}`;
      if (firedReminders.has(fireKey)) continue;

      const rDate = r.date ? new Date(r.date + 'T12:00:00') : null;
      const shouldFire =
        r.repeat === 'daily' ||
        (r.repeat === 'weekly'  && rDate && rDate.getDay()  === brt.getDay()) ||
        (r.repeat === 'monthly' && rDate && rDate.getDate() === brt.getDate()) ||
        (r.repeat === 'never'   && r.date === today);
      if (!shouldFire) continue;

      firedReminders.add(fireKey);
      console.log(`🔔 "${r.title}" — ${hhmm} — tipo: ${r.type}`);

      try {
        if (r.type === 'alexa') {
          await speakOnAlexa(r.message || r.title, { sound: r.sound, device: r.alexa_device });
          console.log(`✅ Alexa anunciou: "${r.title}"`);
        } else if (r.type === 'personal') {
          // Lembrete pessoal: o cliente de cada usuário gerencia localmente.
          // Não inserir em notifications para não vazar para outros usuários via realtime.
          console.log(`⏭️  Pessoal ignorado pelo servidor: "${r.title}" (${r.created_by})`);
        } else {
          // Broadcast do DashboardRH.
          // aviso_urgente pode estar armazenado como 'lembrete' + prefixo __urgent__ na mensagem
          // (workaround para o check constraint da tabela reminders).
          const isUrgent = r.message?.startsWith('__urgent__');
          const cleanMsg = isUrgent ? r.message.slice('__urgent__'.length) : r.message;
          const nType    = (r.type === 'aviso_urgente' || isUrgent) ? 'aviso_urgente' : 'lembrete';
          await supabase.from('notifications').insert({
            type: nType, title: r.title, message: cleanMsg || r.title, active: true,
          });
          console.log(`✅ Notificação "${nType}" disparada: "${r.title}"`);
        }
      } catch (e) { console.error(`❌ Falha ao disparar "${r.title}":`, e.message); }
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
  const token = jwt.sign({ id: emp.id, name: emp.name, cpf: emp.cpf, role: emp.role }, JWT_SECRET, { expiresIn: '7d' });
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

app.patch('/api/auth/profile', requireAuth, async (req, res) => {
  const allowed = ['email','phone','street','district','city','state','cep'];
  const updates = {};
  allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
  const { error } = await supabase.from('employees').update(updates).eq('id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
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
// Lista pública de colegas (qualquer colaborador autenticado)
app.get('/api/team', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('employees')
    .select('id,name,role,cargo,active,admission')
    .eq('active', true)
    .order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ employees: data });
});

// FUNCIONÁRIOS — CRUD (admin only)
// ═══════════════════════════════════════════════════════

app.get('/api/employees', requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from('employees').select('id,name,cpf,role,cargo,active,created_at,updated_at').order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ employees: data.map(e => ({ ...e, cpf: maskCpf(e.cpf) })) });
});

app.post('/api/employees', requireAdmin, async (req, res) => {
  const { name: n, cpf: rc, role = 'employee', cargo = '', password } = req.body;
  const name = (n || '').trim();
  const cpf  = normCpf(rc);
  if (!name)             return res.status(400).json({ error: 'Nome obrigatório' });
  if (cpf.length !== 11) return res.status(400).json({ error: 'CPF deve ter 11 dígitos' });
  const password_hash = await bcrypt.hash(normCpf(password || cpf), 10);
  const { data, error } = await supabase.from('employees').insert({ name, cpf, password_hash, role, cargo: cargo.trim(), active: true }).select('id,name,cpf,role,cargo,active,created_at').single();
  if (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'CPF já cadastrado' });
    return res.status(500).json({ error: error.message });
  }
  console.log(`➕ Criado: ${name} (${maskCpf(cpf)}) — ${role}`);
  res.json({ employee: { ...data, cpf: maskCpf(data.cpf) } });
});

app.put('/api/employees/:id', requireAdmin, async (req, res) => {
  const { name, role, cargo, active } = req.body;
  const u = { updated_at: new Date().toISOString() };
  if (name   !== undefined) u.name   = name.trim();
  if (role   !== undefined) u.role   = role;
  if (cargo  !== undefined) u.cargo  = cargo.trim();
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
// COMUNICADOS
// ════════════════════════════════════════════════════════

app.get('/api/comunicados', async (req, res) => {
  const { data, error } = await supabase.from('comunicados')
    .select('*').eq('active', true).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ comunicados: data || [] });
});

app.post('/api/comunicados', requireAdmin, async (req, res) => {
  const { title, body, cat, urgent } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Título obrigatório' });
  const { data, error } = await supabase.from('comunicados')
    .insert({ title: title.trim(), body: body||'', cat: cat||'RH', urgent: !!urgent, created_by: req.user.name })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, comunicado: data });
});

app.delete('/api/comunicados/:id', requireAdmin, async (req, res) => {
  const { error } = await supabase.from('comunicados').update({ active: false }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

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
let CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID     || '';
let CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';
const REDIRECT_URI  = process.env.REDIRECT_URI || `http://localhost:${PORT}/callback`;
const SKIP_NEEDED   = parseInt(process.env.SKIP_VOTES_NEEDED) || 4;

// Token em memória (persiste refresh_token no Supabase para sobreviver restarts)
let tokens = { access: null, refresh: null, expiresAt: 0 };

// Autoplay — carregado do Supabase, pode ser ligado/desligado em runtime
let autoplayEnabled = true;

// Carrega credenciais Spotify salvas no Supabase (sobrepõe .env se existirem)
async function loadSpotifyCredentials() {
  try {
    const { data } = await supabase
      .from('settings').select('key, value')
      .in('key', ['spotify_client_id', 'spotify_client_secret', 'autoplay_enabled']);
    for (const row of (data || [])) {
      if (row.key === 'spotify_client_id'     && row.value) CLIENT_ID     = row.value;
      if (row.key === 'spotify_client_secret' && row.value) CLIENT_SECRET = row.value;
      if (row.key === 'autoplay_enabled') autoplayEnabled = row.value !== 'false';
    }
    if (CLIENT_ID) console.log(`🎵 Spotify: credenciais carregadas do Supabase (${CLIENT_ID.slice(0,8)}...)`);
  } catch (e) { console.error('⚠️  loadSpotifyCredentials:', e.message); }
}
loadSpotifyCredentials();

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

// Enviar notificação imediata (aviso_urgente ou lembrete)
app.post('/api/notifications', requireAdmin, async (req, res) => {
  const { type, title, message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'message obrigatória' });
  const { data, error } = await supabase.from('notifications')
    .insert({ type: type || 'lembrete', title: title || null, message: message.trim(), active: true })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, notification: data });
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

// Envia pergunta direto para a Alexa processar com inteligência nativa
app.post('/api/alexa/ask', requireAuth, async (req, res) => {
  const { question, userName } = req.body;
  if (!question?.trim()) return res.status(400).json({ error: 'Pergunta obrigatória' });
  if (!alexaOk)           return res.status(503).json({ error: 'Alexa offline ou não configurada' });

  const firstName     = (userName || 'Colaborador').split(' ')[0];
  const cleanQuestion = question.replace(/^alexa[,.\s]*/i, '').trim();

  // Detecta "tocar playlist X" e redireciona para o sistema de fila
  const playlistMatch = cleanQuestion.match(/(?:tocar?|play|iniciar?|reproduzir?)\s+(?:a\s+)?playlist\s+["']?(.+?)["']?$/i);
  if (playlistMatch) {
    const searchName = playlistMatch[1].trim().toLowerCase();
    try {
      const r = await spotify('get', '/me/playlists?limit=50');
      const playlists = r.data?.items || [];
      const found = playlists.find(p =>
        p.name.toLowerCase().includes(searchName) || searchName.includes(p.name.toLowerCase())
      );
      if (found) {
        // Busca faixas e inicia pelo sistema de fila
        const tr = await spotify('get', `/playlists/${found.id}/tracks?limit=100&market=BR`);
        const tracks = (tr.data?.items || []).map(i => mapTrack(i.track)).filter(Boolean);
        if (tracks.length) {
          await supabase.from('settings').upsert({ key: 'active_playlist_id',     value: found.id });
          await supabase.from('settings').upsert({ key: 'active_playlist_name',   value: found.name });
          await supabase.from('settings').upsert({ key: 'active_playlist_tracks', value: JSON.stringify(tracks) });
          await supabase.from('settings').upsert({ key: 'active_playlist_pos',    value: '1' });
          await supabase.from('queue').update({ status: 'removed' }).eq('status', 'pending').eq('requested_by', 'Autoplay 🎲');
          const { data: maxPos } = await supabase.from('queue').select('position').in('status',['pending','playing']).order('position',{ascending:false}).limit(1);
          const position = (maxPos?.[0]?.position ?? -1) + 1;
          const first = tracks[0];
          const { data: inserted } = await supabase.from('queue').insert({
            spotify_uri: first.uri, spotify_id: first.id, title: first.title, artist: first.artist, album_art: first.album_art,
            requested_by: `📋 ${found.name}`, duration_ms: first.duration_ms, duration_str: first.duration_str, position, status: 'pending',
          }).select().single();
          if (inserted) await startPlaying(inserted);
          console.log(`📋 Alexa ask → playlist "${found.name}" iniciada por ${firstName}`);
          return res.json({ ok: true, spoke: false, playlist: found.name });
        }
      }
      return res.json({ ok: true, spoke: false, not_found: searchName });
    } catch (e) { console.error('⚠️  playlist via alexa ask:', e.message); }
  }

  const serial = process.env.ALEXA_DEVICE_SERIAL
    || alexaDevices.find(d => d.deviceFamily?.toLowerCase().includes('echo'))?.serialNumber;
  if (!serial) return res.status(500).json({ error: 'Nenhum dispositivo Echo encontrado' });

  // Verifica se há música tocando e pausa antes de enviar o comando
  let wasPlaying = false;
  try {
    const playerCheck = await spotify('get', '/me/player/currently-playing').catch(() => null);
    if (playerCheck?.data?.is_playing) {
      wasPlaying = true;
      await spotify('put', '/me/player/pause').catch(() => {});
      await new Promise(r => setTimeout(r, 800));
    }
  } catch {}

  try {
    await new Promise((resolve, reject) => {
      alexa.sendSequenceCommand(serial, 'textCommand', cleanQuestion, (err) => {
        if (err) reject(err); else resolve();
      });
    });
    console.log(`🗣️  Alexa textcommand — ${firstName}: "${cleanQuestion}" (música pausada: ${wasPlaying})`);

    // Retoma música após Alexa responder (~8s é tempo suficiente para respostas curtas)
    if (wasPlaying) {
      setTimeout(async () => {
        await spotify('put', '/me/player/play').catch(() => {});
      }, 8000);
    }

    res.json({ ok: true, spoke: true });
  } catch (err) {
    console.error('❌ Alexa textcommand:', err.message);
    // Retoma música se pausou e falhou
    if (wasPlaying) spotify('put', '/me/player/play').catch(() => {});
    res.status(500).json({ error: 'Não foi possível enviar para a Alexa: ' + err.message });
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

// ═══════════════════════════════════════════════════════
// SPOTIFY CREDENTIALS — atualiza Client ID / Secret em runtime
// ═══════════════════════════════════════════════════════

app.get('/api/spotify/credentials', requireAdmin, (req, res) => {
  res.json({
    client_id:         CLIENT_ID ? `${CLIENT_ID.slice(0, 8)}••••` : null,
    has_client_secret: !!CLIENT_SECRET,
    has_refresh_token: !!tokens.refresh,
  });
});

app.post('/api/spotify/credentials', requireAdmin, async (req, res) => {
  const { client_id, client_secret } = req.body;
  if (!client_id?.trim() || !client_secret?.trim())
    return res.status(400).json({ error: 'client_id e client_secret obrigatórios' });

  await supabase.from('settings').upsert({ key: 'spotify_client_id',     value: client_id.trim() });
  await supabase.from('settings').upsert({ key: 'spotify_client_secret', value: client_secret.trim() });

  CLIENT_ID     = client_id.trim();
  CLIENT_SECRET = client_secret.trim();

  // Invalida tokens para forçar re-autenticação com a nova conta
  tokens = { access: null, refresh: null, expiresAt: 0 };
  await supabase.from('settings').delete().eq('key', 'spotify_refresh_token');

  console.log(`🔑 Spotify credenciais atualizadas (${CLIENT_ID.slice(0,8)}...) — re-auth necessário`);
  res.json({ ok: true });
});

// SPOTIFY AUTH
// ═══════════════════════════════════════════════════════

app.get('/login', (req, res) => {
  const scope = [
    'user-read-playback-state',
    'user-modify-playback-state',
    'user-read-currently-playing',
    'playlist-read-private',
    'playlist-read-collaborative',
    'playlist-modify-private',
    'playlist-modify-public',
    'user-library-read',
    'user-top-read',
    'user-read-recently-played',
  ].join(' ');

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     CLIENT_ID,
    scope,
    redirect_uri:  REDIRECT_URI,
    state:       Math.random().toString(36).slice(2),
    show_dialog: 'true',
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

    const { access_token, refresh_token, expires_in, scope } = r.data;
    tokens = { access: access_token, refresh: refresh_token, expiresAt: Date.now() + (expires_in - 60) * 1000 };
    console.log('🎵 Spotify autenticado. Escopos:', scope);

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
// Implementa backoff automático quando recebe 429 (rate limit)
let rateLimitedUntil = 0;

async function spotify(method, path, data, { retries = 2, _attempt = 0 } = {}) {
  if (Date.now() < rateLimitedUntil) {
    const waitSec = Math.round((rateLimitedUntil - Date.now()) / 1000);
    throw Object.assign(new Error(`Rate limit ativo — aguardando ${waitSec}s`), { response: { status: 429 } });
  }
  const token = await ensureToken();
  try {
    return await axios({
      method,
      url:     `https://api.spotify.com/v1${path}`,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data:    data || undefined,
    });
  } catch (err) {
    if (err.response?.status === 429) {
      const retryAfter = parseInt(err.response?.headers?.['retry-after'] || '60');
      rateLimitedUntil = Date.now() + retryAfter * 1000;
      console.warn(`⏸  Rate limit Spotify — pausando chamadas por ${retryAfter}s`);
    }
    // Retry com backoff exponencial para erros 5xx transitórios (502, 503, 504)
    if (retries > 0 && err.response?.status >= 500) {
      const delay = 1500 * Math.pow(2, _attempt); // 1.5s, 3s
      if (_attempt === 0) console.warn(`⚠️  Spotify ${err.response.status} em ${path.split('?')[0]} — retrying...`);
      await new Promise(r => setTimeout(r, delay));
      return spotify(method, path, data, { retries: retries - 1, _attempt: _attempt + 1 });
    }
    throw err;
  }
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

// Cache de progresso — evita bater no Spotify a cada request do frontend (letras sincronizadas)
let progressCache = { data: null, at: 0 };
const PROGRESS_CACHE_MS = 1500; // reusa resultado por 1.5s

app.get('/api/progress', async (req, res) => {
  try {
    const now = Date.now();
    if (progressCache.data && (now - progressCache.at) < PROGRESS_CACHE_MS) {
      return res.json(progressCache.data);
    }
    const r = await spotify('get', '/me/player/currently-playing');
    if (r.status === 204 || !r.data?.item) {
      const result = { progress_ms: 0, is_playing: false };
      progressCache = { data: result, at: now };
      return res.json(result);
    }
    const result = {
      progress_ms:  r.data.progress_ms,
      is_playing:   r.data.is_playing,
      duration_ms:  r.data.item.duration_ms,
    };
    progressCache = { data: result, at: now };
    res.json(result);
  } catch {
    res.json({ progress_ms: 0, is_playing: false });
  }
});

// ═══════════════════════════════════════════════════════
// BUSCA DE MÚSICAS
// ═══════════════════════════════════════════════════════

// Cache de busca — evita múltiplos hits no Spotify para a mesma query em 60s
const searchCache = new Map();
const SEARCH_CACHE_TTL = 60_000;

const mapSearchTrack = t => ({
  id:           t.id,
  uri:          t.uri,
  title:        t.name,
  artist:       t.artists.map(a => a.name).join(', '),
  album:        t.album.name,
  album_art:    t.album.images[1]?.url || t.album.images[0]?.url || null,
  duration_ms:  t.duration_ms,
  duration_str: `${Math.floor(t.duration_ms / 60000)}:${String(Math.floor((t.duration_ms % 60000) / 1000)).padStart(2, '0')}`,
});

app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  if (!q?.trim()) return res.status(400).json({ error: 'Query vazia' });

  const key = q.trim().toLowerCase();

  // Retorna do cache se ainda válido
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.at < SEARCH_CACHE_TTL) {
    return res.json({ tracks: cached.tracks });
  }

  const qEnc = encodeURIComponent(q);
  try {
    const r = await spotify('get', `/search?q=${qEnc}&type=track&limit=8`);
    const tracks = r.data.tracks.items.map(mapSearchTrack);

    // Salva no cache e limpa entradas velhas
    searchCache.set(key, { tracks, at: Date.now() });
    if (searchCache.size > 300) {
      const now = Date.now();
      for (const [k, v] of searchCache)
        if (now - v.at > SEARCH_CACHE_TTL) searchCache.delete(k);
    }

    res.json({ tracks });
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data?.error?.message || err.message;
    console.error(`❌ Search (HTTP ${status}):`, detail);
    if (status === 401) return res.status(401).json({ error: 'Spotify não autenticado. Acesse /login para reconectar.' });
    if (status >= 500) return res.status(502).json({ error: `Spotify indisponível (${status}). Tente novamente em instantes.` });
    res.status(500).json({ error: `Erro na busca: ${detail}` });
  }
});

// ═══════════════════════════════════════════════════════
// FILA (QUEUE)
// ═══════════════════════════════════════════════════════

app.post('/api/queue', async (req, res) => {
  const { uri, spotify_id, title, artist, album_art, requested_by, duration_ms, duration_str, is_admin } = req.body;
  if (!uri || !title || !requested_by) return res.status(400).json({ error: 'Dados incompletos' });

  // ── Limite de 2 vagas por colaborador (admin é ilimitado) ──
  // Músicas >= 15 min ocupam 2 vagas; abaixo disso, 1 vaga.
  const SLOT_LIMIT  = 2;
  const LONG_MS     = 15 * 60 * 1000;
  const slotsNeeded = (duration_ms || 0) >= LONG_MS ? 2 : 1;

  if (!is_admin) {
    const { data: userSongs } = await supabase
      .from('queue')
      .select('id, duration_ms')
      .eq('requested_by', requested_by)
      .in('status', ['pending', 'playing']);

    const slotsUsed = (userSongs || []).reduce(
      (acc, s) => acc + ((s.duration_ms || 0) >= LONG_MS ? 2 : 1), 0
    );

    if (slotsUsed + slotsNeeded > SLOT_LIMIT) {
      const msg = slotsNeeded === 2
        ? `Essa música tem mais de 15 minutos e ocupa as 2 vagas. Você não tem vagas disponíveis.`
        : `Limite atingido! Você já tem ${slotsUsed}/2 vagas ocupadas. Aguarde uma música tocar para adicionar mais.`;
      return res.status(429).json({ error: msg });
    }
  }

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

  // ── Gerenciamento de autoplay vs fila real ──────────────
  try {
    const AUTOPLAY_TAG = 'Autoplay 🎲';

    // Remove recomendações pendentes — usuário colocou música real
    const { count: autoPending } = await supabase
      .from('queue').select('id', { count: 'exact', head: true })
      .eq('status', 'pending').eq('requested_by', AUTOPLAY_TAG);

    if (autoPending > 0) {
      await supabase.from('queue').update({ status: 'removed' })
        .eq('status', 'pending').eq('requested_by', AUTOPLAY_TAG);
      console.log(`🗑️  ${autoPending} recomendação(ões) de autoplay removidas`);
    }

    // Remove playlist ativa pendente também
    const { count: playlistPending } = await supabase
      .from('queue').select('id', { count: 'exact', head: true })
      .eq('status', 'pending').like('requested_by', '📋%');
    if (playlistPending > 0) {
      await supabase.from('queue').update({ status: 'removed' }).eq('status', 'pending').like('requested_by', '📋%');
      await supabase.from('settings').delete().in('key', ['active_playlist_id','active_playlist_name','active_playlist_tracks','active_playlist_pos']);
    }

    // Verifica se só o autoplay estava tocando (sem música real na fila)
    const { data: playingAutoplay } = await supabase
      .from('queue').select('id').eq('status', 'playing').eq('requested_by', AUTOPLAY_TAG)
      .maybeSingle();

    const [{ data: playerState }, { count: playingRealCount }] = await Promise.all([
      supabase.from('player_state').select('is_playing, current_song_id').eq('id', 1).single(),
      supabase.from('queue').select('id', { count: 'exact', head: true })
        .eq('status', 'playing').neq('requested_by', AUTOPLAY_TAG),
    ]);

    const realMusicPlaying = (playerState?.is_playing && playerState?.current_song_id && playingRealCount > 0);

    // Verifica o estado real do Spotify via cache do monitor (atualizado a cada 4s)
    const cacheAge           = Date.now() - progressCache.at;
    const spotifyReallyPlaying = progressCache.data?.is_playing === true && cacheAge < 10000;

    if (!realMusicPlaying && !spotifyReallyPlaying) {
      // Nada tocando de verdade: inicia a música do usuário imediatamente
      if (playingAutoplay) {
        await supabase.from('queue').update({ status: 'played' }).eq('id', playingAutoplay.id);
      }
      await startPlaying(data);
      console.log(`▶️  Auto-start: "${title}" — ${playingAutoplay ? 'interrompeu autoplay' : 'fila estava vazia'}`);
    } else if (!realMusicPlaying && spotifyReallyPlaying) {
      // Spotify tocando (autoplay ou transição recente) — música vai para a fila normalmente
      console.log(`🎵 Spotify tocando — "${title}" adicionada à fila`);
    }
    // Se música real já estava tocando, a nova entra normalmente na fila
  } catch (err) {
    console.error('⚠️  Auto-start falhou:', err.response?.data?.error?.message || err.message);
  }

  res.json({ song: data });
});

// Limpar toda a fila (admin)
app.delete('/api/queue', async (req, res) => {
  try {
    // Marca todas as músicas pending como removidas
    await supabase.from('queue').update({ status: 'removed' }).in('status', ['pending', 'playing']);
    // Para o player
    await supabase.from('player_state').upsert({
      id: 1, is_playing: false, current_song_id: null, current_spotify_id: null,
      updated_at: new Date().toISOString(),
    });
    // Para o Spotify também
    await spotify('put', '/me/player/pause').catch(() => {});
    console.log('🗑️  Fila limpa pelo administrador');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/queue/:id', async (req, res) => {
  const { error } = await supabase.from('queue').update({ status: 'removed' }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════
// CONTROLES DO PLAYER
// ═══════════════════════════════════════════════════════

// Começa a tocar a primeira música da fila (admin only)
app.post('/api/player/play', requireAdmin, async (req, res) => {
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

// Pausa (admin only)
app.post('/api/player/pause', requireAdmin, async (req, res) => {
  try {
    await spotify('put', '/me/player/pause');
    await supabase.from('player_state').upsert({ id: 1, is_playing: false, updated_at: new Date().toISOString() });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error?.message || 'Erro ao pausar' });
  }
});

// Retoma (admin only)
app.post('/api/player/resume', requireAdmin, async (req, res) => {
  try {
    await spotify('put', '/me/player/play');
    await supabase.from('player_state').upsert({ id: 1, is_playing: true, updated_at: new Date().toISOString() });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error?.message || 'Erro ao retomar' });
  }
});

// Pula para a próxima (admin only)
app.post('/api/player/next', requireAdmin, async (req, res) => {
  try {
    await advanceQueue('manual_skip');
    res.json({ ok: true });
  } catch (err) {
    console.error('❌ Next:', err.message);
    res.status(500).json({ error: 'Erro ao pular' });
  }
});

// Autoplay on/off (admin only)
app.get('/api/player/autoplay', requireAdmin, (req, res) => {
  res.json({ enabled: autoplayEnabled });
});

app.post('/api/player/autoplay', requireAdmin, async (req, res) => {
  const { enabled } = req.body;
  autoplayEnabled = !!enabled;
  await supabase.from('settings').upsert({ key: 'autoplay_enabled', value: String(autoplayEnabled) }, { onConflict: 'key' });
  console.log(`🎵 Autoplay ${autoplayEnabled ? 'ativado ✅' : 'desativado 🚫'}`);
  res.json({ ok: true, enabled: autoplayEnabled });
});

// Ajuste de volume (admin only)
app.put('/api/player/volume', requireAdmin, async (req, res) => {
  const volume_percent = parseInt(req.query.volume_percent ?? req.body?.volume_percent);
  if (isNaN(volume_percent) || volume_percent < 0 || volume_percent > 100)
    return res.status(400).json({ error: 'volume_percent deve ser 0-100' });
  try {
    await spotify('put', `/me/player/volume?volume_percent=${volume_percent}`);
    res.json({ ok: true, volume: volume_percent });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
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
// GENRE — retorna genres do Spotify para uma faixa
// ═══════════════════════════════════════════════════════

// ── Genre cache: 3 camadas ───────────────────────────────────
// 1. Memória (rápido, dura enquanto o processo vive)
// 2. Supabase settings (persiste entre restarts)
// 3. Spotify API (apenas quando nenhuma camada tem o dado)
// pendingGenre evita race condition: N requests simultâneos
// para o mesmo track_id resultam em apenas 1 call ao Spotify.
const genreCache   = new Map(); // track_id → string[]
const pendingGenre = new Map(); // track_id → Promise<string[]>

async function fetchGenre(track_id) {
  // 1. Memória
  if (genreCache.has(track_id)) return genreCache.get(track_id);

  // 2. Deduplica requests concorrentes para o mesmo track
  if (pendingGenre.has(track_id)) return pendingGenre.get(track_id);

  const promise = (async () => {
    try {
      // 3. Supabase (cache persistente entre restarts)
      const { data: row } = await supabase
        .from('settings').select('value').eq('key', `genre:${track_id}`).maybeSingle();
      if (row?.value) {
        const genres = JSON.parse(row.value);
        genreCache.set(track_id, genres);
        return genres;
      }

      // 4. Rate limit ativo → retorna vazio sem bater no Spotify
      if (Date.now() < rateLimitedUntil) return [];

      // 5. Spotify API (última opção)
      const trackR   = await spotify('get', `/tracks/${track_id}?market=BR`);
      const artistId = trackR.data.artists?.[0]?.id;
      if (!artistId) {
        genreCache.set(track_id, []);
        await supabase.from('settings').upsert({ key: `genre:${track_id}`, value: '[]' });
        return [];
      }
      const artistR = await spotify('get', `/artists/${artistId}`);
      const genres  = artistR.data.genres || [];

      // Salva nas duas camadas de cache
      genreCache.set(track_id, genres);
      await supabase.from('settings').upsert({ key: `genre:${track_id}`, value: JSON.stringify(genres) });
      console.log(`🎸 Genre cacheado: ${track_id} → [${genres.join(', ')}]`);
      return genres;
    } catch (err) {
      console.error('❌ fetchGenre:', err.response?.data || err.message);
      return []; // erros não são cacheados — próxima requisição tenta de novo
    } finally {
      pendingGenre.delete(track_id);
    }
  })();

  pendingGenre.set(track_id, promise);
  return promise;
}

app.get('/api/genre', async (req, res) => {
  const { track_id } = req.query;
  if (!track_id) return res.status(400).json({ error: 'track_id obrigatório' });
  const genres = await fetchGenre(track_id);
  res.json({ genres });
});

// ═══════════════════════════════════════════════════════
// DISPOSITIVOS SPOTIFY
// ═══════════════════════════════════════════════════════

app.get('/api/devices', async (req, res) => {
  try {
    const r = await spotify('get', '/me/player/devices');
    res.json({ devices: r.data.devices });
  } catch (err) {
    const status  = err.response?.status;
    const message = err.response?.data?.error?.message || err.message;
    console.error(`❌ /api/devices falhou — HTTP ${status}: ${message}`);
    res.status(500).json({ error: 'Erro ao listar dispositivos', detail: `HTTP ${status}: ${message}` });
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

// Força ativação do Echo Spot via Alexa (sem tocar música)
app.post('/api/devices/wake', requireAuth, async (req, res) => {
  const wokenId = await wakeSpotifyViaAlexa(null);
  if (wokenId) res.json({ ok: true, device_id: wokenId });
  else res.status(503).json({ error: 'Não foi possível ativar o Echo Spot' });
});

// ═══════════════════════════════════════════════════════
// PLAYLISTS
// ═══════════════════════════════════════════════════════

const fmtMsTrack = ms => `${Math.floor(ms/60000)}:${String(Math.floor((ms%60000)/1000)).padStart(2,'0')}`;

const mapTrack = t => t ? ({
  id: t.id, uri: t.uri, title: t.name,
  artist: t.artists?.map(a => a.name).join(', ') || '',
  album_art: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || null,
  duration_ms: t.duration_ms,
  duration_str: fmtMsTrack(t.duration_ms),
}) : null;

// Retorna faixas do Spotify + extras do Supabase (adicionados via Uniko), sem duplicatas
// Cada fonte tem try/catch próprio — a função nunca lança exceção nem retorna 500
const getPlaylistAllTracks = async (playlistId) => {
  let spotifyTracks = [];
  let supabaseTracks = [];

  try {
    const r = await spotify('get', `/playlists/${playlistId}/tracks?limit=100&market=BR`);
    spotifyTracks = (r.data?.items || []).map(i => mapTrack(i.track)).filter(Boolean);
  } catch (err) {
    console.warn(`⚠️ Spotify tracks (${playlistId}):`, err.response?.data?.error?.message || err.message);
  }

  try {
    const { data } = await supabase.from('playlist_tracks').select('*')
      .eq('playlist_id', playlistId).order('position', { ascending: true });
    supabaseTracks = data || [];
  } catch (err) {
    console.warn(`⚠️ Supabase tracks (${playlistId}):`, err.message);
  }

  const spotifyUris = new Set(spotifyTracks.map(t => t.uri));
  const supabaseExtra = supabaseTracks
    .filter(t => !spotifyUris.has(t.spotify_uri))
    .map(t => ({
      id: t.spotify_id, uri: t.spotify_uri,
      title: t.title, artist: t.artist, album_art: t.album_art,
      duration_ms: t.duration_ms, duration_str: t.duration_str,
    }));
  return [...spotifyTracks, ...supabaseExtra];
};

app.get('/api/playlists', requireAuth, async (req, res) => {
  try {
    const { data: playlists, error } = await supabase.from('playlists')
      .select('*').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    if (!playlists?.length) return res.json({ playlists: [] });

    const { data: trackRows } = await supabase.from('playlist_tracks')
      .select('playlist_id').in('playlist_id', playlists.map(p => p.id));
    const countMap = {};
    (trackRows || []).forEach(t => { countMap[t.playlist_id] = (countMap[t.playlist_id] || 0) + 1; });

    res.json({
      playlists: playlists.map(p => ({
        id: p.id, name: p.name, created_by: p.created_by,
        image: p.image_url || null,
        total: countMap[p.id] || 0,
      }))
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/playlists', requireAuth, async (req, res) => {
  const { name, description } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Nome obrigatório' });
  try {
    const r = await spotify('post', '/me/playlists', {
      name: name.trim(), description: description || 'Criada pelo Uniko', public: false,
    });
    const { data, error } = await supabase.from('playlists').insert({
      id: r.data.id, name: r.data.name, created_by: req.user.name,
    }).select().single();
    if (error) return res.status(500).json({ error: error.message });
    console.log(`📋 Playlist criada: "${r.data.name}" por ${req.user.name}`);
    res.json({ playlist: { id: data.id, name: data.name, created_by: data.created_by, image: null, total: 0 } });
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('❌ create playlist:', JSON.stringify(detail));
    res.status(err.response?.status || 500).json({ error: JSON.stringify(detail) });
  }
});

app.patch('/api/playlists/:id/cover', requireAuth, async (req, res) => {
  const { image_url } = req.body;
  if (!image_url) return res.status(400).json({ error: 'image_url obrigatória' });
  const { error } = await supabase.from('playlists').update({ image_url }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Debug público — testa acesso a playlist sem auth do Uniko
app.get('/api/debug/pl/:id', async (req, res) => {
  try {
    const r = await spotify('get', `/playlists/${req.params.id}`);
    res.json({ name: r.data.name, owner: r.data.owner?.id, total: r.data.tracks?.total });
  } catch (err) { res.json({ error: err.response?.data, status: err.response?.status }); }
});

// Faixas do Spotify + extras do Supabase (POST/DELETE via Spotify restrito pós-nov/2024)
app.get('/api/playlists/:id/tracks', requireAuth, async (req, res) => {
  try {
    const tracks = await getPlaylistAllTracks(req.params.id);
    res.json({ tracks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/playlists/:id/tracks', requireAuth, async (req, res) => {
  const { uri, uris, title, artist, album_art, duration_ms, duration_str, spotify_id } = req.body;
  const trackUri = uri || uris?.[0];
  if (!trackUri) return res.status(400).json({ error: 'URI obrigatória' });
  const { data: max } = await supabase
    .from('playlist_tracks').select('position')
    .eq('playlist_id', req.params.id)
    .order('position', { ascending: false }).limit(1);
  const position = (max?.[0]?.position ?? -1) + 1;
  const { data, error } = await supabase.from('playlist_tracks').insert({
    playlist_id: req.params.id, spotify_uri: trackUri, spotify_id,
    title, artist, album_art, duration_ms, duration_str,
    position, added_by: req.user?.name || 'Colaborador',
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, track: data });
});

app.delete('/api/playlists/:id/tracks', requireAuth, async (req, res) => {
  const { uri } = req.body;
  if (!uri) return res.status(400).json({ error: 'URI obrigatória' });
  const { error } = await supabase.from('playlist_tracks')
    .delete().eq('playlist_id', req.params.id).eq('spotify_uri', uri);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Inicia playlist pelo Uniko queue (uma música por vez)
app.post('/api/playlists/:id/play', requireAuth, async (req, res) => {
  const { name } = req.body;
  try {
    const tracksFormatted = await getPlaylistAllTracks(req.params.id);
    if (!tracksFormatted.length) return res.status(404).json({ error: 'Playlist vazia' });

    // Salva estado da playlist ativa no Supabase
    await supabase.from('settings').upsert({ key: 'active_playlist_id',     value: req.params.id });
    await supabase.from('settings').upsert({ key: 'active_playlist_name',   value: name || req.params.id });
    await supabase.from('settings').upsert({ key: 'active_playlist_tracks', value: JSON.stringify(tracksFormatted) });
    await supabase.from('settings').upsert({ key: 'active_playlist_pos',    value: '1' });

    // Remove autoplay pendente
    await supabase.from('queue').update({ status: 'removed' }).eq('status', 'pending').eq('requested_by', 'Autoplay 🎲');

    // Insere e toca a primeira música
    const first = tracksFormatted[0];
    const { data: maxPos } = await supabase.from('queue').select('position').in('status', ['pending','playing']).order('position', { ascending: false }).limit(1);
    const position = (maxPos?.[0]?.position ?? -1) + 1;

    const { data: inserted } = await supabase.from('queue').insert({
      spotify_uri: first.uri, spotify_id: first.id,
      title: first.title, artist: first.artist, album_art: first.album_art,
      requested_by: `📋 ${name || 'Playlist'}`,
      duration_ms: first.duration_ms, duration_str: first.duration_str,
      position, status: 'pending',
    }).select().single();

    if (inserted) await startPlaying(inserted);
    console.log(`📋 Playlist "${name}" iniciada (${tracksFormatted.length} faixas)`);
    res.json({ ok: true, total: tracksFormatted.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════
// FUNÇÕES INTERNAS
// ═══════════════════════════════════════════════════════

// Seleciona dispositivo preferindo sempre Echo/Spot sobre outros (iPhone, PC, etc.)
function preferEchoDevice(devices) {
  if (!devices?.length) return null;
  return devices.find(d => /echo|spot|alexa/i.test(d.name))
      || devices.find(d => d.is_active)
      || devices[0];
}

async function getNextSong() {
  const { data } = await supabase
    .from('queue').select('*').eq('status', 'pending')
    .order('position', { ascending: true }).limit(1);
  return data?.[0] || null;
}

// Usa Alexa textCommand para acordar o Spotify no Echo Spot e retorna o device_id
async function wakeSpotifyViaAlexa(song) {
  if (!alexaOk) return null;
  const echoSerial = process.env.ALEXA_DEVICE_SERIAL
    || alexaDevices.find(d => d.deviceFamily?.toLowerCase().includes('echo'))?.serialNumber;
  if (!echoSerial) return null;

  try {
    const cmd = song
      ? `tocar ${song.title} de ${song.artist} no spotify`
      : 'abrir spotify';

    await new Promise((resolve, reject) => {
      alexa.sendSequenceCommand(echoSerial, 'textCommand', cmd, (err) => {
        if (err) reject(err); else resolve();
      });
    });
    console.log(`🎙️  Alexa wake: "${cmd}"`);

    // Aguarda Echo Spot aparecer como dispositivo Spotify Connect ativo
    await new Promise(r => setTimeout(r, 3500));

    const devR = await spotify('get', '/me/player/devices').catch(() => null);
    const device = preferEchoDevice(devR?.data?.devices);

    if (device) {
      await supabase.from('settings').upsert({ key: 'device_id', value: device.id });
      console.log(`🔊 Echo Spot ativo via Alexa: ${device.name}`);
      return device.id;
    }
  } catch (e) {
    console.error('⚠️  wakeSpotifyViaAlexa:', e.message);
  }
  return null;
}

async function startPlaying(song) {
  // Marca música atual como tocada
  await supabase.from('queue').update({ status: 'played' }).eq('status', 'playing');

  // Dispositivo salvo
  const { data: devSetting } = await supabase
    .from('settings').select('value').eq('key', 'device_id').single();
  let deviceId = devSetting?.value;

  // Se não há device_id salvo, descobre agora (sempre prefere Echo/Spot)
  if (!deviceId) {
    const devR = await spotify('get', '/me/player/devices').catch(() => null);
    const chosen = preferEchoDevice(devR?.data?.devices);
    if (chosen) {
      deviceId = chosen.id;
      await supabase.from('settings').upsert({ key: 'device_id', value: deviceId });
      console.log(`🔊 Dispositivo auto-selecionado: ${chosen.name}`);
    }
  }

  // Se temos device_id, transfere o playback para acordar o dispositivo antes de tocar
  if (deviceId) {
    await spotify('put', '/me/player', { device_ids: [deviceId], play: false }).catch(() => {});
    await new Promise(r => setTimeout(r, 800));
  }

  try {
    const playBody = { uris: [song.spotify_uri] };
    if (deviceId) playBody.device_id = deviceId;
    await spotify('put', '/me/player/play', playBody);
  } catch (playErr) {
    console.warn('⚠️  Play falhou, tentando redescobrir dispositivo...', playErr.response?.data?.error?.message || playErr.message);
    // Tenta redescobrir dispositivos (pode ter mudado)
    const devR = await spotify('get', '/me/player/devices').catch(() => null);
    const devices = devR?.data?.devices || [];
    if (devices.length > 0) {
      const active = preferEchoDevice(devices);
      deviceId = active.id;
      await supabase.from('settings').upsert({ key: 'device_id', value: deviceId });
      console.log(`🔊 Dispositivo redescoberto: ${active.name}`);
      await spotify('put', '/me/player', { device_ids: [deviceId], play: false }).catch(() => {});
      await new Promise(r => setTimeout(r, 1000));
      await spotify('put', '/me/player/play', { uris: [song.spotify_uri], device_id: deviceId });
    } else {
      // Último recurso: acorda o Echo Spot via Alexa e toca a música pela voz
      console.log('🎙️  Nenhum dispositivo Connect — tentando via Alexa...');
      const wokenId = await wakeSpotifyViaAlexa(song);
      if (wokenId) {
        // Echo Spot acordou — tenta Connect novamente com ele
        await spotify('put', '/me/player', { device_ids: [wokenId], play: false }).catch(() => {});
        await new Promise(r => setTimeout(r, 800));
        try {
          await spotify('put', '/me/player/play', { uris: [song.spotify_uri], device_id: wokenId });
          deviceId = wokenId;
        } catch {
          // Alexa já está tocando a música pelo textCommand — o monitor vai sincronizar
          console.log('▶️  Tocando via Alexa (textCommand)');
        }
      } else {
        console.error('❌ Nenhum dispositivo Spotify disponível. Abra o Spotify em algum dispositivo.');
        await supabase.from('queue').update({ status: 'pending' }).eq('id', song.id);
        return;
      }
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

async function startAutoPlaylist() {
  if (!autoplayEnabled) {
    console.log('🚫 Autoplay desativado — fila ficará vazia.');
    return;
  }
  try {
    let tracks = [];

    // 1ª opção: top tracks do usuário (personalizado, não depreciado)
    try {
      const r = await spotify('get', '/me/top/tracks?limit=50&time_range=medium_term');
      const pool = r.data?.items || [];
      // Embaralha para não tocar sempre na mesma ordem
      tracks = pool.sort(() => Math.random() - 0.5).slice(0, 20);
    } catch {}

    // 2ª opção: histórico recente de reprodução
    if (tracks.length === 0) {
      try {
        const r = await spotify('get', '/me/player/recently-played?limit=50');
        const seen = new Set();
        tracks = (r.data?.items || [])
          .map(i => i.track)
          .filter(t => t && !seen.has(t.id) && seen.add(t.id))
          .sort(() => Math.random() - 0.5)
          .slice(0, 20);
      } catch {}
    }

    // 3ª opção: playlists em destaque no Brasil (não precisa de escopos extras)
    if (tracks.length === 0) {
      try {
        const r = await spotify('get', '/browse/featured-playlists?country=BR&limit=10&locale=pt_BR');
        const playlists = (r.data?.playlists?.items || []).filter(p => p?.id);
        if (playlists.length > 0) {
          const chosen = playlists[Math.floor(Math.random() * playlists.length)];
          const tr = await spotify('get', `/playlists/${chosen.id}/tracks?limit=50&market=BR`);
          tracks = (tr.data?.items || [])
            .map(i => i.track).filter(t => t?.uri)
            .sort(() => Math.random() - 0.5)
            .slice(0, 20);
          console.log(`🎵 Autoplay: usando playlist "${chosen.name}"`);
        }
      } catch {}
    }

    if (tracks.length === 0) { console.log('🎵 Sem faixas disponíveis para autoplay'); return; }

    // Embaralha e pega 6 faixas
    tracks = tracks.sort(() => Math.random() - 0.5).slice(0, 6);

    // Calcula próximas posições na fila
    const { data: maxPos } = await supabase
      .from('queue').select('position')
      .in('status', ['pending', 'playing'])
      .order('position', { ascending: false }).limit(1);
    let position = (maxPos?.[0]?.position ?? -1) + 1;

    const fmtMs = ms => `${Math.floor(ms/60000)}:${String(Math.floor((ms%60000)/1000)).padStart(2,'0')}`;

    // Insere todas as faixas na fila como pending
    const rows = tracks.map((t, i) => ({
      spotify_uri:  t.uri,
      spotify_id:   t.id,
      title:        t.name,
      artist:       t.artists.map(a => a.name).join(', '),
      album_art:    t.album.images[1]?.url || t.album.images[0]?.url || null,
      requested_by: 'Autoplay 🎲',
      duration_ms:  t.duration_ms,
      duration_str: fmtMs(t.duration_ms),
      position:     position + i,
      status:       'pending',
    }));

    const { data: inserted } = await supabase.from('queue').insert(rows).select();

    // Toca a primeira imediatamente
    if (inserted?.[0]) {
      await startPlaying(inserted[0]);
      console.log(`🎲 Autoplay: ${inserted.length} recomendações adicionadas — tocando "${inserted[0].title}"`);
    }
  } catch (err) {
    console.error('⚠️  Auto-playlist falhou:', err.response?.data?.error?.message || err.message);
  }
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
    await supabase.from('player_state').upsert({
      id: 1, is_playing: false,
      current_song_id: null, current_spotify_id: null,
      updated_at: new Date().toISOString(),
    });

    // Verifica se há playlist ativa continuando
    const [{ data: plId }, { data: plPos }, { data: plTracks }, { data: plName }] = await Promise.all([
      supabase.from('settings').select('value').eq('key', 'active_playlist_id').single(),
      supabase.from('settings').select('value').eq('key', 'active_playlist_pos').single(),
      supabase.from('settings').select('value').eq('key', 'active_playlist_tracks').single(),
      supabase.from('settings').select('value').eq('key', 'active_playlist_name').single(),
    ]);

    if (plId?.value && plTracks?.value) {
      try {
        const tracks = JSON.parse(plTracks.value);
        const pos    = parseInt(plPos?.value || '0');
        if (pos < tracks.length) {
          const track = tracks[pos];
          await supabase.from('settings').upsert({ key: 'active_playlist_pos', value: String(pos + 1) });
          const { data: maxPos } = await supabase.from('queue').select('position').in('status',['pending','playing']).order('position',{ascending:false}).limit(1);
          const position = (maxPos?.[0]?.position ?? -1) + 1;
          const { data: inserted } = await supabase.from('queue').insert({
            spotify_uri: track.uri, spotify_id: track.id,
            title: track.title, artist: track.artist, album_art: track.album_art,
            requested_by: `📋 ${plName?.value || 'Playlist'}`,
            duration_ms: track.duration_ms, duration_str: track.duration_str,
            position, status: 'pending',
          }).select().single();
          if (inserted) { await startPlaying(inserted); return; }
        } else {
          // Playlist terminou — limpa estado
          await supabase.from('settings').delete().in('key', ['active_playlist_id','active_playlist_name','active_playlist_tracks','active_playlist_pos']);
          console.log(`📋 Playlist "${plName?.value}" terminou`);
        }
      } catch (e) { console.error('⚠️  active_playlist:', e.message); }
    }

    console.log('🎵 Fila vazia — iniciando autoplay...');
    await startAutoPlaylist();
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
let lastProgressMs     = 0;     // último progress_ms conhecido (atualizado durante playing)

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
        // Verifica diretamente na fila se havia uma música marcada como playing
        // (NÃO confia no is_playing do banco — pode já estar false por causa
        //  do handler de pausa que dispara antes do 204 quando a música acaba)
        const { data: playingSong } = await supabase
          .from('queue')
          .select('id')
          .eq('status', 'playing')
          .maybeSingle();

        if (playingSong) {
          // Havia música da fila tocando → avança para a próxima
          console.log('🎵 Playback parou (204) — avançando fila...');
          await advanceQueue('auto');
        } else {
          // Nenhuma música da fila (playlist externa acabou) → toca nova playlist
          await supabase.from('player_state').upsert({
            id: 1, is_playing: false,
            current_song_id: null, current_spotify_id: null,
            updated_at: new Date().toISOString(),
          });
          console.log('🎵 Playback externo encerrado — iniciando auto-play de playlist...');
          await startAutoPlaylist();
        }
      }
      lastKnownSpotifyId = null;
      lastQueueSongId    = null;
      nearEndTriggered   = false;
      wasPlaying         = false;
      progressCache      = { data: { progress_ms: 0, is_playing: false }, at: Date.now() };
      return;
    }

    const { item, progress_ms, is_playing } = r.data;
    const spotifyId = item.id;
    const remaining = item.duration_ms - progress_ms;

    // ── Pausado ───────────────────────────────────────────
    if (!is_playing) {
      if (wasPlaying) {
        // Spotify congela progress_ms no último valor poll'd quando a música acaba.
        // Por isso combinamos 3 sinais para detectar fim natural:
        // 1. remaining atual ≤ 3s (progress chegou ao fim)
        // 2. lastProgressMs estava ≤ 8s do fim no último tick playing
        // 3. nearEndTriggered foi setado (estava ≤ 8s do fim)
        const remainingAtLastPoll = item.duration_ms - lastProgressMs;
        const songEndedNaturally  = remaining <= 3000
                                 || (lastProgressMs > 0 && remainingAtLastPoll <= 8000)
                                 || nearEndTriggered;

        if (songEndedNaturally) {
          console.log(`🎵 Música terminou (remaining=${remaining}ms, lastPoll=${remainingAtLastPoll}ms, nearEnd=${nearEndTriggered}) — avançando fila...`);
          wasPlaying         = false;
          nearEndTriggered   = false;
          lastKnownSpotifyId = null;
          lastQueueSongId    = null;
          lastProgressMs     = 0;
          await advanceQueue('auto');
          return;
        }
        // Pausa manual no meio da música
        await supabase.from('player_state').upsert({
          id: 1, is_playing: false,
          updated_at: new Date().toISOString(),
        });
      }
      wasPlaying    = false;
      progressCache = { data: { progress_ms: progress_ms || 0, is_playing: false }, at: Date.now() };
      return;
    }

    // ── Tocando ───────────────────────────────────────────
    wasPlaying     = true;
    lastProgressMs = progress_ms;
    progressCache  = { data: { progress_ms, is_playing: true }, at: Date.now() };

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
    if (status && [400, 401, 404, 429].includes(status)) return;
    console.error('⚠️  Monitor:', err.response?.data?.error?.message || err.message);
  }
}

setInterval(monitorPlayback, 4000);
console.log('🔁 Monitor de playback iniciado (4s) — sincroniza Spotify + Alexa em tempo real');

// ═══════════════════════════════════════════════════════
// FATURAMENTO — Relatório de Consumo (7Benefícios)
// ═══════════════════════════════════════════════════════
const multer   = require('multer');
const XLSX     = require('xlsx');
const { chromium } = require('playwright');
const nodePath = require('path');
const nodeFs   = require('fs');
const nodeOs   = require('os');

const fatUpload = multer({ storage: multer.memoryStorage() });
const fatJobs   = new Map(); // jobId → { status, logs, total, message }

const fatLog = (jobId, text, type = 'normal') => {
  const j = fatJobs.get(jobId);
  if (j) j.logs.push({ text: `[${new Date().toLocaleTimeString('pt-BR')}] ${text}`, type });
};

const normStr = (s) =>
  String(s || '').toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ').trim();

// ── Scrape all organizations from 7Benefícios (infinite scroll) ──
async function scrapeOrgs(page) {
  await page.goto('https://app.7beneficiosgestao.com.br/organizations');
  await page.waitForSelector('table tbody tr', { timeout: 15000 });

  const orgMap = {};
  let noChangeRounds = 0;
  let lastCount = 0;

  while (noChangeRounds < 3) {
    const scraped = await page.evaluate(() =>
      Array.from(document.querySelectorAll('table tbody tr')).map(row => {
        const name = row.querySelector('td')?.textContent?.trim();
        const uuid = Array.from(row.querySelectorAll('a[href]'))
          .map(a => a.getAttribute('href').match(/organizations\/([a-f0-9-]{36})/)?.[1])
          .find(Boolean);
        return name && uuid ? { name, uuid } : null;
      }).filter(Boolean)
    );
    scraped.forEach(({ name, uuid }) => { orgMap[name] = uuid; });

    const count = Object.keys(orgMap).length;
    if (count === lastCount) noChangeRounds++;
    else { noChangeRounds = 0; lastCount = count; }

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(900);
  }
  return orgMap;
}

// ── Match org UUID by municipality name extracted from "Cliente" column ──
function findOrgUUID(orgMap, exampleCliente) {
  const parts         = exampleCliente.split(' - ');
  const municipioFull = parts[parts.length - 1]?.trim() || ''; // "MUNICIPIO DE JAGUARETAMA"
  const cityName      = parts[1]?.trim() || '';                 // "JAGUARETAMA"
  const nFull         = normStr(municipioFull);
  const nCity         = normStr(cityName);

  for (const [name, uuid] of Object.entries(orgMap)) {
    const nName = normStr(name);
    if (nName === nFull || (nCity && nName.includes(nCity))) return { uuid, orgName: name };
  }
  return null;
}

// ── Download PDFs for all secretarias of one municipality ──
async function runConsumoDownload({ jobId, username, password, startDate, endDate, category, downloadItems, outputPath }) {
  const log = (text, type = 'normal') => fatLog(jobId, text, type);
  const job = fatJobs.get(jobId);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page    = await context.newPage();

  try {
    // ── Login ──
    log('Acessando 7Benefícios...');
    await page.goto('https://app.7beneficiosgestao.com.br/sessions/new');
    await page.getByRole('textbox', { name: 'Nome de Usuário' }).fill(username);
    await page.getByRole('textbox', { name: 'Senha' }).fill(password);
    await page.getByRole('button', { name: 'Acessar' }).click();
    await page.waitForFunction(() => !location.href.includes('sessions/new'), { timeout: 15000 })
      .catch(() => null);

    if (page.url().includes('sessions/new')) {
      log('Login falhou. Verifique usuário e senha.', 'error');
      job.status = 'error'; job.message = 'Login falhou';
      await browser.close(); return;
    }
    log('Login realizado.', 'ok');

    // ── Scrape orgs ──
    log('Carregando organizações (pode levar alguns segundos)...');
    const orgMap = await scrapeOrgs(page);
    log(`${Object.keys(orgMap).length} organizações carregadas.`);

    // ── Find org UUID ──
    const found = findOrgUUID(orgMap, downloadItems[0]?.clienteStr || '');
    if (!found) {
      const city = (downloadItems[0]?.clienteStr || '').split(' - ')[1] || '?';
      log(`Organização "${city}" não encontrada na lista. Verifique o nome.`, 'error');
      job.status = 'error'; await browser.close(); return;
    }
    log(`Organização: ${found.orgName}`, 'ok');

    // ── Ensure output folder ──
    const outDir = outputPath?.trim()
      || nodePath.join(nodeOs.homedir(), 'Downloads', 'RelatorioConsumo');
    if (!nodeFs.existsSync(outDir)) nodeFs.mkdirSync(outDir, { recursive: true });

    let downloaded = 0;

    for (const { clienteStr, setor } of downloadItems) {
      const parts   = String(clienteStr).split(' - ');
      const secNome = parts[2]?.trim() || clienteStr;
      const label   = setor ? `${secNome} / ${setor}` : secNome;

      log(`Processando: ${label}...`);
      try {
        // Navigate to base page (with category + status + dates so dropdowns load correctly)
        await page.goto(
          `https://app.7beneficiosgestao.com.br/organizations/${found.uuid}/transactions_report` +
          `?category=${category}&status=authorized&starting_date=${encodeURIComponent(startDate)}&ending_date=${encodeURIComponent(endDate)}`
        );
        await page.waitForSelector('select', { timeout: 10000 });

        // ── Select client from custom dropdown ──
        const clientOptions = await page.evaluate(() => {
          const sel = document.querySelector('.select select') || document.querySelector('select');
          return sel ? Array.from(sel.options).map(o => ({ value: o.value, text: o.text.trim() })) : [];
        });

        const nSec       = normStr(secNome);
        const clientMatch = clientOptions.find(o => normStr(o.text).includes(nSec));
        if (!clientMatch?.value) {
          log(`Secretaria não encontrada no sistema: ${secNome}`, 'error'); continue;
        }

        // Select client via native select (most reliable)
        await page.evaluate((val) => {
          const sel = document.querySelector('.select select') || document.querySelector('select');
          if (sel) { sel.value = val; sel.dispatchEvent(new Event('change', { bubbles: true })); }
        }, clientMatch.value);
        await page.waitForTimeout(600);

        // ── Select sector if provided ──
        let divisionId = '';
        if (setor) {
          const divOptions = await page.evaluate(() => {
            const sel = document.querySelector('select[name="division_id"]');
            return sel ? Array.from(sel.options).map(o => ({ value: o.value, text: o.text.trim() })) : [];
          });
          const nSetor   = normStr(setor);
          const divMatch = divOptions.find(o => o.value && normStr(o.text).includes(nSetor));
          if (divMatch?.value) {
            await page.evaluate((val) => {
              const sel = document.querySelector('select[name="division_id"]');
              if (sel) { sel.value = val; sel.dispatchEvent(new Event('change', { bubbles: true })); }
            }, divMatch.value);
            divisionId = divMatch.value;
            await page.waitForTimeout(400);
          } else {
            log(`Setor "${setor}" não encontrado no sistema (continuando sem setor)`, 'normal');
          }
        }

        // ── Navigate to URL with all params ──
        const params = new URLSearchParams({
          client_id:     clientMatch.value,
          provider_id:   '',
          division_id:   divisionId,
          category,
          product_id:    '',
          status:        'authorized',
          starting_date: startDate,
          ending_date:   endDate,
          license_plate: '',
        });
        await page.goto(
          `https://app.7beneficiosgestao.com.br/organizations/${found.uuid}/transactions_report?${params}`
        );
        await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => null);

        // ── Extract Relatório ──
        const extractBtn = page.getByRole('link', { name: 'Extrair Relatório' }).first();
        const hasBtn     = await extractBtn.isVisible().catch(() => false);
        if (!hasBtn) { log(`Sem resultados para: ${label}`, 'normal'); continue; }

        const [, download] = await Promise.all([
          page.waitForEvent('popup').catch(() => null),
          page.waitForEvent('download', { timeout: 30000 }),
          extractBtn.click(),
        ]);

        const safeName = label.replace(/[/\\?%*:|"<>]/g, '_').substring(0, 100);
        const filePath  = nodePath.join(outDir, `${safeName}.pdf`);
        await download.saveAs(filePath);

        downloaded++;
        log(`✓ Salvo: ${safeName}.pdf`, 'ok');

      } catch (err) {
        log(`Erro em "${label}": ${err.message}`, 'error');
      }
    }

    job.status = 'done';
    job.total  = downloaded;
    log(`Concluído! ${downloaded}/${downloadItems.length} PDF(s) salvo(s) em ${outDir}`, 'ok');

  } catch (err) {
    log(`Erro inesperado: ${err.message}`, 'error');
    job.status = 'error'; job.message = err.message;
  } finally {
    await browser.close();
  }
}

// ── Routes ──
app.post('/api/faturamento/consumo/download',
  requireAuth,
  fatUpload.fields([{ name: 'mainFile', maxCount: 1 }]),
  async (req, res) => {
    const { username, password, startDate, endDate, category, downloadItems, outputPath } = req.body;
    if (!req.files?.mainFile || !username || !password || !startDate || !endDate) {
      return res.status(400).json({ error: 'Parâmetros obrigatórios ausentes' });
    }
    const jobId = require('crypto').randomUUID();
    fatJobs.set(jobId, { status: 'running', logs: [], total: 0 });
    res.json({ jobId });
    runConsumoDownload({
      jobId, username, password, startDate, endDate,
      category: category || 'fuel',
      downloadItems: JSON.parse(downloadItems || '[]'),
      outputPath,
    }).catch(err => {
      const j = fatJobs.get(jobId);
      if (j) { j.status = 'error'; j.message = err.message; j.logs.push({ text: `Erro fatal: ${err.message}`, type: 'error' }); }
      console.error('Faturamento error:', err);
    });
  }
);

app.get('/api/faturamento/consumo/status/:jobId', requireAuth, (req, res) => {
  const job = fatJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job não encontrado' });
  res.json({ status: job.status, logs: job.logs, total: job.total, message: job.message });
});

// ═══════════════════════════════════════════════════════
// YT-DLP — Download de vídeo para o Uniko Wave
// ═══════════════════════════════════════════════════════
const YT_ID_RE   = /^[a-zA-Z0-9_-]{11}$/;
const ytdlpJobs  = new Map(); // videoId → { status, path }

function scheduleVideoCleanup(videoId) {
  setTimeout(() => {
    const job = ytdlpJobs.get(videoId);
    ytdlpJobs.delete(videoId);
    if (job?.path && fs.existsSync(job.path)) fs.unlink(job.path, () => {});
  }, 25 * 60 * 1000); // 25 min
}

// Inicia o download (re-dispara se job anterior falhou)
app.post('/api/ytdl/download', (req, res) => {
  const { videoId } = req.body;
  if (!videoId || !YT_ID_RE.test(videoId))
    return res.status(400).json({ error: 'videoId inválido' });
  if (!ytdlpReady)
    return res.status(503).json({ error: 'yt-dlp não está pronto ainda' });

  const existing = ytdlpJobs.get(videoId);
  // Se já existe e NÃO é erro, retorna o status atual
  if (existing && existing.status !== 'error') return res.json({ status: existing.status });
  // Se havia erro, limpa o arquivo antigo e reinicia
  if (existing?.path && fs.existsSync(existing.path)) fs.unlink(existing.path, () => {});

  // Usa %(ext)s para aceitar qualquer formato (mp4, webm, etc.)
  const outTemplate = `/tmp/uw_${videoId}.%(ext)s`;
  const job = { status: 'downloading', path: null };
  ytdlpJobs.set(videoId, job);
  scheduleVideoCleanup(videoId, null);

  const ytdlpArgs = [
    // Tenta vídeo-only MP4, depois webm, depois combined — aceita qualquer coisa como último recurso
    '-f', [
      'bestvideo[height<=480][ext=mp4]',
      'bestvideo[height<=360][ext=mp4]',
      'bestvideo[ext=mp4]',
      'bestvideo[height<=480][ext=webm]',
      'bestvideo[height<=480]',
      'bestvideo',
      'best[height<=480][ext=mp4]',
      'best[ext=mp4]',
      'best[height<=480]',
      'best',
    ].join('/'),
    '--no-playlist', '--no-part', '--no-warnings',
    '--extractor-args', 'youtube:player_client=ios,mweb,web_embedded',
  ];
  if (ytCookiesOk) {
    ytdlpArgs.push('--cookies', YTCOOKIES_FILE);
    console.log(`🍪 usando cookies para ${videoId}`);
  } else {
    console.warn(`⚠️  sem cookies — download pode falhar para ${videoId}`);
  }
  ytdlpArgs.push('-o', outTemplate, `https://www.youtube.com/watch?v=${videoId}`);
  const proc = spawn(YTDLP_BIN, ytdlpArgs);
  let stderrBuf = '';
  proc.stderr.on('data', (d) => { if (stderrBuf.length < 2000) stderrBuf += d.toString(); });
  proc.stdout.on('data', (d) => console.log(`yt-dlp [${videoId}]:`, d.toString().trim()));
  proc.on('close', (code) => {
    if (code === 0) {
      // Descobre qual extensão o yt-dlp escolheu (mp4, webm, etc.)
      const files = fs.readdirSync('/tmp').filter(f => f.startsWith(`uw_${videoId}.`));
      if (files.length > 0) {
        job.path = `/tmp/${files[0]}`;
        job.ext  = files[0].split('.').pop();
        job.status = 'ready';
        console.log(`✓ vídeo ${videoId} pronto (${job.ext})`);
      } else {
        job.status = 'error'; job.errorMsg = 'arquivo não encontrado após download';
      }
    } else {
      job.status = 'error';
      const errSnippet = stderrBuf.replace(/\s+/g, ' ').trim().slice(0, 600);
      job.errorMsg = errSnippet;
      console.error(`✗ yt-dlp falhou [${videoId}]:`, errSnippet);
    }
  });
  proc.on('error', (e) => { job.status = 'error'; job.errorMsg = e.message; });

  res.json({ status: 'downloading' });
});

// Consulta status do download
app.get('/api/ytdl/status/:videoId', (req, res) => {
  const { videoId } = req.params;
  if (!YT_ID_RE.test(videoId)) return res.status(400).json({ error: 'ID inválido' });
  const job = ytdlpJobs.get(videoId);
  const resp = { status: job ? job.status : 'not_found' };
  if (job && job.errorMsg) resp.errorMsg = job.errorMsg.slice(-200);
  res.json(resp);
});

// Recebe cookies do YouTube enviados pelo Catbot (extensão Chrome)
app.post('/api/ytdl/set-cookies', (req, res) => {
  const auth = req.headers['authorization'];
  if (auth !== 'Bearer uniko-ytcookies') return res.status(401).json({ error: 'não autorizado' });
  const { cookies } = req.body;
  if (!cookies || typeof cookies !== 'string' || cookies.length < 20)
    return res.status(400).json({ error: 'cookies inválido' });
  try {
    fs.writeFileSync(YTCOOKIES_FILE, cookies, 'utf8');
    ytCookiesOk = true;
    console.log(`🍪 Cookies do YouTube atualizados via Catbot (${cookies.split('\n').length} linhas).`);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Serve o arquivo de vídeo (com suporte a byte-range para o browser)
app.get('/api/ytdl/serve/:videoId', (req, res) => {
  const { videoId } = req.params;
  if (!YT_ID_RE.test(videoId)) return res.status(400).end();
  const job = ytdlpJobs.get(videoId);
  if (!job || job.status !== 'ready' || !job.path) return res.status(404).end();
  const filePath = job.path;
  if (!fs.existsSync(filePath)) return res.status(404).end();

  const contentType = (job.ext === 'webm') ? 'video/webm' : 'video/mp4';
  const stat  = fs.statSync(filePath);
  const total = stat.size;
  const range = req.headers.range;

  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr, 10);
    const end   = endStr ? parseInt(endStr, 10) : total - 1;
    res.writeHead(206, {
      'Content-Range':  `bytes ${start}-${end}/${total}`,
      'Accept-Ranges':  'bytes',
      'Content-Length': end - start + 1,
      'Content-Type':   contentType,
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': total,
      'Content-Type':   contentType,
      'Accept-Ranges':  'bytes',
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

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