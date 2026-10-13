// Agente de manutenção do Uniko — rotas e fila.
//
// Fluxo: o admin cria um "Pedido de Ajuste" (Dashboard RH). O agente pega o
// pedido (automaticamente, se AGENT_AUTO=1, ou pelo botão "Rodar agente"),
// edita o código numa branch, confere o build e abre um pull request. O admin
// vê o resultado na aba e APROVA (merge → a Vercel publica) ou RECUSA (fecha o
// PR e o pedido volta com o comentário, pro agente tentar de novo).
//
// Variáveis de ambiente (.env da VPS):
//   GROQ_API_KEY      já existe (assistente do Uniko) — gratuita, sem cartão
//   GITHUB_TOKEN      fine-grained PAT só do repo do Uniko (Contents + Pull requests: read/write)
//   AGENT_REPO        ex.: nickhexenzirkel/crescent-hub
//   AGENT_WORKDIR     (opcional) onde fica a cópia de trabalho; padrão ./agent-workspace/repo
//   AGENT_AUTO        (opcional) "1" liga a fila automática (1 pedido a cada 3 min)
//   AGENT_MODEL       (opcional) padrão llama-3.3-70b-versatile
const path = require('path');
const { makeProvider } = require('./llm');
const provedores = require('./provedores');
const { makeGithub } = require('./github');
const { runPedido, undoMerge, scrub } = require('./runner');
const acoes = require('./acoes');

