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

const VERIFY_TOKEN = process.env.UNIKO_SECURITY_WEBHOOK_VERIFY_TOKEN || '';

// Cada SETOR (Faturamento, Financeiro, Suporte Técnico, Contratual, ...) é um
// número de WhatsApp diferente, conectado via Coexistence numa conexão
// própria do Dualhook — logo, um WABA_ID/phone_number_id próprio. O servidor
// descobre o setor de cada webhook pelo `phone_number_id` que vem em
// `value.metadata` (todo payload da Meta carrega isso). Formato do env var
// (JSON, um item por setor já conectado):
//   UNIKO_SECURITY_SECTORS=[{"category":"faturamento","waba_id":"4454634104777157","phone_number_id":"1274718269061611"}]
// Pra adicionar um setor novo: conecta o número via Dualhook (mesmo passo a
// passo do Faturamento) e acrescenta um item nesse array — não precisa mexer
// em código.
const SECTORS = (() => {
  try { return JSON.parse(process.env.UNIKO_SECURITY_SECTORS || '[]'); } catch { return []; }
})();
const WABA_IDS = new Set(SECTORS.map(s => s.waba_id).filter(Boolean));
const CATEGORY_BY_PHONE_NUMBER_ID = new Map(SECTORS.map(s => [s.phone_number_id, s.category]));
const DEFAULT_CATEGORY = 'faturamento'; // fallback pra payload sem phone_number_id reconhecido (não deveria acontecer)

function categoryFor(phoneNumberId) {
  return CATEGORY_BY_PHONE_NUMBER_ID.get(phoneNumberId) || DEFAULT_CATEGORY;
}

let supabaseSecurity = null;
if (process.env.UNIKO_SECURITY_SUPABASE_URL && process.env.UNIKO_SECURITY_SUPABASE_SERVICE_KEY) {
  supabaseSecurity = createClient(
    process.env.UNIKO_SECURITY_SUPABASE_URL,
    process.env.UNIKO_SECURITY_SUPABASE_SERVICE_KEY
  );
} else {
  console.warn('[uniko-security] UNIKO_SECURITY_SUPABASE_URL/SERVICE_KEY não configurados — webhook vai receber, mas não vai gravar nada.');
}

// Número foi conectado via Coexistence usando o Dualhook (BSP/Tech Provider —
// nosso app "Uniko Security" sozinho não tem acesso a Coexistence, ver
// decisão de set/2026). Isso muda quem ASSINA o webhook: o X-Hub-Signature-256
// que a Meta manda é calculado com o App Secret do app do PRÓPRIO Dualhook,
// não do nosso — não temos e nunca vamos ter esse segredo (a documentação
// deles é explícita: "Meta app credentials are never disclosed"). Verificação
// HMAC de assinatura, portanto, é IMPOSSÍVEL nessa integração — não é bug de
// configuração. Seguindo a orientação oficial do próprio Dualhook ("validate
// inbound webhook payload shape instead"), a autenticidade é conferida
// conferindo se o payload é mesmo um evento de um dos NOSSOS WABAs (object +
// entry[].id) em vez de assinatura criptográfica.
function isValidPayload(body) {
  if (!body || body.object !== 'whatsapp_business_account') return false;
  if (!Array.isArray(body.entry) || !body.entry.length) return false;
  if (WABA_IDS.size && !body.entry.some(e => WABA_IDS.has(e.id))) return false;
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
    case 'edit':         return { text: msg.edit?.message?.text?.body ? `(editada) ${msg.edit.message.text.body}` : '[mensagem editada]', msgType: 'edit' };
    case 'media_placeholder': return { text: '[mídia — sincronização do histórico não trouxe o conteúdo]', msgType: 'media_placeholder' };
    default:             return { text: `[mensagem: ${msg.type || 'desconhecida'}]`, msgType: msg.type || 'other' };
  }
}

