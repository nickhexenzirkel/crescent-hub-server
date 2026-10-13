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

// ── Modo JSON (plano B) ──────────────────────────────────────────────────────
// Alguns modelos erram o formato nativo de "chamada de ferramenta" (erro
// "Parsing failed"). Nesse modo as ferramentas são descritas no texto e o
// modelo responde com UM objeto JSON {"tool":..., "args":{...}} — funciona com
// qualquer modelo de chat. O histórico é convertido para mensagens de texto.
function jsonSystemExtra(tools) {
  const lista = tools.map(t => `- ${t.name}(${Object.keys(t.parameters.properties).join(', ')}): ${t.description}`).join('\n');
  return `\n\n# COMO USAR AS FERRAMENTAS\nVocê NÃO tem chamada de função nativa. Em cada resposta escreva SOMENTE um objeto JSON válido, sem texto fora dele e sem cercas de código:\n{"tool":"nome_da_ferramenta","args":{"parametro":"valor"}}\nFerramentas:\n${lista}\nUma ferramenta por resposta. Strings em JSON: escape aspas (\\") e quebras de linha (\\n).`;
}
function toJsonMessages(messages, tools) {
  const nomes = new Map();   // tool_call_id → nome
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') out.push({ role: 'system', content: m.content + jsonSystemExtra(tools) });
    else if (m.role === 'assistant' && m.tool_calls?.length) {
      for (const tc of m.tool_calls) nomes.set(tc.id, tc.function.name);
      const tc = m.tool_calls[0];
      let args = {}; try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* mantém vazio */ }
      out.push({ role: 'assistant', content: JSON.stringify({ tool: tc.function.name, args }) });
    } else if (m.role === 'tool') out.push({ role: 'user', content: `RESULTADO de ${nomes.get(m.tool_call_id) || 'ferramenta'}:\n${m.content}` });
    else out.push({ role: m.role, content: m.content || '' });
  }
  return out;
}
// Primeiro objeto JSON balanceado (que o aceita() aprove) dentro de um texto qualquer —
// tolera cercas de código, conversa antes/depois e chaves dentro de strings.
// Modelos costumam colocar quebras de linha/tabs REAIS dentro das strings do JSON (inválido). Escapa-as.
function repairJson(t) {
  let out = '', inStr = false, esc = false;
  for (const c of t) {
    if (inStr) {
      if (esc) { esc = false; out += c; continue; }
      if (c === String.fromCharCode(92)) { esc = true; out += c; continue; }
      if (c === '"') { inStr = false; out += c; continue; }
      const BS = String.fromCharCode(92);
      out += c === String.fromCharCode(10) ? BS + 'n' : c === String.fromCharCode(13) ? BS + 'r' : c === String.fromCharCode(9) ? BS + 't' : c;
    } else { if (c === '"') inStr = true; out += c; }
  }
  return out;
}
function firstJsonObject(text, aceita = () => true) {
  const s = String(text || '');
  for (let i = s.indexOf('{'); i !== -1; i = s.indexOf('{', i + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}' && --depth === 0) {
        const trecho = s.slice(i, j + 1);
        for (const cand of [trecho, repairJson(trecho)]) {
          try { const o = JSON.parse(cand); if (aceita(o)) return o; } catch { /* tenta o reparado / o próximo { */ }
        }
        break;
      }
    }
  }
  return null;
}
// Acha o primeiro objeto JSON balanceado no texto e extrai { tool, args }.
function parseJsonCall(text) {
  const s = String(text || '');
  for (let i = s.indexOf('{'); i !== -1; i = s.indexOf('{', i + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}' && --depth === 0) {
        try {
          const o = JSON.parse(s.slice(i, j + 1));
          const name = o.tool || o.name || o.function;
          if (name) return { id: 'j' + Math.random().toString(36).slice(2, 9), name, args: o.args || o.arguments || o.parameters || {} };
        } catch { /* tenta o próximo { */ }
        break;
      }
    }
  }
  return null;
}

