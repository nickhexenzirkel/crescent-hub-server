// ════════════════════════════════════════════════════════
// UNIKO SECURITY — Backup criptografado das conversas (texto + mídia
// embutida em base64, pra ser um arquivo autocontido de verdade). Formato
// próprio (.ukbak), ilegível fora do Uniko: quem tenta abrir em outro
// programa vê só bytes cifrados — só este servidor tem a chave
// (UNIKO_SECURITY_BACKUP_KEY, AES-256-GCM) pra decifrar.
//
// Três jeitos de gerar:
//  • Manual, tudo de uma vez (admin, "Mais opções" → Backup completo)
//  • Manual, de 1 contato só (dentro da conversa aberta)
//  • Automático, mensal (cron, dia 1 às 03:00) — fica guardado no bucket
//    PRIVADO uniko-security-backups-auto (nunca público, ao contrário do
//    uniko-security-media: um backup completo é muito mais sensível que uma
//    mídia isolada), com histórico dos últimos 12 na tabela
//    uniko_security_backups. Ver supabase_uniko_security_backup.sql.
//
// Geração roda em BACKGROUND (mesmo padrão "job" já usado no Safer/
// Faturamento: POST inicia e devolve jobId na hora, GET consulta status e
// baixa quando pronto) — evita a requisição travar esperando baixar toda
// mídia de todo mundo antes de responder.
// ════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const zlib   = require('zlib');
const fs     = require('fs');
const fsp    = require('fs/promises');
const os     = require('os');
const path   = require('path');
const multer = require('multer');
const cron   = require('node-cron');

const BACKUP_KEY = process.env.UNIKO_SECURITY_BACKUP_KEY
  ? Buffer.from(process.env.UNIKO_SECURITY_BACKUP_KEY, 'hex')
  : null; // 32 bytes (64 hex chars) — gerar com `openssl rand -hex 32`
const MAGIC = Buffer.from('UKB1'); // versão do formato do arquivo

let supabaseSecurity = null;
if (process.env.UNIKO_SECURITY_SUPABASE_URL && process.env.UNIKO_SECURITY_SUPABASE_SERVICE_KEY) {
  supabaseSecurity = createClient(
    process.env.UNIKO_SECURITY_SUPABASE_URL,
    process.env.UNIKO_SECURITY_SUPABASE_SERVICE_KEY
  );
}
if (!BACKUP_KEY) {
  console.warn('[uniko-security-backup] UNIKO_SECURITY_BACKUP_KEY não configurada — backup fica indisponível (gerar/ler devolve erro 500).');
}

// Envelope: [4 bytes "UKB1"][12 bytes IV][16 bytes auth tag][ciphertext].
// Comprime (gzip) ANTES de cifrar — texto de conversa comprime bem, e ainda
// ajuda um pouco na mídia (metadados/JSON ao redor do base64).
function encryptBackup(jsonObj) {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(jsonObj)));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', BACKUP_KEY, iv);
  const enc = Buffer.concat([cipher.update(gz), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), enc]);
}