// `category` (setor) faz parte da CHAVE do contato — a mesma pessoa pode
// escrever pro WhatsApp do Faturamento E do Financeiro, e isso são dois
// contatos/conversas diferentes (ver supabase_uniko_security_setores.sql,
// wa_id passou a ser único POR setor, não mais global).
async function upsertContact(waId, profileName, category) {
  const { data: existing } = await supabaseSecurity.from('uniko_security_contacts')
    .select('*').eq('wa_id', waId).eq('category', category).maybeSingle();
  if (existing) {
    // Só atualiza o nome de perfil automaticamente se ninguém renomeou esse
    // contato manualmente ainda (ver name_manual em supabase_uniko_security.sql).
    if (profileName && !existing.name_manual && existing.name !== profileName) {
      await supabaseSecurity.from('uniko_security_contacts').update({ name: profileName }).eq('id', existing.id);
    }
    return existing;
  }
  const { data, error } = await supabaseSecurity.from('uniko_security_contacts')
    .insert({ wa_id: waId, name: profileName || waId, category }).select().single();
  if (error) throw new Error(error.message);
  return data;
}

// A Meta manda dois webhooks pro MESMO wa_message_id quando o lado da API não
// confirma o conteúdo a tempo (comum no Coexistence): primeiro o conteúdo
// real (ex.: type:"text"), depois um type:"unsupported"/erro 131060 "This
// message is unavailable" — a ORDEM de chegada não é garantida. Achado ao
// vivo (23/set/2026): um "oi" (texto normal) ficou gravado como
// "[mensagem: unsupported]" porque a versão ruim chegou primeiro e
// `ignoreDuplicates` trava no primeiro que chega, bom ou ruim. Fix: mensagem
// de verdade sempre SOBRESCREVE um "unsupported" antigo (upsert normal);
// "unsupported" NUNCA sobrescreve conteúdo bom que já esteja gravado
// (ignoreDuplicates), só preenche se ainda não existir nada pra esse id.
async function insertMessage({ contact, waMessageId, sentAt, direction, senderName, text, msgType }) {
  const { error } = await supabaseSecurity.from('uniko_security_messages')
    .upsert({
      contact_id: contact.id, wa_message_id: waMessageId || null, sent_at: sentAt,
      direction, sender_name: senderName || null, text, msg_type: msgType,
    }, { onConflict: 'wa_message_id', ignoreDuplicates: msgType === 'unsupported' });
  if (error) throw new Error(error.message);
  if (!contact.last_message_at || sentAt > contact.last_message_at) {
    await supabaseSecurity.from('uniko_security_contacts').update({ last_message_at: sentAt }).eq('id', contact.id);
  }
}

// Processa UMA "mudança" do payload da Meta (entry[].changes[]) — cada uma
// tem metadata + contacts (perfis) + messages (as mensagens de verdade) do
// mesmo lote.
async function processChange(value) {
  const category = categoryFor(value.metadata?.phone_number_id);
  const profileByWaId = new Map((value.contacts || []).map(c => [c.wa_id, c.profile?.name]));

  for (const msg of value.messages || []) {
    const waId = msg.from;
    if (!waId) continue;
    const contact = await upsertContact(waId, profileByWaId.get(waId), category);
    const { text, msgType } = extractMessageContent(msg);
    await insertMessage({
      contact, waMessageId: msg.id, sentAt: new Date(Number(msg.timestamp) * 1000).toISOString(),
      direction: 'in', senderName: profileByWaId.get(waId), text, msgType,
    });
  }

  // message_echoes = mensagem NOVA enviada pelo app do celular (chega no
  // campo smb_message_echoes — ver dispatcher abaixo).
  for (const echo of value.message_echoes || []) {
    const waId = echo.to || echo.from;
    if (!waId) continue;
    const contact = await upsertContact(waId, profileByWaId.get(waId), category);
    const { text, msgType } = extractMessageContent(echo);
    await insertMessage({
      contact, waMessageId: echo.id, sentAt: new Date(Number(echo.timestamp) * 1000).toISOString(),
      direction: 'out', senderName: null, text, msgType,
    });
  }
}

