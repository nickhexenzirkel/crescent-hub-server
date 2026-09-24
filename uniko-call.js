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
// Guarda o ÁUDIO bruto também (bucket 'uniko-call', ver
// supabase_uniko_call_audio.sql) — dá pra ouvir de volta na tela, não só
// ler a transcrição. Upload do áudio e transcrição são passos
// INDEPENDENTES: se o Groq falhar, o áudio já gravado continua ouvível.
const { createClient } = require('@supabase/supabase-js');

const UPLOAD_TOKEN = 'uniko-call-rec'; // mesmo token hardcoded do lado da extensão (offscreen.js)
const GROQ_KEY = process.env.GROQ_API_KEY || '';

// Aviso prévio de gravação (LGPD) — o servidor busca essa frase (config via
// env, sem precisar redeploy) na transcrição do Whisper. Detecção por
// PALAVRAS-CHAVE (não a frase exata inteira): o Whisper erra uma palavra vez
// ou outra, e um falso-negativo aqui é DESTRUTIVO (apaga a gravação) — exigir
// a maioria das palavras-âncora, em vez do trecho idêntico, é bem mais
// tolerante a isso sem deixar de ser específico da frase real.
const CONSENT_PHRASE = process.env.UNIKO_CALL_CONSENT_PHRASE || 'Por questões de segurança, esse atendimento está gravado';
const CONSENT_MIN_MATCHES = 3; // de 4 palavras-âncora (ver normalize/anchorWords abaixo)

const normalize = (s) => (s || '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove acentos
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const STOPWORDS = new Set(['por', 'de', 'esse', 'essa', 'esta', 'este', 'a', 'o', 'e', 'que']);
const anchorWords = (phrase) => [...new Set(normalize(phrase).split(' ').filter(w => w.length > 2 && !STOPWORDS.has(w)))];

function hasConsentNotice(transcript) {
  const anchors = anchorWords(CONSENT_PHRASE);
  if (!anchors.length) return false;
  const norm = normalize(transcript);
  const hits = anchors.filter(w => norm.includes(w)).length;
  return hits >= Math.min(CONSENT_MIN_MATCHES, anchors.length);
}

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

// Extensão do arquivo salvo bate com o que o MediaRecorder do offscreen.js
// gera (audio/webm;codecs=opus) — sempre .webm, os navegadores tocam nativamente.
async function uploadAudio(buffer, mimetype, recordingId) {
  const path = `${recordingId}.webm`;
  const { error } = await supabaseCall.storage.from('uniko-call')
    .upload(path, buffer, { contentType: mimetype || 'audio/webm', upsert: true });
  if (error) throw new Error(error.message);
  const { data } = supabaseCall.storage.from('uniko-call').getPublicUrl(path);
  return data.publicUrl;
}

async function deleteAudio(recordingId) {
  try { await supabaseCall.storage.from('uniko-call').remove([`${recordingId}.webm`]); }
  catch (e) { console.error('[uniko-call] falha ao apagar áudio sem consentimento:', e.message); }
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

    // Áudio e transcrição são passos independentes — um falhar não derruba o
    // outro. Sobe o áudio primeiro: mesmo se o Groq falhar, a chamada já fica
    // ouvível na tela.
    let audioUrl = null;
    try {
      audioUrl = await uploadAudio(req.file.buffer, req.file.mimetype, recording.id);
      await supabaseCall.from('uniko_call_recordings')
        .update({ audio_url: audioUrl }).eq('id', recording.id);
    } catch (e) {
      console.error('[uniko-call] falha ao subir o áudio:', e.message);
    }

    try {
      const text = await transcribe(req.file.buffer, req.file.mimetype);
      const consentGiven = hasConsentNotice(text);
      if (consentGiven) {
        await supabaseCall.from('uniko_call_recordings')
          .update({ transcript: text, status: 'done', consent_given: true }).eq('id', recording.id);
      } else {
        // Aviso prévio NÃO dito — por segurança/proteção de dados, a gravação
        // não é mantida: apaga o áudio já subido e não guarda a transcrição.
        // Só sobra o registro (protocolo + horário) pra auditoria.
        if (audioUrl) await deleteAudio(recording.id);
        await supabaseCall.from('uniko_call_recordings')
          .update({ transcript: null, audio_url: null, status: 'done', consent_given: false }).eq('id', recording.id);
      }
      await supabaseCall.from('uniko_call_contacts')
        .update({ last_call_at: recording.started_at }).eq('id', contact.id);
    } catch (e) {
      console.error('[uniko-call] falha na transcrição:', e.message);
      await supabaseCall.from('uniko_call_recordings')
        .update({ status: 'error', error: e.message }).eq('id', recording.id);
    }
  });
};
