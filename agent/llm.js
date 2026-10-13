// Camada de modelo do agente. Hoje: Groq (gratuito, sem cartão — mesma GROQ_API_KEY
// do assistente do Uniko), API compatível com OpenAI + function calling.
//
// O catálogo da Groq muda com o tempo (modelos são aposentados). Por isso o
// provedor DESCOBRE sozinho um modelo disponível na sua conta (GET /models), na
// ordem de preferência abaixo — ou usa AGENT_MODEL, se você definir e ele existir.
//
// Interface única: chat({ messages, tools }) → { content, toolCalls:[{id,name,args}] }.
// Pra trocar de provedor no futuro (ex.: Claude via API), basta criar outro com
// essa mesma assinatura e escolher em AGENT_PROVIDER — runner.js e tools.js não mudam.
const axios = require('axios');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const BASE = 'https://api.groq.com/openai/v1';

// Do melhor pra "serve": bons em código + chamada de ferramentas primeiro.
const PREFERENCIA = [/gpt-oss-120b/, /kimi-k2/, /llama-3\.3-70b/, /qwen.*(coder|32b)/, /llama-4-maverick/, /gpt-oss-20b/, /llama-4-scout/, /llama-3\.1-70b/, /(70|120)b/];
// Modelos que não são de chat/código.
const EXCLUIR = /whisper|tts|guard|safeguard|orpheus|playai|embed|compound|distil/i;

function pickModel(ids, wanted) {
  if (wanted && ids.includes(wanted)) return wanted;
  const ok = ids.filter(id => !EXCLUIR.test(id));
  for (const re of PREFERENCIA) { const m = ok.find(id => re.test(id)); if (m) return m; }
  return ok[0] || null;
}

function groqProvider({ apiKey, model: wanted }) {
  const headers = { Authorization: `Bearer ${apiKey}` };
  let model = null, ids = [];

  async function resolve(force = false) {
    if (model && !force) return model;
    const r = await axios.get(`${BASE}/models`, { headers, timeout: 20000 }).catch(e => {
      throw new Error(`Groq: não consegui listar os modelos (${e.response?.data?.error?.message || e.message}). Confira a GROQ_API_KEY.`);
    });
    ids = (r.data?.data || []).map(m => m.id);
    const escolhido = pickModel(ids, wanted);
    if (!escolhido) throw new Error('Groq: sua conta não tem nenhum modelo de chat disponível.');
    model = escolhido;
    return model;
  }

  return {
    get name() { return `groq:${model || wanted || 'auto'}`; },
    ready: () => resolve(),
    async chat({ messages, tools }) {
      await resolve();
      let reresolvido = false;
      for (let tentativa = 0; tentativa < 5; tentativa++) {
        try {
          const r = await axios.post(`${BASE}/chat/completions`, {
            model, messages, temperature: 0.2, max_tokens: 2048,
            tools: tools.map(t => ({ type: 'function', function: t })), tool_choice: 'auto',
          }, { headers, timeout: 90000 });
          const m = r.data?.choices?.[0]?.message || {};
          const toolCalls = (m.tool_calls || []).map(tc => {
            let args = {};
            try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { args = { __parse_error: tc.function?.arguments }; }
            return { id: tc.id, name: tc.function?.name, args };
          });
          return { content: m.content || '', toolCalls, raw: m };
        } catch (e) {
          const status = e.response?.status;
          const msg = e.response?.data?.error?.message || e.message;
          // Modelo aposentado / sem acesso: escolhe outro da lista e tenta de novo (1x).
          if (!reresolvido && /model/i.test(msg) && /(does not exist|decommission|not found|no access|do not have access|deprecated)/i.test(msg)) {
            reresolvido = true;
            const antigo = model;
            const lista = ids.filter(id => id !== antigo);
            const outro = pickModel(lista, null);
            if (!outro) throw new Error(`Groq: o modelo ${antigo} não está disponível e não achei outro. Modelos da sua conta: ${ids.join(', ') || '(nenhum)'}`);
            model = outro; wanted = null;
            continue;
          }
          // Limite de tokens/minuto do plano gratuito: espera o que a API mandar e tenta de novo.
          if (status === 429 || status >= 500) {
            const ra = Number(e.response?.headers?.['retry-after']);
            await sleep((Number.isFinite(ra) && ra > 0 ? ra : 8 * (tentativa + 1)) * 1000 + 500);
            continue;
          }
          // Modelo errou o formato da chamada de ferramenta: devolve como erro recuperável.
          if (status === 400 && /tool|function/i.test(JSON.stringify(e.response?.data || ''))) {
            return { content: '', toolCalls: [], formatError: msg || 'formato de ferramenta inválido' };
          }
          throw new Error(`Groq (${model}): ${msg}`);
        }
      }
      throw new Error('Groq: limite de uso atingido (tentei 5 vezes). Tente de novo daqui a alguns minutos.');
    },
  };
}

function makeProvider(env = process.env) {
  const which = (env.AGENT_PROVIDER || 'groq').toLowerCase();
  if (which === 'groq') {
    if (!env.GROQ_API_KEY) return null;
    return groqProvider({ apiKey: env.GROQ_API_KEY, model: env.AGENT_MODEL || null });
  }
  return null; // provedor desconhecido
}

module.exports = { makeProvider, groqProvider, pickModel };