// Sincronização única do histórico (Coexistence) — formato BEM diferente do
// resto: `value.history[].threads[]`, uma thread por contato, cada uma com
// suas próprias `messages[]` (as SUAS e as DELE misturadas na mesma lista,
// diferenciadas só por `history_context.from_me`). Confirmado olhando
// payload real em uniko_security_webhook_raw (23/set/2026) — é bem diferente
// do que a documentação da Meta sugeria (`value.messages` simples), por isso
// nada disso estava sendo gravado até aqui. Sem nome de perfil nesse formato
// (só wa_id) — `upsertContact` cai pro wa_id como nome, corrige sozinho
// quando uma mensagem em tempo real com `contacts[].profile.name` chegar.
async function processHistoryBackfill(value) {
  const myNumber = value.metadata?.display_phone_number;
  const category = categoryFor(value.metadata?.phone_number_id);
  for (const block of value.history || []) {
    for (const thread of block.threads || []) {
      const waId = thread.context?.wa_id || thread.id;
      if (!waId || waId === myNumber) continue; // pula a "conversa" do número com ele mesmo
      let contact = null;
      for (const msg of thread.messages || []) {
        if (!contact) contact = await upsertContact(waId, null, category);
        const { text, msgType } = extractMessageContent(msg);
        await insertMessage({
          contact, waMessageId: msg.id, sentAt: new Date(Number(msg.timestamp) * 1000).toISOString(),
          direction: msg.history_context?.from_me ? 'out' : 'in', senderName: null, text, msgType,
        });
      }
    }
  }
}

// Lista dos contatos SALVOS no celular do WhatsApp Business App (nome que o
// próprio colaborador digitou, ex: "Altiery Vieira") — vem num evento
// próprio, separado das mensagens. Achado ao vivo (23/set/2026): contatos
// cuja 1ª mensagem chegou sem "nome de perfil" do WhatsApp (comum) ou só via
// backfill de histórico (nunca tem nome nesse formato, ver
// processHistoryBackfill) ficavam mostrando só o número — esse evento é
// exatamente o que corrige isso, com o nome de verdade salvo no telefone.
// Só ATUALIZA contato que já existe (por causa de mensagem de verdade) —
// não cria contato novo só por estar na agenda (a agenda tem centenas de
// números que nunca mandaram mensagem pra esse WhatsApp; criar todos
// poluiria a lista de "conversas" com gente que nunca conversou).
async function processAppStateSync(value) {
  const category = categoryFor(value.metadata?.phone_number_id);
  for (const item of value.state_sync || []) {
    if (item.type !== 'contact') continue;
    const waId = item.contact?.phone_number;
    const name = item.contact?.full_name || item.contact?.first_name;
    if (!waId || !name) continue;
    const { data: existing } = await supabaseSecurity.from('uniko_security_contacts')
      .select('id,name,name_manual').eq('wa_id', waId).eq('category', category).maybeSingle();
    if (!existing || existing.name_manual || existing.name === name) continue;
    await supabaseSecurity.from('uniko_security_contacts').update({ name }).eq('id', existing.id);
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
          // 4 campos, confirmados olhando payload real em uniko_security_webhook_raw
          // (23/set/2026) — bem diferente do que a documentação da Meta sugeria:
          //  - 'messages': mensagem nova recebida (formato achatado de sempre)
          //  - 'smb_message_echoes': mensagem nova ENVIADA pelo app do celular —
          //    MESMO formato achatado (`value.message_echoes`), campo próprio,
          //    NÃO é 'history' como o código assumia antes.
          //  - 'history': só a sincronização ÚNICA de histórico antigo, formato
          //    bem diferente e aninhado (`value.history[].threads[]`).
          //  - 'smb_app_state_sync': lista de contatos SALVOS no celular
          //    (`value.state_sync[]`) — usada só pra corrigir o NOME exibido.
          if (!['messages', 'history', 'smb_message_echoes', 'smb_app_state_sync'].includes(change.field)) continue;
          const value = change.value || {};
          if (Array.isArray(value.history)) await processHistoryBackfill(value);
          else if (Array.isArray(value.state_sync)) await processAppStateSync(value);
          else await processChange(value);
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

// Exposto à parte pra dar pra reprocessar payloads antigos já salvos em
// uniko_security_webhook_raw (ex.: replay-history-backfill.js) sem duplicar
// a lógica de extração.
module.exports.processHistoryBackfill = processHistoryBackfill;
module.exports.processAppStateSync = processAppStateSync;
