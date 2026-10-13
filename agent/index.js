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
const { makeGithub } = require('./github');
const { runPedido, scrub } = require('./runner');

module.exports = function registerAgent(app, { requireAdmin, supabase }) {
  const TABLE = 'uniko_pedidos_ajuste';
  const llm = makeProvider(process.env);
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
  const notReady = () => (!llm ? 'Falta GROQ_API_KEY no servidor.' : !github ? 'Falta GITHUB_TOKEN / AGENT_REPO no servidor.' : null);

  async function start(pedido) {
    if (busy) return { started: false, reason: `O agente já está trabalhando no pedido #${busy}.` };
    const nr = notReady(); if (nr) return { started: false, reason: nr };
    busy = pedido.id;
    runPedido(pedido, { llm, github, workdir, setStatus })
      .catch(e => console.error('[agent] erro inesperado:', scrub(e.message)))
      .finally(() => { busy = null; });
    return { started: true };
  }

  app.get('/api/agent/config', requireAdmin, (req, res) => {
    res.json({ llm: !!llm, github: !!github, auto: process.env.AGENT_AUTO === '1', busy, model: llm?.name || null, notReady: notReady() });
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

  // Aprovar: mescla o PR (a Vercel publica o site sozinha quando a main muda).
  app.post('/api/agent/approve/:id', requireAdmin, async (req, res) => {
    try {
      if (!github) return res.status(503).json({ error: 'GitHub não configurado no servidor.' });
      const p = await getPedido(req.params.id);
      if (!p || p.status !== 'em_revisao' || !p.pr_number) return res.status(409).json({ error: 'este pedido não está esperando aprovação' });
      await github.mergePR(p.pr_number, `IA: ${p.titulo} (#${p.id})`);
      await github.deleteBranch(p.branch);
      await setStatus(p.id, { status: 'feito' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: scrub(e.message) }); }
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
