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
const { spawn } = require('child_process');

const UPLOAD_TOKEN = 'uniko-call-rec'; // mesmo token hardcoded do lado da extensão (offscreen.js)
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const TRANSCRIBE_TIMEOUT_MS = 3 * 60 * 1000; // Groq nunca fica pendurado pra sempre — timeout vira erro claro

// Aviso prévio de gravação (LGPD) — o servidor busca, na transcrição do
// Whisper, a ideia de "Por questões de segurança, esse atendimento está
// gravado". Um falso-negativo aqui é DESTRUTIVO (apaga a gravação), então a
// detecção não pode depender de palavra exata — achado ao vivo 24/set/2026:
// quem atende fala naturalmente diferente a cada vez ("essa LIGAÇÃO" em vez
// de "esse atendimento", "graVADA" em vez de "graVADO"...) e a 1ª versão
// (palavras-âncora fixas) rejeitava isso. Agora é por GRUPOS DE CONCEITO —
// cada grupo é uma ideia da frase, com STEMS (raiz da palavra, sem
// acabamento de gênero/conjugação) cobrindo os jeitos comuns de dizer;
// conta como dito se pelo menos CONSENT_MIN_GROUPS dos grupos abaixo
// aparecerem, cada um por QUALQUER uma das suas variações.
const CONSENT_GROUPS = [
  ['seguranc'],                                   // segurança/seguranças
  ['grav'],                                       // grava/gravado/gravada/gravando/gravação
  ['atendiment', 'ligac', 'chamad', 'conversa'],  // atendimento OU ligação OU chamada OU conversa
];
const CONSENT_MIN_GROUPS = 2; // de 3 grupos — ainda específico da frase real, mas tolerante à forma de falar

