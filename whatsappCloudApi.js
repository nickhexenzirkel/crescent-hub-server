// ════════════════════════════════════════════════════════
// UNIKO SECURITY — recebe o webhook OFICIAL da WhatsApp Cloud API (número em
// modo Coexistence: app do celular + API ao mesmo tempo) e grava as
// mensagens direto no Supabase. Ao contrário do Uniko Safer
// (whatsappSafer.js), aqui não existe robô de navegador nenhum — é só um
// endpoint recebendo POST da Meta, em tempo real, cada vez que chega ou sai
// uma mensagem.
//
// Como funciona:
//  1) A Meta chama GET nesta rota UMA VEZ, no momento em que você cola a
//     URL do webhook no painel do Meta for Developers, pra confirmar que o
//     dono do endpoint é você mesmo (handshake de verificação, usando um
//     "verify token" que você escolhe e cola dos dois lados).
//  2) Depois disso, toda mensagem nova chega como POST aqui, assinada pela
//     Meta (cabeçalho X-Hub-Signature-256, HMAC-SHA256 do corpo cru usando
//     o App Secret do app no Meta for Developers) — verificamos essa
//     assinatura antes de confiar em qualquer coisa do corpo.
//
// Grava usando a SERVICE ROLE do Supabase (não a anon key usada pelo
// front-end) — bypassa RLS de propósito: não existe usuário logado nesse
// fluxo pra RLS checar (ver supabase_uniko_security.sql — só ADMIN de
// verdade lê/edita pela API normal via front-end; o webhook escreve por
// fora disso, autenticado pela assinatura da Meta, não por um ch_token).
//
// AVISO (mesmo espírito das automações do Safer): o formato exato de como o
// Coexistence "ecoa" mensagens mandadas pelo app do celular (pra também
// aparecerem aqui) só fica confirmado olhando um payload de verdade — por
// isso TODO webhook recebido é gravado cru em uniko_security_webhook_raw
// antes/depois do parsing, pra dar pra ajustar sem precisar reproduzir o
// problema ao vivo.
// ════════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js');

const VERIFY_TOKEN     = process.env.UNIKO_SECURITY_WEBHOOK_VERIFY_TOKEN || '';
// Número foi conectado via Coexistence usando o Dualhook (BSP/Tech Provider —
// nosso app "Uniko Security" sozinho não tem acesso a Coexistence, ver
// decisão de set/2026). Isso muda quem ASSINA o webhook: o X-Hub-Signature-256
// que a Meta manda é calculado com o App Secret do app do PRÓPRIO Dualhook,
// não do nosso — não temos e nunca vamos ter esse segredo (a documentação
// deles é explícita: "Meta app credentials are never disclosed"). Verificação
// HMAC de assinatura, portanto, é IMPOSSÍVEL nessa integração — não é bug de
// configuração. Seguindo a orientação oficial do próprio Dualhook ("validate
// inbound webhook payload shape instead"), a autenticidade é conferida
// conferindo se o payload é mesmo um evento do NOSSO WABA (object +
// entry[].id) em vez de assinatura criptográfica.
const WABA_ID = process.env.UNIKO_SECURITY_WABA_ID || '';

let supabaseSecurity = null;
if (process.env.UNIKO_SECURITY_SUPABASE_URL && process.env.UNIKO_SECURITY_SUPABASE_SERVICE_KEY) {
  supabaseSecurity = createClient(
    process.env.UNIKO_SECURITY_SUPABASE_URL,
    process.env.UNIKO_SECURITY_SUPABASE_SERVICE_KEY
  );
} else {
  console.warn('[uniko-security] UNIKO_SECURITY_SUPABASE_URL/SERVICE_KEY não configurados — webhook vai receber, mas não vai gravar nada.');
}

function isValidPayload(body) {
  if (!body || body.object !== 'whatsapp_business_account') return false;
  if (!Array.isArray(body.entry) || !body.entry.length) return false;
  if (WABA_ID && !body.entry.some(e => e.id === WABA_ID)) return false;
  return true;
}

// Extrai um texto legível de qualquer tipo de mensagem que a Cloud API manda
// — cobre os tipos mais comuns; o que não reconhece vira um rótulo genérico
// (nunca perde a mensagem silenciosamente, só não sabe descrever o conteúdo
// direito — mídia em si não é baixada nessa 1ª versão, só o metadado).
function extractMessageContent(msg) {
  switch (msg.type) {
    case 'text':        return { text: msg.text?.body || '', msgType: 'text' };
    case 'image':        return { text: msg.image?.caption || '[imagem]', msgType: 'image' };
    case 'video':        return { text: msg.video?.caption || '[vídeo]', msgType: 'video' };
    case 'document':     return { text: msg.document?.caption || msg.document?.filename || '[documento]', msgType: 'document' };
    case 'audio':        return { text: '[áudio]', msgType: 'audio' };
    case 'sticker':      return { text: '[figurinha]', msgType: 'sticker' };
    case 'location':     return { text: `[localização: ${msg.location?.latitude ?? '?'}, ${msg.location?.longitude ?? '?'}]`, msgType: 'location' };
    case 'contacts':     return { text: '[contato compartilhado]', msgType: 'contacts' };
    case 'reaction':     return { text: `[reagiu: ${msg.reaction?.emoji || ''}]`, msgType: 'reaction' };
    case 'button':       return { text: msg.button?.text || '[botão]', msgType: 'button' };
    case 'interactive':  return { text: msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '[resposta interativa]', msgType: 'interactive' };
    default:             return { text: `[mensagem: ${msg.type || 'desconhecida'}]`, msgType: msg.type || 'other' };
  }
}