// ── Orçamento de tokens ──────────────────────────────────────────────────────
// O plano gratuito limita tokens POR MINUTO (ex.: 8000) e conta entrada + o
// máximo de saída pedido. Se uma única requisição passa do limite, a Groq
// recusa de vez ("Request too large"). Então cortamos o histórico para caber:
// mantém a instrução (system + pedido) e as rodadas mais recentes inteiras,
// descarta as mais antigas. ~3 caracteres por token (conservador pra código/pt-BR).
const CHARS_POR_TOKEN = 3;
const msgChars = (m) => (m.content ? String(m.content).length : 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);
function trimToBudget(messages, budgetChars) {
  const total = messages.reduce((a, m) => a + msgChars(m), 0);
  if (total <= budgetChars) return messages;
  const head = messages.slice(0, 2);               // system + pedido
  const rest = messages.slice(2);
  // agrupa em rodadas: assistant(+tool_calls) com suas respostas de ferramenta
  const grupos = [];
  for (const m of rest) {
    if (m.role === 'tool' && grupos.length) grupos[grupos.length - 1].push(m);
    else grupos.push([m]);
  }
  let usado = head.reduce((a, m) => a + msgChars(m), 0);
  const mantidos = [];
  for (let i = grupos.length - 1; i >= 0; i--) {
    let g = grupos[i];
    let c = g.reduce((a, m) => a + msgChars(m), 0);
    if (usado + c > budgetChars) {
      if (mantidos.length === 0) {                  // a rodada mais nova sozinha é grande: encurta o resultado das ferramentas
        const sobra = Math.max(600, budgetChars - usado - 400);
        g = g.map(m => (m.role === 'tool' && m.content.length > sobra ? { ...m, content: m.content.slice(0, sobra) + '\n…(cortado)' } : m));
        c = g.reduce((a, m) => a + msgChars(m), 0);
      } else break;
    }
    mantidos.unshift(g); usado += c;
  }
  const out = [...head];
  if (mantidos.length < grupos.length) out.push({ role: 'user', content: '(O histórico mais antigo foi omitido para economizar espaço. Continue a partir do que está abaixo.)' });
  return [...out, ...mantidos.flat()];
}

