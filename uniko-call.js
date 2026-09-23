// ════════════════════════════════════════════════════════
// UNIKO CALL — recebe o áudio gravado pela extensão Cat-Bot (ver
// extension/offscreen.js) de uma chamada do WhatsApp Web, manda pro Groq
// Whisper transcrever, e grava a transcrição como "mensagem" de uma
// conversa — mesmo espírito visual do Uniko Security/Safer (lista de
// contatos, abre e lê o "chat"), só que aqui cada mensagem é uma chamada
// inteira já transcrita.
//
// Contato aqui é por NOME (extraído do cabeçalho do WhatsApp Web pela
// extensão) — não tem wa_id como no Security, porque a UI de chamada do
// WhatsApp Web não expõe o número de telefone. Duas pessoas com nome igual
// caem no mesmo contato — limitação conhecida da v1.
//
// Sem áudio bruto guardado (só a transcrição) — decisão deliberada pra não
// precisar de bucket de Storage nem lidar com retenção de arquivo grande;
// pode ser adicionado depois se precisar do áudio original por auditoria.
const { createClient } = require('@supabase/supabase-js');

const UPLOAD_TOKEN = 'uniko-call-rec'; // mesmo token hardcoded do lado da extensão (offscreen.js)
const GROQ_KEY = process.env.GROQ_API_KEY || '';

let supabaseCall = null;
if (process.env.UNIKO_SECURITY_SUPABASE_URL && process.env.UNIKO_SECURITY_SUPABASE_SERVICE_KEY) {
  // Mesmo projeto Supabase do Uniko Security/Safer — reaproveita jwt_claims()
  // /is_admin_ou_moderador() já configurados ali.
  supabaseCall = createClient(
    process.env.UNIKO_SECURITY_SUPABASE_URL,
    process.env.UNIKO_SECURITY_SUPABASE_SERVICE_KEY
  );
} else {
  console.warn('[uniko-call] UNIKO_SECURITY_SUPABASE_URL/SERVICE_KEY não configurados — upload vai ser aceito, mas nada é gravado.');
}

async function transcribe(buffer, mimetype) {
  if (!GROQ_KEY) throw new Error('GROQ_API_KEY não configurada no servidor');
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimetype || 'audio/webm' }), 'call.webm');
  form.append('model', 'whisper-large-v3');
  form.append('language', 'pt');
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Groq Whisper respondeu ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.text || '';
}

async function upsertCallContact(name) {
  const clean = (name || '').trim() || 'Contato desconhecido';
  const { data: existing } = await supabaseCall.from('uniko_call_contacts')
    .select('*').ilike('name', clean).maybeSingle();
  if (existing) return existing;
  const { data, error } = await supabaseCall.from('uniko_call_contacts')
    .insert({ name: clean }).select().single();
  if (error) throw new Error(error.message);
  return data;
}

module.exports = function registerUnikoCallRoutes(app, upload) {
  // upload = instância multer (memoryStorage) já criada em index.js — reaproveita.
  app.post('/api/uniko-call/upload', upload.single('audio'), async (req, res) => {
    if (req.get('Authorization') !== `Bearer ${UPLOAD_TOKEN}`) return res.sendStatus(401);
    if (!req.file) return res.status(400).json({ error: 'nenhum áudio recebido' });
    res.sendStatus(200); // confirma recebimento já — transcrição roda em segundo plano

    if (!supabaseCall) { console.error('[uniko-call] Supabase não configurado — áudio recebido e descartado.'); return; }

    const { contactName, startedAt, endedAt } = req.body;
    let contact, recording;
    try {
      contact = await upsertCallContact(contactName);
      const { data, error } = await supabaseCall.from('uniko_call_recordings')
        .insert({
          contact_id: contact.id,
          started_at: startedAt || new Date().toISOString(),
          ended_at: endedAt || null,
          status: 'processing',
        }).select().single();
      if (error) throw new Error(error.message);
      recording = data;
    } catch (e) {
      console.error('[uniko-call] falha ao criar registro da chamada:', e.message);
      return;
    }

    try {
      const text = await transcribe(req.file.buffer, req.file.mimetype);
      await supabaseCall.from('uniko_call_recordings')
        .update({ transcript: text, status: 'done' }).eq('id', recording.id);
      await supabaseCall.from('uniko_call_contacts')
        .update({ last_call_at: recording.started_at }).eq('id', contact.id);
    } catch (e) {
      console.error('[uniko-call] falha na transcrição:', e.message);
      await supabaseCall.from('uniko_call_recordings')
        .update({ status: 'error', error: e.message }).eq('id', recording.id);
    }
  });
};