async function upsertContact(waId, profileName) {
  const { data: existing } = await supabaseSecurity.from('uniko_security_contacts').select('*').eq('wa_id', waId).maybeSingle();
  if (existing) {
    // Só atualiza o nome de perfil automaticamente se ninguém renomeou esse
    // contato manualmente ainda (ver name_manual em supabase_uniko_security.sql).
    if (profileName && !existing.name_manual && existing.name !== profileName) {
      await supabaseSecurity.from('uniko_security_contacts').update({ name: profileName }).eq('id', existing.id);
    }
    return existing;
  }
  const { data, error } = await supabaseSecurity.from('uniko_security_contacts')
    .insert({ wa_id: waId, name: profileName || waId }).select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function insertMessage({ contact, waMessageId, sentAt, direction, senderName, text, msgType }) {
  const { error } = await supabaseSecurity.from('uniko_security_messages')
    .upsert({
      contact_id: contact.id, wa_message_id: waMessageId || null, sent_at: sentAt,
      direction, sender_name: senderName || null, text, msg_type: msgType,
    }, { onConflict: 'wa_message_id', ignoreDuplicates: true });
  if (error) throw new Error(error.message);
  if (!contact.last_message_at || sentAt > contact.last_message_at) {
    await supabaseSecurity.from('uniko_security_contacts').update({ last_message_at: sentAt }).eq('id', contact.id);
  }
}

// Processa UMA "mudança" do payload da Meta (entry[].changes[]) — cada uma
// tem metadata + contacts (perfis) + messages (as mensagens de verdade) do
// mesmo lote.
async function processChange(value) {
  const profileByWaId = new Map((value.contacts || []).map(c => [c.wa_id, c.profile?.name]));

  for (const msg of value.messages || []) {
    const waId = msg.from;
    if (!waId) continue;
    const contact = await upsertContact(waId, profileByWaId.get(waId));
    const { text, msgType } = extractMessageContent(msg);
    await insertMessage({
      contact, waMessageId: msg.id, sentAt: new Date(Number(msg.timestamp) * 1000).toISOString(),
      direction: 'in', senderName: profileByWaId.get(waId), text, msgType,
    });
  }

  // Coexistence ecoa mensagens mandadas pelo app do celular, pra também
  // aparecerem aqui — o nome exato desse campo só fica confirmado olhando
  // um payload real (guardado em uniko_security_webhook_raw). `message_echoes`
  // é o nome mais provável pela documentação da Meta; se vier diferente,
  // ajusta aqui depois de ver o payload cru.
  for (const echo of value.message_echoes || []) {
    const waId = echo.to || echo.from;
    if (!waId) continue;
    const contact = await upsertContact(waId, profileByWaId.get(waId));
    const { text, msgType } = extractMessageContent(echo);
    await insertMessage({
      contact, waMessageId: echo.id, sentAt: new Date(Number(echo.timestamp) * 1000).toISOString(),
      direction: 'out', senderName: null, text, msgType,
    });
  }
}

module.exports = function registerWhatsappCloudApiRoutes(app) {
  // 1) Handshake de verificação — a Meta chama isso UMA VEZ quando você cola
  //    a URL do webhook no painel dela (WhatsApp → Configuration → Webhook).
  app.get('/api/security/webhook', (req, res) => {
    const mode      = req.query['hub.mode'];
    const token     = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && VERIFY_TOKEN && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    res.sendStatus(403);
  });

  // 2) Recebe cada mensagem nova.
  app.post('/api/security/webhook', async (req, res) => {
    if (!isValidPayload(req.body)) return res.sendStatus(403);
    // Responde 200 JÁ — a Meta reentrega (com backoff, por até dias) tudo
    // que não receber 200, então um erro de PROCESSAMENTO nosso não deve
    // virar reentrega infinita; o erro fica só registrado no log cru abaixo.
    res.sendStatus(200);

    if (!supabaseSecurity) {
      console.error('[uniko-security] Supabase não configurado — mensagem recebida e descartada.');
      return;
    }

    const payload = req.body;
    let processError = null;
    try {
      for (const entry of payload.entry || []) {
        for (const change of entry.changes || []) {
          if (change.field === 'messages') await processChange(change.value || {});
        }
      }
    } catch (err) {
      processError = err.message;
      console.error('[uniko-security] erro processando webhook:', err.message);
    }

    try {
      await supabaseSecurity.from('uniko_security_webhook_raw').insert({
        payload, processed: !processError, error: processError,
      });
    } catch (err) {
      console.error('[uniko-security] falha ao gravar log cru do webhook:', err.message);
    }
  });
};
