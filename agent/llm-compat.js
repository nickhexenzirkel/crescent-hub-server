// Provedores GRATUITOS (ou com plano grátis) que falam o mesmo "idioma" da OpenAI
// (POST /chat/completions): Google Gemini, Cerebras, OpenRouter (modelos ":free") e Mistral.
// Mesma interface dos outros (Groq/OpenAI): chat({ messages, tools, plain }).
// O modelo é DESCOBERTO na conta (GET /models) pela ordem de preferência de cada provedor,
// ou fixado com AGENT_<NOME>_MODEL (ex.: AGENT_GEMINI_MODEL). Limites e catálogos dos planos
// grátis mudam com o tempo — por isso a escolha é automática e há troca de modelo em caso de erro.
const axios = require('axios');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const PROVEDORES = {
  gemini: {
    rotulo: 'Google Gemini — grátis', chave: 'GEMINI_API_KEY', base: 'https://generativelanguage.googleapis.com/v1beta/openai',
    limpar: (id) => id.replace(/^models\//, ''),
    preferencia: [/^gemini-2\.5-flash$/, /^gemini-2\.5-pro$/, /^gemini-2\.0-flash$/, /^gemini-.*flash(?!.*(lite|image|thinking|tts|live|exp))/],
    excluir: /embed|aqa|imagen|veo|tts|live|image|vision|learnlm|gemma/i,
  },
  cerebras: {
    rotulo: 'Cerebras — grátis', chave: 'CEREBRAS_API_KEY', base: 'https://api.cerebras.ai/v1',
    preferencia: [/gpt-oss-120b/, /qwen-3-235b/, /qwen.*coder/, /llama-?3\.3-70b/, /(120|235|70)b/],
    excluir: /embed|guard/i,
  },
  openrouter: {
    rotulo: 'OpenRouter — modelos grátis', chave: 'OPENROUTER_API_KEY', base: 'https://openrouter.ai/api/v1',
    soGratis: true,   // só ids terminados em ":free"
    preferencia: [/qwen.*coder.*:free$/, /gpt-oss-120b:free$/, /deepseek.*(v3|r1).*:free$/, /llama-3\.3-70b.*:free$/, /(70|120|235)b.*:free$/, /:free$/],
    excluir: /embed|guard|vision|image|audio/i,
  },
  mistral: {
    rotulo: 'Mistral — grátis', chave: 'MISTRAL_API_KEY', base: 'https://api.mistral.ai/v1',
    preferencia: [/^codestral-latest$/, /^mistral-large-latest$/, /^mistral-medium-latest$/, /^mistral-small-latest$/, /^mistral-.*-latest$/],
    excluir: /embed|moderation|ocr|voxtral|pixtral/i,
  },
};

function pickCompat(def, ids, querido, excluidos = new Set()) {
  let ok = ids.map(def.limpar || (x => x)).filter(id => !excluidos.has(id));
  if (def.soGratis) ok = ok.filter(id => /:free$/.test(id));
  if (querido && ok.includes(querido)) return querido;
  const livres = ok.filter(id => !def.excluir.test(id));
  for (const re of def.preferencia) { const m = livres.find(id => re.test(id)); if (m) return m; }
  return livres[0] || null;
}

function compatProvider(nome, { apiKey, model: querido }) {
  const def = PROVEDORES[nome];
  const headers = { Authorization: `Bearer ${apiKey}` };
  if (nome === 'openrouter') { headers['HTTP-Referer'] = 'https://www.centraluniko.com.br'; headers['X-Title'] = 'Uniko'; }
  let model = null, ids = [];
  const excluidos = new Set();
  const usage = { entrada: 0, saida: 0, chamadas: 0 };

  async function resolve() {
    if (model) return model;
    const r = await axios.get(`${def.base}/models`, { headers, timeout: 20000 }).catch(e => {
      throw new Error(`${nome}: não consegui listar os modelos (${e.response?.data?.error?.message || e.response?.data?.message || e.message}). Confira a ${def.chave}.`);
    });
    const lista = r.data?.data || r.data?.models || [];
    ids = lista.map(m => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
    model = pickCompat(def, ids, querido, excluidos);
    if (!model) throw new Error(`${nome}: não achei um modelo de chat disponível na conta.`);
    return model;
  }

  return {
    get name() { return `${nome}:${model || querido || 'auto'}`; },
    get usage() { return usage; },
    ready: () => resolve(),
    async switchModel() {
      await resolve();
      excluidos.add(model);
      const outro = pickCompat(def, ids, null, excluidos);
      if (!outro) return null;
      model = outro; querido = null;
      return model;
    },
    async chat({ messages, tools, plain = false }) {
      await resolve();
      for (let tentativa = 0; tentativa < 4; tentativa++) {
        try {
          const body = { model, messages, temperature: 0.1, max_tokens: 2500 };
          if (!plain && tools?.length) { body.tools = tools.map(t => ({ type: 'function', function: t })); body.tool_choice = 'auto'; }
          const r = await axios.post(`${def.base}/chat/completions`, body, { headers, timeout: 180000 });
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
          const raw = e.response?.data;
          const msg = (Array.isArray(raw) ? raw[0]?.error?.message : raw?.error?.message) || raw?.message || e.message;
          if (status === 401 || status === 403) throw new Error(`${nome}: chave recusada (${def.chave}) — ${String(msg).slice(0, 120)}`);
          if (status === 404 || (/model/i.test(String(msg)) && /(not found|does not exist|no access|not available|unsupported)/i.test(String(msg)))) {
            excluidos.add(model); const outro = pickCompat(def, ids, null, excluidos);
            if (!outro) throw new Error(`${nome}: o modelo ${model} não está disponível e não achei outro.`);
            model = outro; continue;
          }
          if (status === 429 || status >= 500) {
            const ra = Number(e.response?.headers?.['retry-after']);
            await sleep((Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) : 6 * (tentativa + 1)) * 1000 + 300);
            continue;
          }
          throw new Error(`${nome} (${model}): ${String(msg).slice(0, 300)}`);
        }
      }
      throw new Error(`${nome}: limite de uso do plano grátis atingido (tentei 4 vezes). Tente outro agente ou aguarde um pouco.`);
    },
  };
}

module.exports = { compatProvider, PROVEDORES, pickCompat };
