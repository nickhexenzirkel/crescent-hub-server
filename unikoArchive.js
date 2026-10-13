// ════════════════════════════════════════════════════════
// UNIKO SECURITY + UNIKO CALL — Arquivo anual (.ukarq)
//
// Objetivo: não estourar o limite do Supabase. Por ano, o admin:
//   1) BAIXA um arquivo criptografado (AES-256-GCM, mesma chave do backup
//      UNIKO_SECURITY_BACKUP_KEY) com as conversas/ligações do ano — texto,
//      mídia e áudio embutidos. Só este servidor sabe decifrar.
//   2) EXCLUI os dados desse ano do Supabase (libera banco + Storage).
//   3) Se precisar, IMPORTA o arquivo de volta: os dados do ano voltam pro
//      banco (sem duplicar o que já estiver lá) e a mídia volta pro Storage.
//
// Formato em QUADROS (diferente do .ukbak, que é um JSON único em memória):
// um ano de mídia pode passar de GBs, então o arquivo é uma sequência de
// quadros [u32 tamanho][IV 12][tag 16][ciphertext(gzip(JSON))], escritos e
// lidos um de cada vez — nunca o arquivo inteiro na RAM. Cada quadro tem a
// própria tag GCM: arquivo adulterado/cortado é recusado.
//
// Segurança da exclusão: só apaga um ano que foi EXPORTADO por este servidor
// nas últimas 12h (e só até o maior id exportado — nada que chegou depois do
// backup é apagado). Reiniciou o servidor? É só exportar de novo.
// ════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const zlib   = require('zlib');
const fs     = require('fs');
const fsp    = require('fs/promises');
const os     = require('os');
const path   = require('path');
const multer = require('multer');

const KEY = process.env.UNIKO_SECURITY_BACKUP_KEY ? Buffer.from(process.env.UNIKO_SECURITY_BACKUP_KEY, 'hex') : null;
const MAGIC = Buffer.from('UKA1');
const TMP_DIR = path.join(os.tmpdir(), 'uniko-archive');

let sb = null;
if (process.env.UNIKO_SECURITY_SUPABASE_URL && process.env.UNIKO_SECURITY_SUPABASE_SERVICE_KEY) {
  sb = createClient(process.env.UNIKO_SECURITY_SUPABASE_URL, process.env.UNIKO_SECURITY_SUPABASE_SERVICE_KEY);
}

const SECURITY_BUCKET = 'uniko-security-media';
const CALL_BUCKET = 'uniko-call';
const FRAME_TARGET = 20 * 1024 * 1024; // fecha o quadro de mensagens ao passar de ~20MB (base64 incluso)

// Ano no horário de Brasília (UTC-3) — "2025" pra quem usa é 01/01 00:00 a 31/12 23:59 daqui.
const yearRange = (year) => [`${year}-01-01T00:00:00-03:00`, `${Number(year) + 1}-01-01T00:00:00-03:00`];
const validYear = (y) => /^\d{4}$/.test(String(y)) && Number(y) >= 2000 && Number(y) <= 2100;

// ── Quadros cifrados ──────────────────────────────────────
function sealFrame(obj) {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(gz), c.final()]);
  const body = Buffer.concat([iv, c.getAuthTag(), enc]);
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
  return Buffer.concat([len, body]);
}
function openFrame(body) {
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, body.subarray(0, 12));
  d.setAuthTag(body.subarray(12, 28));
  const gz = Buffer.concat([d.update(body.subarray(28)), d.final()]);
  return JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
}
async function* readFrames(filePath) {
  const fh = await fsp.open(filePath, 'r');
  try {
    const magic = Buffer.alloc(4);
    await fh.read(magic, 0, 4, 0);
    if (!magic.equals(MAGIC)) throw new Error('arquivo não é um arquivo anual do Uniko');
    let pos = 4;
    const { size } = await fh.stat();
    while (pos < size) {
      const lenBuf = Buffer.alloc(4);
      await fh.read(lenBuf, 0, 4, pos);
      const len = lenBuf.readUInt32BE();
      if (len < 28 || pos + 4 + len > size) throw new Error('arquivo cortado ou corrompido');
      const body = Buffer.alloc(len);
      await fh.read(body, 0, len, pos + 4);
      yield openFrame(body); // GCM recusa quadro adulterado
      pos += 4 + len;
    }
  } finally { await fh.close(); }
}

