// Provedor OpenAI do agente (pago, usa o cartão da conta). Mesma interface do Groq:
//   chat({ messages, tools, plain }) → { content, toolCalls, formatError? }
// O modelo é DESCOBERTO na conta (GET /v1/models) pela ordem de preferência abaixo — bom em
// código e barato primeiro —, ou fixado com AGENT_OPENAI_MODEL. Também conta os tokens usados
// (`usage`) pra mostrar no passo a passo quanto cada pedido consumiu.
const axios = require('axios');

const BASE = 'https://api.openai.com/v1';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Do preferido pro menos: custo-benefício pra edição de código pequena.
const PREFERENCIA = [/^gpt-5-mini$/, /^gpt-4\.1$/, /^gpt-4o$/, /^gpt-5$/, /^o4-mini$/, /^gpt-4\.1-mini$/, /^gpt-4o-mini$/];
// Fora: áudio, imagem, busca, embeddings, versões datadas (snapshots) e prévias.
const EXCLUIR = /audio|realtime|transcribe|tts|image|search|embed|moderation|whisper|dall|instruct|preview|codex|-\d{4}-\d{2}-\d{2}$|-\d{4}$/;
// Modelos "de raciocínio" não aceitam temperature e usam max_completion_tokens.
const raciocinio = (m) => /^(gpt-5|o\d)/.test(m);

function pickOpenAI(ids, querido, excluidos = new Set()) {
  const ok = ids.filter(id => !excluidos.has(id));
  if (querido && ok.includes(querido)) return querido;
  const livres = ok.filter(id => !EXCLUIR.test(id));
  for (const re of PREFERENCIA) { const m = livres.find(id => re.test(id)); if (m) return m; }
  return livres.filter(id => /^gpt-/.test(id)).sort((a, b) => a.length - b.length)[0] || null;
}

function openaiProvider({ apiKey, model: querido }) {
  const headers = { Authorization: `Bearer ${apiKey}` };
  let model = null, ids = [];
  const excluidos = new Set();
  const usage = { entrada: 0, saida: 0, chamadas: 0 };

  async function resolve() {
    if (model) return model;
    const r = await axios.get(`${BASE}/models`, { headers, timeout: 20000 }).catch(e => {
      throw new Error(`OpenAI: não consegui listar os modelos (${e.response?.data?.error?.message || e.message}). Confira a OPENAI_API_KEY.`);
    });
    ids = (r.data?.data || []).map(m => m.id);
    model = pickOpenAI(ids, querido, excluidos);
    if (!model) throw new Error('OpenAI: sua conta não tem nenhum modelo de chat disponível.');
    return model;
  }

  return {
    get name() { return `openai:${model || querido || 'auto'}`; },
    get usage() { return usage; },
    ready: () => resolve(),
    async switchModel() {
      await resolve();
      excluidos.add(model);
      const outro = pickOpenAI(ids, null, excluidos);
      if (!outro) return null;
      model = outro; querido = null;
      return model;
    },
    async chat({ messages, tools, plain = false }) {
      await resolve();
      for (let tentativa = 0; tentativa < 4; tentativa++) {
        try {
          const body = { model, messages };
          if (raciocinio(model)) body.max_completion_tokens = 4000; else { body.temperature = 0.1; body.max_tokens = 2000; }
          if (!plain && tools?.length) { body.tools = tools.map(t => ({ type: 'function', function: t })); body.tool_choice = 'auto'; }
          const r = await axios.post(`${BASE}/chat/completions`, body, { headers, timeout: 180000 });
          usage.chamadas++; usage.entrada += r.data?.usage?.prompt_tokens || 0; usage.saida += r.data?.usage?.completion_tokens || 0;
          const m = r.data?.choices?.[0]?.message || {};
          const toolCalls = (m.tool_calls || []).map(tc => {
            let args = {};
            try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { args = { __parse_error: tc.function?.arguments }; }
            return { id: tc.id, name: tc.function?.name, args };
          });
          return { content: m.content || '', toolCalls };
        } catch (e) {
          const status = e.response?.status;
          const msg = e.response?.data?.error?.message || e.message;
          const code = e.response?.data?.error?.code;
          if (status === 401) throw new Error('OpenAI: chave inválida (OPENAI_API_KEY).');
          if (code === 'insufficient_quota') throw new Error('OpenAI: sem saldo ou limite de gasto atingido na conta (veja platform.openai.com → Billing).');
          if (status === 404 || (/model/i.test(msg) && /(does not exist|not found|do not have access)/i.test(msg))) {
            excluidos.add(model); const outro = pickOpenAI(ids, null, excluidos);
            if (!outro) throw new Error(`OpenAI: o modelo ${model} não está disponível e não achei outro.`);
            model = outro; continue;
          }
          if (status === 429 || status >= 500) {
            const ra = Number(e.response?.headers?.['retry-after']);
            await sleep((Number.isFinite(ra) && ra > 0 ? ra : 5 * (tentativa + 1)) * 1000 + 300);
            continue;
          }
          throw new Error(`OpenAI (${model}): ${msg}`);
        }
      }
      throw new Error('OpenAI: limite de uso momentâneo (tentei 4 vezes). Tente de novo em instantes.');
    },
  };
}

module.exports = { openaiProvider, pickOpenAI };