function decryptBackup(buf) {
  if (buf.length < 32 || !buf.subarray(0, 4).equals(MAGIC)) throw new Error('arquivo não é um backup válido do Uniko Security');
  const iv  = buf.subarray(4, 16);
  const tag = buf.subarray(16, 32);
  const enc = buf.subarray(32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', BACKUP_KEY, iv);
  decipher.setAuthTag(tag);
  const gz = Buffer.concat([decipher.update(enc), decipher.final()]);
  return JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
}

// Busca contatos + mensagens (e baixa cada mídia referenciada, embutindo em
// base64 — o backup fica autocontido, não depende do bucket público
// continuar existindo pra sempre).
// `onProgress(done, total)` — chamado a cada contato processado, pra dar pra
// mostrar uma barra de verdade na tela (backup completo com mídia demora
// bastante, achado ao vivo 24/set/2026 — sem isso o admin fica olhando um
// texto parado "Gerando backup completo…" sem saber se travou ou não).
async function buildBackupPayload({ scope, contactId }, onProgress) {
  let q = supabaseSecurity.from('uniko_security_contacts').select('*').order('name');
  if (scope === 'contact') q = q.eq('id', contactId);
  const { data: contacts, error: ce } = await q;
  if (ce) throw new Error(ce.message);

  const total = contacts?.length || 0;
  let done = 0;
  onProgress?.(done, total);

  const out = [];
  for (const c of contacts || []) {
    const { data: msgs, error: me } = await supabaseSecurity.from('uniko_security_messages')
      .select('sent_at,direction,sender_name,text,msg_type,media_url,media_mime')
      .eq('contact_id', c.id).order('sent_at');
    if (me) throw new Error(me.message);

    const messages = [];
    for (const m of msgs || []) {
      let mediaBase64 = null;
      if (m.media_url) {
        try {
          const r = await fetch(m.media_url);
          if (r.ok) mediaBase64 = Buffer.from(await r.arrayBuffer()).toString('base64');
        } catch (e) {
          console.error(`[uniko-security-backup] falha ao baixar mídia da mensagem (contato ${c.id}):`, e.message);
        }
      }
      messages.push({
        sentAt: m.sent_at, direction: m.direction, senderName: m.sender_name,
        text: m.text, msgType: m.msg_type, mediaBase64, mediaMime: m.media_mime,
      });
    }
    out.push({ id: c.id, waId: c.wa_id, name: c.name, category: c.category, notes: c.notes, messages });
    done++;
    onProgress?.(done, total);
  }
  return { version: 1, generatedAt: new Date().toISOString(), scope, contactId: contactId || null, contacts: out };
}

// jobId → { status: 'running'|'done'|'error', error, filePath, createdAt }
const jobs = new Map();
const newJobId = () => crypto.randomBytes(8).toString('hex');
const TMP_DIR = path.join(os.tmpdir(), 'uniko-security-backups');

module.exports = function registerBackupRoutes(app, { requireAdmin }) {
  app.post('/api/security/backup/start', requireAdmin, (req, res) => {
    if (!BACKUP_KEY || !supabaseSecurity) return res.status(500).json({ error: 'Backup não configurado no servidor (falta UNIKO_SECURITY_BACKUP_KEY ou Supabase).' });
    const { scope, contactId } = req.body || {};
    if (scope !== 'all' && scope !== 'contact') return res.status(400).json({ error: 'scope inválido' });
    if (scope === 'contact' && !contactId) return res.status(400).json({ error: 'contactId obrigatório pra scope=contact' });

    const jobId = newJobId();
    jobs.set(jobId, { status: 'running', error: null, filePath: null, createdAt: Date.now(), progress: { done: 0, total: 0 } });
    res.json({ jobId });

    (async () => {
      try {
        const payload = await buildBackupPayload({ scope, contactId }, (done, total) => {
          const job = jobs.get(jobId);
          if (job) job.progress = { done, total };
        });
        const buf = encryptBackup(payload);
        await fsp.mkdir(TMP_DIR, { recursive: true });
        const filePath = path.join(TMP_DIR, `${jobId}.ukbak`);
        await fsp.writeFile(filePath, buf);
        jobs.set(jobId, { status: 'done', error: null, filePath, createdAt: Date.now() });
      } catch (e) {
        console.error('[uniko-security-backup] falha ao gerar backup:', e.message);
        jobs.set(jobId, { status: 'error', error: e.message, filePath: null, createdAt: Date.now() });
      }
    })();
  });

  app.get('/api/security/backup/status/:jobId', requireAdmin, (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'job não encontrado (pode já ter expirado — baixe em até 1h)' });
    res.json({ status: job.status, error: job.error, progress: job.progress || null });
  });

  app.get('/api/security/backup/download/:jobId', requireAdmin, (req, res) => {
    const job = jobs.get(req.params.jobId);
    if (!job || job.status !== 'done' || !job.filePath) return res.status(404).json({ error: 'backup ainda não está pronto' });
    res.download(job.filePath, `uniko-security-backup-${req.params.jobId}.ukbak`, () => {
      fsp.unlink(job.filePath).catch(() => {});
      jobs.delete(req.params.jobId);
    });
  });

  // Limpa jobs prontos que ninguém baixou (evita lixo acumulando em disco).
  setInterval(() => {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (now - job.createdAt > 60 * 60 * 1000) {
        if (job.filePath) fsp.unlink(job.filePath).catch(() => {});
        jobs.delete(id);
      }
    }
  }, 15 * 60 * 1000);

  // Importar/ler um .ukbak baixado antes — só este servidor sabe decifrar.
  // Limite generoso (2GB) — achado ao vivo 24/set/2026: um backup completo
  // com mídia de verdade passa longe dos 300MB do limite antigo. Multer
  // rejeitando por tamanho ANTES da rota rodar fazia a conexão morrer sem
  // resposta HTTP de verdade — o navegador reportava isso como "bloqueado
  // pelo CORS" (sintoma enganoso comum: falha de baixo nível vira erro de
  // CORS na tela, mesmo o CORS estando configurado certo). Agora o erro do
  // multer é pego explicitamente e vira uma resposta JSON normal.
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 * 1024 } });
  app.post('/api/security/backup/decrypt', requireAdmin, (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (!err) return next();
      console.error('[uniko-security-backup] falha no upload pra decifrar:', err.message);
      res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Arquivo maior que o limite permitido (2GB).' : `Falha no upload: ${err.message}` });
    });
  }, async (req, res) => {
    if (!BACKUP_KEY) return res.status(500).json({ error: 'Backup não configurado no servidor.' });
    if (!req.file) return res.status(400).json({ error: 'nenhum arquivo recebido' });
    try {
      const data = decryptBackup(req.file.buffer);
      if (supabaseSecurity) {
        supabaseSecurity.from('uniko_security_access_log').insert({
          viewer_name: req.user?.name || null, viewer_role: req.user?.role || null,
          action: 'view', details: `Importou backup (${data.scope === 'all' ? 'completo' : `1 contato`}, gerado em ${data.generatedAt})`,
        }).then(() => {}, () => {});
      }
      res.json(data);
    } catch (e) {
      res.status(400).json({ error: 'Não foi possível abrir esse arquivo: ' + e.message });
    }
  });

  // Histórico dos backups automáticos mensais já guardados.
  app.get('/api/security/backup/auto/list', requireAdmin, async (req, res) => {
    if (!supabaseSecurity) return res.json([]);
    const { data, error } = await supabaseSecurity.from('uniko_security_backups').select('*').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  });

  app.get('/api/security/backup/auto/:id/download', requireAdmin, async (req, res) => {
    if (!supabaseSecurity) return res.status(500).json({ error: 'não configurado' });
    const { data: row, error } = await supabaseSecurity.from('uniko_security_backups').select('*').eq('id', req.params.id).maybeSingle();
    if (error || !row) return res.status(404).json({ error: 'backup não encontrado' });
    const { data, error: dlErr } = await supabaseSecurity.storage.from('uniko-security-backups-auto').download(row.path);
    if (dlErr) return res.status(500).json({ error: dlErr.message });
    res.setHeader('Content-Disposition', `attachment; filename="${row.path}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.send(Buffer.from(await data.arrayBuffer()));
  });

  // Backup automático mensal — dia 1, 03:00 (horário do servidor). Mantém só
  // os últimos 12 (apaga o arquivo do Storage E a linha da tabela).
  cron.schedule('0 3 1 * *', async () => {
    if (!supabaseSecurity || !BACKUP_KEY) return;
    try {
      const payload = await buildBackupPayload({ scope: 'all' });
      const buf = encryptBackup(payload);
      const fileName = `${new Date().toISOString().slice(0, 10)}.ukbak`;
      const { error: upErr } = await supabaseSecurity.storage.from('uniko-security-backups-auto')
        .upload(fileName, buf, { contentType: 'application/octet-stream', upsert: true });
      if (upErr) throw new Error(upErr.message);
      await supabaseSecurity.from('uniko_security_backups').insert({ path: fileName, size_bytes: buf.length });

      const { data: old } = await supabaseSecurity.from('uniko_security_backups').select('id,path').order('created_at', { ascending: false });
      for (const row of (old || []).slice(12)) {
        await supabaseSecurity.storage.from('uniko-security-backups-auto').remove([row.path]);
        await supabaseSecurity.from('uniko_security_backups').delete().eq('id', row.id);
      }
      console.log(`[uniko-security-backup] backup automático mensal ok: ${fileName} (${(buf.length / 1024 / 1024).toFixed(1)}MB)`);
    } catch (e) {
      console.error('[uniko-security-backup] backup automático mensal falhou:', e.message);
    }
  });
};