module.exports = function registerAgent(app, { requireAdmin, supabase }) {
  const TABLE = 'uniko_pedidos_ajuste';
  // Dois agentes: Groq (grátis) e OpenAI (pago). Cada pedido escolhe o seu (coluna "agente");
  // sem escolha, vale AGENT_PROVIDER (padrão groq). Provedores são criados na hora, por execução.
  const temChave = provedores.temChave(process.env);
  const algumaChave = () => Object.values(temChave).some(Boolean);
  // Troca AUTOMÁTICA: se o agente escolhido falhar por motivo técnico (limite, formato, rodadas), tenta estes em ordem.
  // Ex.: AGENT_FALLBACK=gemini,cerebras  (vazio = desligado; o dono troca na mão pelo seletor da aba).
  const fallbacks = String(process.env.AGENT_FALLBACK || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const padrao = (process.env.AGENT_PROVIDER || 'groq').toLowerCase();
  const escolherProvedor = (p) => { const q = String(p?.agente || padrao).toLowerCase(); return temChave[q] ? q : (temChave[padrao] ? padrao : (provedores.configurados(process.env)[0]?.id || q)); };
  const llm = makeProvider(process.env, padrao);   // só pra mostrar o modelo padrão na tela
  const github = process.env.GITHUB_TOKEN && process.env.AGENT_REPO ? makeGithub({ token: process.env.GITHUB_TOKEN, repo: process.env.AGENT_REPO }) : null;
  const workdir = process.env.AGENT_WORKDIR || path.join(__dirname, '..', 'agent-workspace', 'repo');
  let busy = null; // id do pedido em execução (1 por vez)

  const setStatus = async (id, patch) => {
    const { error } = await supabase.from(TABLE).update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) throw new Error(error.message);
  };
  const getPedido = async (id) => {
    const { data, error } = await supabase.from(TABLE).select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  };
  const notReady = () => (!algumaChave() ? 'Falta a chave de algum agente no servidor (GROQ_API_KEY, GEMINI_API_KEY, CEREBRAS_API_KEY, OPENROUTER_API_KEY, MISTRAL_API_KEY ou OPENAI_API_KEY).' : !github ? 'Falta GITHUB_TOKEN / AGENT_REPO no servidor.' : null);

  async function start(pedido) {
    if (busy) return { started: false, reason: `O agente já está trabalhando no pedido #${busy}.` };
    const nr = notReady(); if (nr) return { started: false, reason: nr };
    busy = pedido.id;
    const qual = escolherProvedor(pedido);
    if (!makeProvider(process.env, qual)) { busy = null; return { started: false, reason: `Falta a chave do agente "${qual}" no servidor.` }; }
    // Primeiro o agente escolhido; se falhar por motivo técnico, os de AGENT_FALLBACK (cada um continua o passo a passo).
    const fila = [qual, ...fallbacks.filter(f => f !== qual && temChave[f])];
    (async () => {
      let logAnterior = null;
      for (let i = 0; i < fila.length; i++) {
        const r = await runPedido(pedido, { llm: makeProvider(process.env, fila[i]), github, workdir, setStatus, supabase, logAnterior, autoPublish: process.env.AGENT_AUTOPUBLISH === '1' });
        if (r && r.ok) return;
        if (!r || !r.tecnico || i === fila.length - 1) return;      // dúvida, sem alterações ou último da fila: para aqui
        logAnterior = `${r.log || ''}\n[${new Date().toISOString().slice(11, 19)}] 🔁 O agente ${fila[i]} não conseguiu — passando para o ${fila[i + 1]}`;
        await setStatus(pedido.id, { agente_log: logAnterior }).catch(() => {});
      }
    })()
      .catch(e => console.error('[agent] erro inesperado:', scrub(e.message)))
      .finally(() => { busy = null; });
    return { started: true };
  }

  app.get('/api/agent/config', requireAdmin, (req, res) => {
    res.json({ llm: temChave.groq || temChave.openai, github: !!github, auto: process.env.AGENT_AUTO === '1', busy, model: llm?.name || null, notReady: notReady(),
      provedores: provedores.detalhes(process.env), padrao, fallback: fallbacks });
  });

  app.post('/api/agent/run/:id', requireAdmin, async (req, res) => {
    try {
      const p = await getPedido(req.params.id);
      if (!p) return res.status(404).json({ error: 'pedido não encontrado' });
      if (!['pendente', 'reaberto', 'falhou'].includes(p.status)) return res.status(409).json({ error: `pedido está "${p.status}"` });
      const r = await start(p);
      if (!r.started) return res.status(409).json({ error: r.reason });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Prévia do pull request (Vercel): a aba pergunta até ficar pronta.
  app.get('/api/agent/preview/:id', requireAdmin, async (req, res) => {
    try {
      if (!github) return res.status(503).json({ error: 'GitHub não configurado no servidor.' });
      const p = await getPedido(req.params.id);
      if (!p || !p.branch) return res.status(404).json({ error: 'este pedido não tem branch' });
      res.json(await github.previewUrl(p.branch));
    } catch (e) { res.status(500).json({ error: scrub(e.message) }); }
  });

  // Aprovar: mescla o PR (a Vercel publica o site sozinha quando a main muda).
  app.post('/api/agent/approve/:id', requireAdmin, async (req, res) => {
    try {
      const p = await getPedido(req.params.id);
      // Ação administrativa esperando aprovação (esconder/renomear/tirar Uniko): aplica agora.
      if (p && p.status === 'em_revisao' && p.acao && !p.acao.aplicada) {
        const r = await acoes.executar(p.acao.plano, { supabase, quem: 'Agente de IA' });
        await setStatus(p.id, { status: 'feito', nota_ia: r.resumo, acao: { ...p.acao, aplicada: true, undo: r.undo, resumo: r.resumo } });
        return res.json({ ok: true });
      }
      if (!github) return res.status(503).json({ error: 'GitHub não configurado no servidor.' });
      if (!p || p.status !== 'em_revisao' || !p.pr_number) return res.status(409).json({ error: 'este pedido não está esperando aprovação' });
      const merged = await github.mergePR(p.pr_number, `IA: ${p.titulo} (#${p.id})`);
      await github.deleteBranch(p.branch);
      await setStatus(p.id, { status: 'feito', merge_sha: merged?.sha || null });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: scrub(e.message) }); }
  });

  // Desfazer: reverte uma mudança que o agente já publicou (commit de reversão na main).
  app.post('/api/agent/undo/:id', requireAdmin, async (req, res) => {
    let travou = false;
    try {
      const p0 = await getPedido(req.params.id);
      // Desfazer uma ação administrativa já aplicada.
      if (p0 && p0.status === 'feito' && p0.acao && p0.acao.aplicada && p0.acao.undo) {
        await acoes.desfazer(p0.acao.undo, { supabase });
        await setStatus(p0.id, { status: 'descartado', nota_ia: 'Ação desfeita.', acao: { ...p0.acao, aplicada: false, undo: null } });
        return res.json({ ok: true });
      }
      if (!github) return res.status(503).json({ error: 'GitHub não configurado no servidor.' });
      const p = p0;
      if (!p || p.status !== 'feito' || !p.merge_sha) return res.status(409).json({ error: 'só dá pra desfazer o que o agente publicou' });
      if (busy) return res.status(409).json({ error: `O agente está ocupado com o pedido #${busy}. Tente em instantes.` });
      busy = p.id; travou = true;
      await undoMerge({ workdir, github, sha: p.merge_sha });
      await setStatus(p.id, { status: 'descartado', nota_ia: 'Mudança desfeita (revertida na versão definitiva).', merge_sha: null });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: scrub(e.message) }); }
    finally { if (travou) busy = null; }
  });

  // Recusar: fecha o PR e devolve o pedido com o comentário (o agente pode tentar de novo).
  app.post('/api/agent/reject/:id', requireAdmin, async (req, res) => {
    try {
      const p = await getPedido(req.params.id);
      if (!p || p.status !== 'em_revisao') return res.status(409).json({ error: 'este pedido não está esperando aprovação' });
      if (github && p.pr_number) { await github.closePR(p.pr_number); await github.deleteBranch(p.branch); }
      const comentario = String((req.body || {}).comentario || '').trim().slice(0, 500) || null;
      await setStatus(p.id, { status: (req.body || {}).descartar ? 'descartado' : 'reaberto', comentario, pr_url: null, pr_number: null, branch: null });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: scrub(e.message) }); }
  });

  // Fila automática (opcional): pega o pedido mais antigo pendente/reaberto.
  if (process.env.AGENT_AUTO === '1') {
    setInterval(async () => {
      if (busy || notReady()) return;
      try {
        const { data } = await supabase.from(TABLE).select('*').in('status', ['pendente', 'reaberto']).order('created_at').limit(1);
        if (data?.length) await start(data[0]);
      } catch (e) { console.error('[agent] fila:', e.message); }
    }, 3 * 60 * 1000);
    console.log('[agent] fila automática ligada (a cada 3 min).');
  }
};