// ── Mídia ─────────────────────────────────────────────────
const pathFromUrl = (bucket, url) => {
  if (!url) return null;
  const marker = `/${bucket}/`;
  const i = url.indexOf(marker);
  return i === -1 ? null : decodeURIComponent(url.slice(i + marker.length).split('?')[0]);
};
async function fetchBase64(url) {
  if (!url) return null;
  try {
    const r = await fetch(url);
    if (r.ok) return Buffer.from(await r.arrayBuffer()).toString('base64');
  } catch (e) { console.error('[uniko-archive] falha ao baixar mídia:', e.message); }
  return null;
}
async function removeFiles(bucket, paths) {
  const list = paths.filter(Boolean);
  for (let i = 0; i < list.length; i += 100) {
    const { error } = await sb.storage.from(bucket).remove(list.slice(i, i + 100));
    if (error) console.error('[uniko-archive] falha ao remover arquivos do Storage:', error.message);
  }
}

// ── Paginação (o Supabase corta em 1000 linhas por consulta) ──
async function* pages(buildQuery, pageSize = 500) {
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) return;
    yield data;
    if (data.length < pageSize) return;
  }
}
const countRows = async (table, col, year) => {
  const [a, b] = yearRange(year);
  const { count, error } = await sb.from(table).select('id', { count: 'exact', head: true }).gte(col, a).lt(col, b);
  if (error) throw new Error(error.message);
  return count || 0;
};