const normalize = (s) => (s || '')
  .toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove acentos
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function hasConsentNotice(transcript) {
  const norm = normalize(transcript);
  const hits = CONSENT_GROUPS.filter(group => group.some(stem => norm.includes(stem))).length;
  return hits >= CONSENT_MIN_GROUPS;
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
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TRANSCRIBE_TIMEOUT_MS);
  let res;
  try {
    res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_KEY}` },
      body: form,
      signal: ac.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Groq Whisper não respondeu em ${TRANSCRIBE_TIMEOUT_MS / 1000}s (timeout)`);
    throw e;
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) throw new Error(`Groq Whisper respondeu ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.text || '';
}

// O MediaRecorder do Chrome grava um .webm sem os metadados de duração no
// container (bug conhecido) — toca sem parar de estar em 0:00 no player.
// Remuxa (copia os streams, sem recodificar — rápido) via ffmpeg antes de
// guardar/transcrever: corrige a duração pro player E dá pro Whisper um
// arquivo mais "limpo" de ler. Se falhar por qualquer motivo, segue com o
// buffer original (áudio ainda toca/transcreve, só sem a correção).
function remuxWebm(buffer) {
  return new Promise((resolve) => {
    const ff = spawn('ffmpeg', ['-i', 'pipe:0', '-c', 'copy', '-f', 'webm', 'pipe:1']);
    const out = [];
    let err = '';
    ff.stdout.on('data', (d) => out.push(d));
    ff.stderr.on('data', (d) => { err += d.toString(); });
    ff.on('error', (e) => { console.error('[uniko-call] ffmpeg indisponível, seguindo sem remux:', e.message); resolve(buffer); });
    ff.on('close', (code) => {
      if (code !== 0 || !out.length) {
        console.error(`[uniko-call] remux falhou (code ${code}), seguindo com o áudio original: ${err.slice(-300)}`);
        return resolve(buffer);
      }
      resolve(Buffer.concat(out));
    });
    ff.stdin.on('error', () => {}); // EPIPE se o ffmpeg já morreu — o 'close' acima trata o resultado
    ff.stdin.end(buffer);
  });
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

    console.log(`[uniko-call] recording id=${recording.id}: iniciando remux (buffer original ${req.file.buffer.length} bytes)...`);
    // Corrige a duração do webm ANTES de tudo — mesmo buffer corrigido serve
    // tanto pro Storage (player) quanto pro Whisper (transcrição).
    const fixedBuffer = await remuxWebm(req.file.buffer);
    console.log(`[uniko-call] recording id=${recording.id}: remux concluído (buffer final ${fixedBuffer.length} bytes).`);

    // Áudio e transcrição são passos independentes — um falhar não derruba o
    // outro. Sobe o áudio primeiro: mesmo se o Groq falhar, a chamada já fica
    // ouvível na tela.
    let audioUrl = null;
    try {
      console.log(`[uniko-call] recording id=${recording.id}: subindo áudio pro Storage...`);
      audioUrl = await uploadAudio(fixedBuffer, req.file.mimetype, recording.id);
      console.log(`[uniko-call] recording id=${recording.id}: áudio no Storage OK:`, audioUrl);
      const { error: audioUpdErr } = await supabaseCall.from('uniko_call_recordings')
        .update({ audio_url: audioUrl }).eq('id', recording.id);
      if (audioUpdErr) console.error(`[uniko-call] recording id=${recording.id}: update audio_url falhou:`, audioUpdErr.message);
    } catch (e) {
      console.error(`[uniko-call] recording id=${recording.id}: falha ao subir o áudio:`, e.message);
    }

    try {
      console.log(`[uniko-call] recording id=${recording.id}: chamando transcribe() (Groq)...`);
      const text = await transcribe(fixedBuffer, req.file.mimetype);
      console.log(`[uniko-call] recording id=${recording.id}: transcribe() voltou (${text.length} caracteres): "${text.slice(0, 200)}"`);
      const consentGiven = hasConsentNotice(text);
      const gruposBatidos = CONSENT_GROUPS.filter(g => g.some(stem => normalize(text).includes(stem))).map(g => g[0]);
      console.log(`[uniko-call] recording id=${recording.id}: consentGiven=${consentGiven} (grupos batidos: ${gruposBatidos.join(', ') || 'nenhum'}). Atualizando registro...`);
      if (consentGiven) {
        const { error: updErr } = await supabaseCall.from('uniko_call_recordings')
          .update({ transcript: text, status: 'done', consent_given: true }).eq('id', recording.id);
        if (updErr) console.error(`[uniko-call] recording id=${recording.id}: update (consentido) falhou:`, updErr.message);
        else console.log(`[uniko-call] recording id=${recording.id}: gravado como "done" com transcrição.`);
      } else {
        // Aviso prévio NÃO dito — por segurança/proteção de dados, a gravação
        // não é mantida: apaga o áudio já subido e não guarda a transcrição.
        // Só sobra o registro (protocolo + horário) pra auditoria.
        if (audioUrl) await deleteAudio(recording.id);
        const { error: updErr } = await supabaseCall.from('uniko_call_recordings')
          .update({ transcript: null, audio_url: null, status: 'done', consent_given: false }).eq('id', recording.id);
        if (updErr) console.error(`[uniko-call] recording id=${recording.id}: update (sem consentimento) falhou:`, updErr.message);
        else console.log(`[uniko-call] recording id=${recording.id}: gravado como "done" sem consentimento (áudio apagado).`);
      }
      await supabaseCall.from('uniko_call_contacts')
        .update({ last_call_at: recording.started_at }).eq('id', contact.id);
    } catch (e) {
      console.error(`[uniko-call] recording id=${recording.id}: falha na transcrição:`, e.message);
      const { error: errUpdErr } = await supabaseCall.from('uniko_call_recordings')
        .update({ status: 'error', error: e.message }).eq('id', recording.id);
      if (errUpdErr) console.error(`[uniko-call] recording id=${recording.id}: até o update de status="error" falhou:`, errUpdErr.message);
    }
  });
};