function groqProvider({ apiKey, model: wanted }) {
  const headers = { Authorization: `Bearer ${apiKey}` };
  let model = null, ids = [];
  let jsonMode = false;
  let tpmLimit = 6000;   // limite de tokens/minuto assumido (aprende com o erro da Groq)
  const excluded = new Set();   // modelos que falharam repetidamente nesta execução

  async function resolve(force = false) {
    if (model && !force) return model;
    const r = await axios.get(`${BASE}/models`, { headers, timeout: 20000 }).catch(e => {
      throw new Error(`Groq: não consegui listar os modelos (${e.response?.data?.error?.message || e.message}). Confira a GROQ_API_KEY.`);
    });
    ids = (r.data?.data || []).map(m => m.id);
    const escolhido = pickModel(ids.filter(id => !excluded.has(id)), wanted);
    if (!escolhido) throw new Error('Groq: sua conta não tem nenhum modelo de chat disponível.');
    model = escolhido;
    return model;
  }

  return {
    get name() { return `groq:${model || wanted || 'auto'}`; },
    ready: () => resolve(),
    // Troca por outro modelo da lista (usado quando o atual erra o formato das ferramentas repetidamente).
    async switchModel() {
      await resolve();
      excluded.add(model);
      const outro = pickModel(ids.filter(id => !excluded.has(id)), null);
      if (!outro) return null;
      model = outro; wanted = null;
      return model;
    },
    get jsonMode() { return jsonMode; },
    enableJsonMode() { jsonMode = true; },
    async chat({ messages, tools, plain = false }) {
      await resolve();
      let reresolvido = false;
      // Caracteres de histórico que cabem: (limite − saída pedida − ~700 das definições de ferramentas) × 3.
      const budgetChars = (saida) => Math.max(5000, (tpmLimit - saida - 700) * CHARS_POR_TOKEN);
      for (let tentativa = 0; tentativa < 5; tentativa++) {
        try {
          if (plain) {   // sem ferramentas: o modelo responde um JSON em texto (usado pelo planejador)
            const r = await axios.post(`${BASE}/chat/completions`, {
              model, messages, temperature: 0.1, max_tokens: 2000,
              ...(/gpt-oss/.test(model) ? { reasoning_effort: 'low' } : null),
            }, { headers, timeout: 120000 });
            return { content: r.data?.choices?.[0]?.message?.content || '', toolCalls: [] };
          }
          if (jsonMode) {
            const r = await axios.post(`${BASE}/chat/completions`, {
              model, messages: toJsonMessages(trimToBudget(messages, budgetChars(2200)), tools), temperature: 0.2, max_tokens: 2200,
              ...(/gpt-oss/.test(model) ? { reasoning_effort: 'low' } : null),
            }, { headers, timeout: 120000 });
            const text = r.data?.choices?.[0]?.message?.content || '';
            const call = parseJsonCall(text);
            return call ? { content: '', toolCalls: [call] } : { content: '', toolCalls: [], formatError: 'resposta sem JSON de ferramenta' };
          }
          const r = await axios.post(`${BASE}/chat/completions`, {
            model, messages: trimToBudget(messages, budgetChars(/gpt-oss/.test(model) ? 2600 : 1800)), temperature: 0.2, max_tokens: 1800,
            tools: tools.map(t => ({ type: 'function', function: t })), tool_choice: 'auto',
            // gpt-oss "pensa" antes de responder: esforço baixo (mais rápido) e mais espaço de saída,
            // senão a chamada de ferramenta é cortada no meio e vira "Parsing failed".
            ...(/gpt-oss/.test(model) ? { reasoning_effort: 'low', max_tokens: 2600 } : null),
          }, { headers, timeout: 120000 });
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
          const mGrande = /Limit (\d+), Requested (\d+)/.exec(msg);
          if (mGrande && /too large|reduce your message/i.test(msg) && tentativa < 3) {
            tpmLimit = Math.max(2500, Math.min(tpmLimit, Number(mGrande[1])) - 800 * (tentativa + 1));   // aprende o limite real e aperta mais a cada tentativa
            continue;
          }
          if (status === 429 || status >= 500) {
            const ra = Number(e.response?.headers?.['retry-after']);
            await sleep((Number.isFinite(ra) && ra > 0 ? ra : 8 * (tentativa + 1)) * 1000 + 500);
            continue;
          }
          // Modelo errou o formato da chamada de ferramenta: devolve como erro recuperável.
          if (status === 400 && /(parsing failed|failed_generation|tool_use_failed|tool call|function)/i.test(JSON.stringify(e.response?.data || ''))) {
            return { content: '', toolCalls: [], formatError: msg || 'formato de ferramenta inválido' };
          }
          throw new Error(`Groq (${model}): ${msg}`);
        }
      }
      throw new Error('Groq: limite de uso atingido (tentei 5 vezes). Tente de novo daqui a alguns minutos.');
    },
  };
}

// Provedores disponíveis: 'groq' (gratuito) e 'openai' (pago, cartão da conta).
// makeProvider(env, 'groq'|'openai') → provedor ou null se faltar a chave.
function makeProvider(env = process.env, escolha = null) {
  const which = String(escolha || env.AGENT_PROVIDER || 'groq').toLowerCase();
  if (which === 'groq') {
    if (!env.GROQ_API_KEY) return null;
    return groqProvider({ apiKey: env.GROQ_API_KEY, model: env.AGENT_MODEL || null });
  }
  if (which === 'openai') {
    if (!env.OPENAI_API_KEY) return null;
    const { openaiProvider } = require('./llm-openai');
    return openaiProvider({ apiKey: env.OPENAI_API_KEY, model: env.AGENT_OPENAI_MODEL || null });
  }
  return null; // provedor desconhecido
}

module.exports = { makeProvider, groqProvider, pickModel, firstJsonObject };
