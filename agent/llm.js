// Camada de modelo do agente. Hoje: Groq (gratuito, sem cartão — mesma GROQ_API_KEY
// do assistente do Uniko), API compatível com OpenAI + function calling.
//
// Interface única: chat({ messages, tools }) → { content, toolCalls:[{id,name,args}] }.
// Pra trocar de modelo/provedor no futuro (ex.: Claude via API, se um dia
// quiser mais qualidade), basta criar outro provedor com essa mesma assinatura
// e escolher em AGENT_PROVIDER — runner.js e tools.js não mudam.
const axios = require('axios');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function groqProvider({ apiKey, model }) {
  return {
    name: `groq:${model}`,
    async chat({ messages, tools }) {
      for (let tentativa = 0; tentativa < 5; tentativa++) {
        try {
          const r = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model, messages, temperature: 0.2, max_tokens: 2048,
            tools: tools.map(t => ({ type: 'function', function: t })), tool_choice: 'auto',
          }, { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 90000 });
          const m = r.data?.choices?.[0]?.message || {};
          const toolCalls = (m.tool_calls || []).map(tc => {
            let args = {};
            try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { args = { __parse_error: tc.function?.arguments }; }
            return { id: tc.id, name: tc.function?.name, args };
          });
          return { content: m.content || '', toolCalls, raw: m };
        } catch (e) {
          const status = e.response?.status;
          // Limite de tokens/minuto do plano gratuito: espera o que a API mandar e tenta de novo.
          if (status === 429 || status >= 500) {
            const ra = Number(e.response?.headers?.['retry-after']);
            await sleep((Number.isFinite(ra) && ra > 0 ? ra : 8 * (tentativa + 1)) * 1000 + 500);
            continue;
          }
          // Modelo errou o formato da chamada de ferramenta: devolve como erro recuperável.
          if (status === 400 && /tool|function/i.test(JSON.stringify(e.response?.data || ''))) {
            return { content: '', toolCalls: [], formatError: e.response.data?.error?.message || 'formato de ferramenta inválido' };
          }
          throw new Error(`Groq: ${e.response?.data?.error?.message || e.message}`);
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
    return groqProvider({ apiKey: env.GROQ_API_KEY, model: env.AGENT_MODEL || 'llama-3.3-70b-versatile' });
  }
  return null; // provedor desconhecido
}

module.exports = { makeProvider, groqProvider };
