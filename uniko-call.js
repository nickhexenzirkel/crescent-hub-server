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
const fs = require('fs');
const path = require('path');

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

// Provedor de transcricao: OpenAI (gpt-4o-transcribe) quando ha OPENAI_API_KEY, senao Groq (Whisper).
// TRANSCRIBE_PROVIDER=groq|openai forca um deles. Se o principal falhar e o outro estiver
// configurado, tenta o outro antes de desistir.
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-transcribe';
const PROVIDER = (process.env.TRANSCRIBE_PROVIDER || (OPENAI_KEY ? 'openai' : 'groq')).toLowerCase();

async function transcribeVia(provider, buffer, mimetype, retry429 = true) {
  const cfg = provider === 'openai'
    ? { name: 'OpenAI', key: OPENAI_KEY, keyVar: 'OPENAI_API_KEY', url: 'https://api.openai.com/v1/audio/transcriptions', model: OPENAI_MODEL }
    : { name: 'Groq Whisper', key: GROQ_KEY, keyVar: 'GROQ_API_KEY', url: 'https://api.groq.com/openai/v1/audio/transcriptions', model: 'whisper-large-v3' };
  if (!cfg.key) throw new Error(`${cfg.keyVar} nao configurada no servidor`);
  const form = new FormData();
  const isWav = /wav/i.test(mimetype || '');
  const isFlac = /flac/i.test(mimetype || '');
  form.append('file', new Blob([buffer], { type: mimetype || 'audio/webm' }), isWav ? 'call.wav' : isFlac ? 'call.flac' : 'call.webm');
  form.append('model', cfg.model);
  form.append('language', 'pt');
  form.append('temperature', '0'); // deterministico - menos invencao de palavras
  // Contexto neutro (NAO inclui a frase do aviso - nao pode induzir o modelo a ouvir um aviso que nao foi dito).
  form.append('prompt', 'Conversa telefonica em portugues do Brasil entre um atendente e um cliente. Transcreva fielmente apenas o que foi dito; nao complete, nao repita e nao invente palavras ou frases.');
  let res;
  // 429 (limite por minuto — comum em conta nova da OpenAI): espera o tempo sugerido e tenta de novo (até 3x).
  for (let attempt = 0; ; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TRANSCRIBE_TIMEOUT_MS);
    try {
      res = await fetch(cfg.url, { method: 'POST', headers: { Authorization: `Bearer ${cfg.key}` }, body: form, signal: ac.signal });
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`${cfg.name} nao respondeu em ${TRANSCRIBE_TIMEOUT_MS / 1000}s (timeout)`);
      throw e;
    } finally {
      clearTimeout(t);
    }
    if (res.status === 429 && retry429 && attempt < 3) {
      const body = await res.clone().text();
      if (/insufficient_quota|credit/i.test(body)) break; // sem crédito: esperar não adianta
      const wait = Math.min(Number(res.headers.get('retry-after')) || Number((body.match(/in (\d+(?:\.\d+)?)s/) || [])[1]) || 20, 30);
      console.warn(`[uniko-call] ${cfg.name} 429 (limite por minuto) — aguardando ${wait}s e tentando de novo (${attempt + 1}/3)...`);
      await new Promise(r => setTimeout(r, (wait + 1) * 1000));
      continue;
    }
    break;
  }
  if (!res.ok) throw new Error(`${cfg.name} respondeu ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.text || '';
}

async function transcribe(buffer, mimetype, { retry429 = true } = {}) {
  const other = PROVIDER === 'openai' ? 'groq' : 'openai';
  try {
    return await transcribeVia(PROVIDER, buffer, mimetype, retry429);
  } catch (e) {
    const otherConfigured = other === 'openai' ? !!OPENAI_KEY : !!GROQ_KEY;
    if (!otherConfigured) throw e;
    console.error(`[uniko-call] ${PROVIDER} falhou (${e.message}) — tentando ${other}...`);
    return await transcribeVia(other, buffer, mimetype, retry429);
  }
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

// ── Preparação do áudio pra transcrição ─────────────────────────────────────
// Silêncio e ruído longos são o que faz o modelo "inventar" texto. Antes de transcrever,
// remove os silêncios, nivela o volume (voz baixa fica audível) e converte pra FLAC 16 kHz mono.
// SÓ pro envio à transcrição — o áudio guardado pra ouvir continua o original. Se o ffmpeg
// falhar ou sobrar quase nada, segue com o áudio original.
function prepareForTranscription(buffer) {
  return new Promise((resolve) => {
    const orig = { buffer, mimetype: 'audio/webm' };
    const ff = spawn('ffmpeg', ['-i', 'pipe:0',
      '-af', 'silenceremove=start_periods=1:start_duration=0.1:start_threshold=-50dB:stop_periods=-1:stop_duration=0.8:stop_threshold=-50dB,dynaudnorm=f=150:g=7',
      '-ar', '16000', '-ac', '1', '-c:a', 'flac', '-f', 'flac', 'pipe:1']);
    const out = [];
    const timer = setTimeout(() => { ff.kill('SIGKILL'); }, 60000);
    ff.stdout.on('data', (d) => out.push(d));
    ff.stderr.on('data', () => {});
    ff.on('error', (e) => { clearTimeout(timer); console.error('[uniko-call] ffmpeg indisponível pra preparar transcrição:', e.message); resolve(orig); });
    ff.on('close', (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(out);
      if (code !== 0 || buf.length < 2000) { console.warn(`[uniko-call] preparo do áudio não aproveitado (code ${code}, ${buf.length} bytes) — usando o original.`); return resolve(orig); }
      resolve({ buffer: buf, mimetype: 'audio/flac' });
    });
    ff.stdin.on('error', () => {});
    ff.stdin.end(buffer);
  });
}

// Coloca o áudio do aviso prévio NO INÍCIO da gravação (aviso primeiro, depois a ligação), sem
// sobrepor ninguém. Reencoda tudo em webm/opus mono. Se algo falhar, devolve o áudio original.
function prependAviso(callBuffer) {
  return new Promise((resolve) => {
    if (!fs.existsSync(AVISO_FILE)) return resolve(null);
    const ff = spawn('ffmpeg', ['-i', AVISO_FILE, '-i', 'pipe:0',
      '-filter_complex', '[0:a]aresample=48000,aformat=channel_layouts=mono[a0];[1:a]aresample=48000,aformat=channel_layouts=mono[a1];[a0][a1]concat=n=2:v=0:a=1[a]',
      '-map', '[a]', '-c:a', 'libopus', '-b:a', '96k', '-f', 'webm', 'pipe:1']);
    const out = []; let err = '';
    const timer = setTimeout(() => ff.kill('SIGKILL'), 90000);
    ff.stdout.on('data', (d) => out.push(d));
    ff.stderr.on('data', (d) => { err += d.toString(); });
    ff.on('error', (e) => { clearTimeout(timer); console.error('[uniko-call] ffmpeg indisponível pra juntar o aviso:', e.message); resolve(null); });
    ff.on('close', (code) => {
      clearTimeout(timer);
      const buf = Buffer.concat(out);
      if (code !== 0 || buf.length < 2000) { console.error(`[uniko-call] juntar aviso falhou (code ${code}): ${err.slice(-200)}`); return resolve(null); }
      resolve(buf);
    });
    ff.stdin.on('error', () => {});
    ff.stdin.end(callBuffer);
  });
}

// Remove "frases fantasma" típicas de modelos de transcrição quando o áudio tem pouca fala
// (legendas, agradecimentos de vídeo etc.) — não fazem parte de nenhuma ligação.
const GHOST_PATTERNS = [
  /legendas?\s+(pela|por|de)\s+[^.]*comunidade[^.]*\.?/gi,
  /amara\.org/gi,
  /transcri[cç][aã]o\s+e\s+legendas?[^.]*\.?/gi,
  /obrigad[oa]\s+por\s+assistir[^.]*\.?/gi,
  /inscreva-se\s+no\s+canal[^.]*\.?/gi,
  /até\s+a\s+próxima[!.]?\s*$/gi,
];
function cleanTranscript(text) {
  let t = String(text || '');
  for (const re of GHOST_PATTERNS) t = t.replace(re, ' ');
  return t.replace(/\s{2,}/g, ' ').trim();
}

// ── Aviso prévio automático (áudio tocado pelo botão "Tocar aviso" da extensão) ──
// Texto fixo; voz sintética (OpenAI TTS) gerada UMA vez e guardada em public/aviso-previo.mp3.
// Pra trocar por uma gravação melhor é só substituir esse arquivo (ou apagar pra regenerar).
const AVISO_TEXTO = process.env.AVISO_PREVIO_TEXTO ||
  'Olá, seja bem-vindo à 7 Benefícios. Por questões de segurança, a ligação está sendo gravada, estarei encaminhando essa ligação para um de nossos atendentes.';
const AVISO_FILE = path.join(__dirname, 'public', 'aviso-previo.mp3');

async function generateAvisoAudio() {
  if (!OPENAI_KEY) throw new Error('OPENAI_API_KEY nao configurada — nao da pra gerar a voz do aviso');
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts',
      voice: process.env.OPENAI_TTS_VOICE || 'coral',
      input: AVISO_TEXTO,
      instructions: 'Fale em português do Brasil, com tom cordial, claro e profissional, em ritmo calmo.',
      response_format: 'mp3',
    }),
  });
  if (!res.ok) throw new Error(`OpenAI TTS respondeu ${res.status}: ${await res.text()}`);
  fs.mkdirSync(path.dirname(AVISO_FILE), { recursive: true });
  fs.writeFileSync(AVISO_FILE, Buffer.from(await res.arrayBuffer()));
  console.log('[uniko-call] áudio do aviso prévio gerado em', AVISO_FILE);
}

module.exports = function registerUnikoCallRoutes(app, upload) {
  app.get('/api/uniko-call/aviso-audio', async (req, res) => {
    if (req.get('Authorization') !== `Bearer ${UPLOAD_TOKEN}`) return res.sendStatus(401);
    try {
      if (!fs.existsSync(AVISO_FILE)) await generateAvisoAudio();
      res.set('Content-Type', 'audio/mpeg');
      res.set('Cache-Control', 'no-store');
      res.sendFile(AVISO_FILE);
    } catch (e) {
      console.error('[uniko-call] aviso-audio falhou:', e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // upload = instância multer (memoryStorage) já criada em index.js — reaproveita.
  // Calibração (popup da extensão): transcreve ~10s de áudio de teste e diz se o aviso prévio
  // seria aceito. NADA é gravado — nem áudio, nem transcrição, nem contato.
  app.post('/api/uniko-call/test', upload.single('audio'), async (req, res) => {
    if (req.get('Authorization') !== `Bearer ${UPLOAD_TOKEN}`) return res.sendStatus(401);
    if (!req.file) return res.status(400).json({ error: 'nenhum áudio recebido' });
    try {
      const fixed = /wav/i.test(req.file.mimetype || '') ? req.file.buffer : await remuxWebm(req.file.buffer); // WAV nao precisa de remux
      // Teste de calibração falha RÁPIDO em limite de uso (sem esperar/retentar) — o usuário está olhando a tela.
      const text = cleanTranscript(await transcribe(fixed, req.file.mimetype, { retry429: false }));
      res.json({ text, consentGiven: hasConsentNotice(text) });
    } catch (e) {
      console.error('[uniko-call] teste de calibração falhou:', e.message);
      res.json({ error: e.message });
    }
  });

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
    // Aviso tocado pelo botão: o áudio dele vai no começo do arquivo salvo (e é transcrito junto).
    let fixedBuffer = null;
    if (String(req.body.avisoPlayed || '') === 'true') {
      try { if (!fs.existsSync(AVISO_FILE)) await generateAvisoAudio(); } catch (e) { console.error('[uniko-call] sem áudio do aviso pra juntar:', e.message); }
      fixedBuffer = await prependAviso(req.file.buffer);
      if (fixedBuffer) console.log(`[uniko-call] recording id=${recording.id}: aviso prévio colocado no início do áudio.`);
    }
    if (!fixedBuffer) fixedBuffer = await remuxWebm(req.file.buffer);
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
      console.log(`[uniko-call] recording id=${recording.id}: chamando transcribe()...`);
      const prepared = await prepareForTranscription(fixedBuffer);
      const text = cleanTranscript(await transcribe(prepared.buffer, prepared.mimetype));
      console.log(`[uniko-call] recording id=${recording.id}: transcribe() voltou (${text.length} caracteres): "${text.slice(0, 200)}"`);
      // Aviso tocado pelo botão "Tocar aviso" (áudio fixo, garantido) OU detectado na fala do atendente.
      const avisoPlayed = String(req.body.avisoPlayed || '') === 'true';
      const consentGiven = avisoPlayed || hasConsentNotice(text);
      if (avisoPlayed) console.log(`[uniko-call] recording id=${recording.id}: aviso prévio tocado pela extensão — consentimento garantido.`);
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