// ════════ SISTEMAS ════════
// Cada sistema sabe: contar, exportar (escrevendo quadros), importar um quadro
// e excluir o ano. `ctx` leva o estado do job.
const SYSTEMS = {
  // ── Uniko Security (WhatsApp) ──────────────────────────
  security: {
    label: 'Uniko WhatsApp',
    table: 'uniko_security_messages', col: 'sent_at',
    count: (year) => countRows('uniko_security_messages', 'sent_at', year),

    async exportYear(year, write, progress) {
      const [a, b] = yearRange(year);
      const total = await countRows('uniko_security_messages', 'sent_at', year);
      let done = 0, maxId = 0, mediaFiles = 0;
      progress(0, total);
      const { data: contacts, error } = await sb.from('uniko_security_contacts').select('*').order('id');
      if (error) throw new Error(error.message);
      for (const c of contacts || []) {
        let batch = [], batchSize = 0, wrote = false;
        const flush = () => {
          if (!batch.length) return;
          write({ kind: 'messages', contactId: c.id, messages: batch });
          batch = []; batchSize = 0;
        };
        for await (const rows of pages(() => sb.from('uniko_security_messages').select('*')
          .eq('contact_id', c.id).gte('sent_at', a).lt('sent_at', b).order('sent_at').order('id'))) {
          if (!wrote) { write({ kind: 'contact', contact: { id: c.id, waId: c.wa_id, category: c.category, name: c.name, nameManual: c.name_manual, notes: c.notes } }); wrote = true; }
          for (const m of rows) {
            const mediaBase64 = await fetchBase64(m.media_url);
            if (mediaBase64) mediaFiles++;
            batch.push({ waMessageId: m.wa_message_id, sentAt: m.sent_at, direction: m.direction, senderName: m.sender_name,
              text: m.text, msgType: m.msg_type, mediaMime: m.media_mime, mediaPath: pathFromUrl(SECURITY_BUCKET, m.media_url), mediaBase64 });
            batchSize += (mediaBase64?.length || 0) + (m.text?.length || 0) + 200;
            maxId = Math.max(maxId, m.id);
            done++;
            if (batchSize >= FRAME_TARGET) flush();
          }
          progress(done, total);
        }
        flush();
      }
      return { maxId, counts: { messages: done, media: mediaFiles } };
    },

    // Restaura um quadro. `st` guarda o mapa id-do-backup → id-atual dos contatos.
    async importFrame(f, st) {
      st.map = st.map || {};
      if (f.kind === 'contact') {
        const c = f.contact;
        const { data: ex } = await sb.from('uniko_security_contacts').select('id').eq('wa_id', c.waId).eq('category', c.category).maybeSingle();
        if (ex) { st.map[c.id] = ex.id; return; }
        const { data, error } = await sb.from('uniko_security_contacts')
          .insert({ wa_id: c.waId, category: c.category, name: c.name, name_manual: !!c.nameManual, notes: c.notes }).select('id').single();
        if (error) throw new Error('contato: ' + error.message);
        st.map[c.id] = data.id; st.contactsCreated = (st.contactsCreated || 0) + 1;
        return;
      }
      if (f.kind !== 'messages') return;
      const contactId = st.map[f.contactId];
      if (!contactId) throw new Error('mensagens sem contato correspondente (arquivo fora de ordem)');
      const rows = [];
      for (const m of f.messages) {
        let mediaUrl = null;
        if (m.mediaBase64 && m.mediaPath) {
          const { error } = await sb.storage.from(SECURITY_BUCKET).upload(m.mediaPath, Buffer.from(m.mediaBase64, 'base64'), { contentType: m.mediaMime || 'application/octet-stream', upsert: true });
          if (!error) { mediaUrl = sb.storage.from(SECURITY_BUCKET).getPublicUrl(m.mediaPath).data.publicUrl; st.media = (st.media || 0) + 1; }
        }
        rows.push({ contact_id: contactId, wa_message_id: m.waMessageId || null, sent_at: m.sentAt, direction: m.direction,
          sender_name: m.senderName, text: m.text ?? '', msg_type: m.msgType || 'text', media_url: mediaUrl, media_mime: m.mediaMime || null });
      }
      // Com id da Meta: upsert ignorando duplicata. Sem id: só entra se ainda não existir igual.
      const withId = rows.filter(r => r.wa_message_id), noId = rows.filter(r => !r.wa_message_id);
      if (withId.length) {
        const ids = withId.map(r => r.wa_message_id);
        const { data: existing } = await sb.from('uniko_security_messages').select('wa_message_id').in('wa_message_id', ids);
        const have = new Set((existing || []).map(e => e.wa_message_id));
        const novos = withId.filter(r => !have.has(r.wa_message_id));
        st.skipped = (st.skipped || 0) + (withId.length - novos.length);
        for (let i = 0; i < novos.length; i += 200) {
          const { error } = await sb.from('uniko_security_messages').upsert(novos.slice(i, i + 200), { onConflict: 'wa_message_id', ignoreDuplicates: true });
          if (error) throw new Error('mensagens: ' + error.message);
        }
        st.restored = (st.restored || 0) + novos.length;
      }
      if (noId.length) {
        const { data: existing } = await sb.from('uniko_security_messages').select('sent_at,direction,text')
          .eq('contact_id', contactId).in('sent_at', noId.map(r => r.sent_at));
        const have = new Set((existing || []).map(e => `${new Date(e.sent_at).getTime()}|${e.direction}|${e.text}`));
        const novos = noId.filter(r => !have.has(`${new Date(r.sent_at).getTime()}|${r.direction}|${r.text}`));
        st.skipped = (st.skipped || 0) + (noId.length - novos.length);
        for (let i = 0; i < novos.length; i += 200) {
          const { error } = await sb.from('uniko_security_messages').insert(novos.slice(i, i + 200));
          if (error) throw new Error('mensagens: ' + error.message);
        }
        st.restored = (st.restored || 0) + novos.length;
      }
    },

    async deleteYear(year, maxId, who) {
      const [a, b] = yearRange(year);
      let apagadas = 0, midias = 0;
      for (;;) {
        const { data, error } = await sb.from('uniko_security_messages').select('id,media_url')
          .gte('sent_at', a).lt('sent_at', b).lte('id', maxId).order('id').limit(500);
        if (error) throw new Error(error.message);
        if (!data?.length) break;
        const files = data.map(m => pathFromUrl(SECURITY_BUCKET, m.media_url)).filter(Boolean);
        await removeFiles(SECURITY_BUCKET, files); midias += files.length;
        const { error: de } = await sb.from('uniko_security_messages').delete().in('id', data.map(m => m.id));
        if (de) throw new Error(de.message);
        apagadas += data.length;
      }
      // Payloads brutos do webhook (só diagnóstico, já foram processados) — pesam bastante no banco.
      let brutos = 0;
      const { count } = await sb.from('uniko_security_webhook_raw').select('id', { count: 'exact', head: true })
        .gte('received_at', a).lt('received_at', b).eq('processed', true);
      if (count) {
        const { error } = await sb.from('uniko_security_webhook_raw').delete().gte('received_at', a).lt('received_at', b).eq('processed', true);
        if (!error) brutos = count;
      }
      sb.from('uniko_security_access_log').insert({ viewer_name: who?.name || null, viewer_role: who?.role || null, action: 'delete',
        details: `Excluiu os dados de ${year} (${apagadas} mensagens) após arquivar` }).then(() => {}, () => {});
      return { apagadas, midias, brutos };
    },
  },

  // ── Uniko Call (ligações) ──────────────────────────────
  call: {
    label: 'Uniko Call',
    table: 'uniko_call_recordings', col: 'started_at',
    count: (year) => countRows('uniko_call_recordings', 'started_at', year),

    async exportYear(year, write, progress) {
      const [a, b] = yearRange(year);
      const total = await countRows('uniko_call_recordings', 'started_at', year);
      let done = 0, maxId = 0, audios = 0;
      progress(0, total);
      const { data: contacts, error } = await sb.from('uniko_call_contacts').select('*').order('id');
      if (error) throw new Error(error.message);
      for (const c of contacts || []) {
        let batch = [], batchSize = 0, wrote = false;
        const flush = () => { if (batch.length) { write({ kind: 'recordings', contactId: c.id, recordings: batch }); batch = []; batchSize = 0; } };
        for await (const rows of pages(() => sb.from('uniko_call_recordings').select('*')
          .eq('contact_id', c.id).gte('started_at', a).lt('started_at', b).order('started_at').order('id'), 100)) {
          if (!wrote) { write({ kind: 'contact', contact: { id: c.id, name: c.name, nameManual: c.name_manual, notes: c.notes } }); wrote = true; }
          for (const r of rows) {
            const audioBase64 = await fetchBase64(r.audio_url);
            if (audioBase64) audios++;
            batch.push({ protocol: r.protocol, startedAt: r.started_at, endedAt: r.ended_at, transcript: r.transcript, status: r.status,
              error: r.error, attendantId: r.attendant_id, attendantName: r.attendant_name, sectors: r.sectors, consentGiven: r.consent_given,
              audioBase64 });
            batchSize += (audioBase64?.length || 0) + (r.transcript?.length || 0) + 300;
            maxId = Math.max(maxId, r.id);
            done++;
            if (batchSize >= FRAME_TARGET) flush();
          }
          progress(done, total);
        }
        flush();
      }
      return { maxId, counts: { recordings: done, audios } };
    },

    async importFrame(f, st) {
      st.map = st.map || {};
      if (f.kind === 'contact') {
        const c = f.contact;
        const { data: ex } = await sb.from('uniko_call_contacts').select('id').ilike('name', c.name.replace(/[%_]/g, m => '\\' + m)).limit(1).maybeSingle();
        if (ex) { st.map[c.id] = ex.id; return; }
        const { data, error } = await sb.from('uniko_call_contacts').insert({ name: c.name, name_manual: !!c.nameManual, notes: c.notes }).select('id').single();
        if (error) throw new Error('contato: ' + error.message);
        st.map[c.id] = data.id; st.contactsCreated = (st.contactsCreated || 0) + 1;
        return;
      }
      if (f.kind !== 'recordings') return;
      const contactId = st.map[f.contactId];
      if (!contactId) throw new Error('ligações sem contato correspondente (arquivo fora de ordem)');
      for (const r of f.recordings) {
        if (r.protocol != null) {
          const { data: ex } = await sb.from('uniko_call_recordings').select('id').eq('protocol', r.protocol).maybeSingle();
          if (ex) { st.skipped = (st.skipped || 0) + 1; continue; }
        }
        let audioUrl = null;
        if (r.audioBase64) {
          const p = `restaurado-${r.protocol ?? crypto.randomBytes(6).toString('hex')}.webm`;
          const { error } = await sb.storage.from(CALL_BUCKET).upload(p, Buffer.from(r.audioBase64, 'base64'), { contentType: 'audio/webm', upsert: true });
          if (!error) { audioUrl = sb.storage.from(CALL_BUCKET).getPublicUrl(p).data.publicUrl; st.media = (st.media || 0) + 1; }
        }
        const row = { contact_id: contactId, started_at: r.startedAt, ended_at: r.endedAt, transcript: r.transcript ?? '',
          status: r.status || 'done', error: r.error, audio_url: audioUrl, attendant_id: r.attendantId, attendant_name: r.attendantName,
          sectors: r.sectors || [], consent_given: r.consentGiven };
        if (r.protocol != null) row.protocol = r.protocol;
        const { error } = await sb.from('uniko_call_recordings').insert(row);
        if (error) throw new Error('ligação: ' + error.message);
        st.restored = (st.restored || 0) + 1;
      }
    },

    async deleteYear(year, maxId) {
      const [a, b] = yearRange(year);
      let apagadas = 0, midias = 0;
      for (;;) {
        const { data, error } = await sb.from('uniko_call_recordings').select('id,audio_url')
          .gte('started_at', a).lt('started_at', b).lte('id', maxId).order('id').limit(200);
        if (error) throw new Error(error.message);
        if (!data?.length) break;
        const files = data.map(r => pathFromUrl(CALL_BUCKET, r.audio_url)).filter(Boolean);
        await removeFiles(CALL_BUCKET, files); midias += files.length;
        const { error: de } = await sb.from('uniko_call_recordings').delete().in('id', data.map(r => r.id));
        if (de) throw new Error(de.message);
        apagadas += data.length;
      }
      return { apagadas, midias, brutos: 0 };
    },
  },
};

