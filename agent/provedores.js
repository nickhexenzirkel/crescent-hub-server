// Agentes de IA disponíveis, na ordem em que aparecem na tela. Cada um precisa da sua chave no .env.
const { PROVEDORES: COMPAT } = require('./llm-compat');

const LISTA = [
  { id: 'groq', rotulo: 'Groq — grátis', chave: 'GROQ_API_KEY', pago: false },
  ...Object.entries(COMPAT).map(([id, d]) => ({ id, rotulo: d.rotulo, chave: d.chave, pago: false })),
  { id: 'openai', rotulo: 'OpenAI — pago, mais capaz', chave: 'OPENAI_API_KEY', pago: true },
];

const temChave = (env = process.env) => Object.fromEntries(LISTA.map(p => [p.id, !!env[p.chave]]));
const configurados = (env = process.env) => LISTA.filter(p => env[p.chave]);
const detalhes = (env = process.env) => Object.fromEntries(LISTA.map(p => [p.id, { ok: !!env[p.chave], rotulo: p.rotulo, pago: p.pago, chave: p.chave }]));

module.exports = { LISTA, temChave, configurados, detalhes };