// ════════ ROTAS ════════
const jobs = new Map();          // jobId → { kind, system, year, status, error, progress, filePath, result, createdAt }
const exported = new Map();      // `${sys}:${year}` → { maxId, at, counts }
const EXPORT_VALID_MS = 12 * 60 * 60 * 1000;
const newId = () => crypto.randomBytes(8).toString('hex');

module.exports = function registerArchiveRoutes(app, { requireAdmin }) {
  const ready = (res) => {
    if (!KEY || !sb) { res.status(500).json({ error: 'Arquivo anual não configurado no servidor (falta UNIKO_SECURITY_BACKUP_KEY ou Supabase).' }); return false; }
    return true;
  };
  const getSys = (req, res) => {
    const s = SYSTEMS[req.params.sys];
    if (!s) { res.status(400).json({ error: 'sistema inválido' }); return null; }
    return s;
  };

  // Anos que têm dados + quanto cada um pesa em linhas.
  app.get('/api/archive/:sys/years', requireAdmin, async (req, res) => {
    if (!ready(res)) return;
    const s = getSys(req, res); if (!s) return;
    try {
      const { data: first } = await sb.from(s.table).select(s.col).order(s.col, { ascending: true }).limit(1);
      const { data: last }  = await sb.from(s.table).select(s.col).order(s.col, { ascending: false }).limit(1);
      if (!first?.length) return res.json({ years: [] });
      const y0 = new Date(first[0][s.col]).getFullYear(), y1 = new Date(last[0][s.col]).getFullYear();
      const years = [];
      for (let y = y1; y >= y0; y--) {
        const count = await s.count(y);
        if (count) {
          const ex = exported.get(`${req.params.sys}:${y}`);
          years.push({ year: y, count, exportedAt: ex && Date.now() - ex.at < EXPORT_VALID_MS ? new Date(ex.at).toISOString() : null });
        }
      }
      res.json({ years });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Uso do Supabase (RPC criada em supabase_uniko_archive.sql).
  app.get('/api/archive/usage', requireAdmin, async (req, res) => {
    if (!ready(res)) return;
    const { data, error } = await sb.rpc('uniko_archive_usage');
    if (error) return res.json({ error: error.message });
    res.json(data);
  });

  // Exportar (job em background; progresso consultável).
  app.post('/api/archive/:sys/export', requireAdmin, (req, res) => {
    if (!ready(res)) return;
    const s = getSys(req, res); if (!s) return;
    const year = String((req.body || {}).year);
    if (!validYear(year)) return res.status(400).json({ error: 'ano inválido' });
    const sys = req.params.sys;
    const jobId = newId();
    const job = { kind: 'export', system: sys, year, status: 'running', error: null, progress: { done: 0, total: 0 }, filePath: null, result: null, createdAt: Date.now() };
    jobs.set(jobId, job);
    res.json({ jobId });
    (async () => {
      try {
        await fsp.mkdir(TMP_DIR, { recursive: true });
        const filePath = path.join(TMP_DIR, `${jobId}.ukarq`);
        const out = fs.createWriteStream(filePath);
        const w = (buf) => new Promise((ok, ko) => out.write(buf, (e) => e ? ko(e) : ok()));
        await w(MAGIC);
        // write() síncrono pro exportYear; empilha numa fila pra manter a ordem.
        let chain = Promise.resolve();
        const write = (obj) => { const buf = sealFrame(obj); chain = chain.then(() => w(buf)); };
        write({ kind: 'header', system: sys, year: Number(year), generatedAt: new Date().toISOString(), by: req.user?.name || null });
        const result = await s.exportYear(year, write, (done, total) => { job.progress = { done, total }; });
        write({ kind: 'end', counts: result.counts });
        await chain;
        await new Promise((ok) => out.end(ok));
        job.status = 'done'; job.filePath = filePath; job.result = result;
      } catch (e) {
        console.error('[uniko-archive] falha ao exportar:', e.message);
        job.status = 'error'; job.error = e.message;
      }
    })();
  });

  app.get('/api/archive/job/:jobId', requireAdmin, (req, res) => {
    const j = jobs.get(req.params.jobId);
    if (!j) return res.status(404).json({ error: 'tarefa não encontrada (expira em 1h)' });
    res.json({ status: j.status, error: j.error, progress: j.progress, result: j.kind === 'import' ? j.result : (j.result ? { counts: j.result.counts } : null) });
  });

  app.get('/api/archive/job/:jobId/download', requireAdmin, (req, res) => {
    const j = jobs.get(req.params.jobId);
    if (!j || j.kind !== 'export' || j.status !== 'done' || !j.filePath) return res.status(404).json({ error: 'arquivo ainda não está pronto' });
    res.download(j.filePath, `uniko-${j.system}-${j.year}.ukarq`, (err) => {
      // Só conta como "exportado" (libera a exclusão) se o download chegou até o fim.
      if (!err) exported.set(`${j.system}:${j.year}`, { maxId: j.result.maxId, at: Date.now(), counts: j.result.counts });
      fsp.unlink(j.filePath).catch(() => {}); j.filePath = null;
    });
  });

  // Importar: sobe o .ukarq, decifra quadro a quadro e devolve os dados ao banco.
  const upload = multer({ dest: TMP_DIR, limits: { fileSize: 8 * 1024 * 1024 * 1024 } });
  app.post('/api/archive/import', requireAdmin, (req, res, next) => {
    fsp.mkdir(TMP_DIR, { recursive: true }).then(() => upload.single('file')(req, res, (err) => {
      if (!err) return next();
      res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Arquivo grande demais.' : `Falha no upload: ${err.message}` });
    }));
  }, async (req, res) => {
    if (!ready(res)) return;
    if (!req.file) return res.status(400).json({ error: 'nenhum arquivo recebido' });
    const filePath = req.file.path;
    // Valida o cabeçalho na hora (já recusa arquivo inválido antes de abrir o job).
    let header;
    try { for await (const f of readFrames(filePath)) { header = f; break; } }
    catch (e) { fsp.unlink(filePath).catch(() => {}); return res.status(400).json({ error: 'Não foi possível abrir esse arquivo: ' + e.message }); }
    const s = SYSTEMS[header?.system];
    if (header?.kind !== 'header' || !s) { fsp.unlink(filePath).catch(() => {}); return res.status(400).json({ error: 'arquivo sem cabeçalho válido' }); }

    const jobId = newId();
    const job = { kind: 'import', system: header.system, year: header.year, status: 'running', error: null, progress: { done: 0, total: 0 }, result: null, createdAt: Date.now() };
    jobs.set(jobId, job);
    res.json({ jobId, system: header.system, year: header.year });
    (async () => {
      const st = {};
      try {
        let frames = 0;
        for await (const f of readFrames(filePath)) {
          if (f.kind === 'header') continue;
          if (f.kind === 'end') { st.expected = f.counts; continue; }
          await s.importFrame(f, st);
          job.progress = { done: ++frames, total: 0, restored: st.restored || 0 };
        }
        if (!st.expected) throw new Error('arquivo incompleto (faltou o final) — nada garante que veio inteiro');
        job.status = 'done';
        job.result = { system: header.system, year: header.year, restored: st.restored || 0, skipped: st.skipped || 0, media: st.media || 0, contactsCreated: st.contactsCreated || 0 };
        if (sb && header.system === 'security') {
          sb.from('uniko_security_access_log').insert({ viewer_name: req.user?.name || null, viewer_role: req.user?.role || null, action: 'edit',
            details: `Restaurou arquivo anual de ${header.year} (${st.restored || 0} mensagens)` }).then(() => {}, () => {});
        }
      } catch (e) {
        console.error('[uniko-archive] falha ao importar:', e.message);
        job.status = 'error'; job.error = e.message;
      } finally { fsp.unlink(filePath).catch(() => {}); }
    })();
  });

  // Excluir os dados de um ano — só depois de exportar (ver cabeçalho do arquivo).
  app.post('/api/archive/:sys/delete-year', requireAdmin, async (req, res) => {
    if (!ready(res)) return;
    const s = getSys(req, res); if (!s) return;
    const { year, confirm } = req.body || {};
    if (!validYear(year)) return res.status(400).json({ error: 'ano inválido' });
    if (String(confirm) !== String(year)) return res.status(400).json({ error: 'Confirmação não bate com o ano.' });
    const ex = exported.get(`${req.params.sys}:${year}`);
    if (!ex || Date.now() - ex.at > EXPORT_VALID_MS) {
      return res.status(409).json({ error: `Baixe o arquivo de ${year} antes de excluir (a exportação vale por 12h).`, code: 'NEEDS_EXPORT' });
    }
    try {
      const result = await s.deleteYear(year, ex.maxId, req.user);
      exported.delete(`${req.params.sys}:${year}`);
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Limpa tarefas/arquivos esquecidos.
  setInterval(() => {
    const now = Date.now();
    for (const [id, j] of jobs) if (now - j.createdAt > 60 * 60 * 1000) { if (j.filePath) fsp.unlink(j.filePath).catch(() => {}); jobs.delete(id); }
  }, 15 * 60 * 1000);
};
