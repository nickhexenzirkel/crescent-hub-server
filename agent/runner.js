// Executa UM pedido de ajuste de ponta a ponta, sem ninguém do lado:
//   clona/atualiza o repo → cria branch → modelo edita via ferramentas →
//   confere o build → commit → push → abre pull request.
// Nada vai pra produção aqui: o merge só acontece quando o admin aprova
// no Uniko (index.js → approve).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, exec } = require('child_process');
const { DEFINITIONS, makeTools } = require('./tools');
const G = require('./guard');
const { buildContext } = require('./context');
const { firstJsonObject } = require('./llm');
const { planSystem, planUser } = require('./prompts');
const acoes = require('./acoes');

const MAX_STEPS = 30;          // voltas do modelo por pedido
const MAX_BUILD_RETRIES = 2;   // quantas vezes devolve o erro do build pro modelo consertar
const MAX_PLAN_ROUNDS = 6;     // chamadas ao modelo no modo planejador
const KEEP_FULL = 4;           // últimas N mensagens de ferramenta ficam completas; as antigas são resumidas

const scrub = (s) => String(s || '').replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@').replace(/(ghp_|github_pat_|gsk_)[A-Za-z0-9_]+/g, '***');

const sh = (cmd, args, cwd, timeout = 120000) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) return reject(new Error(scrub(`${cmd} ${args[0]} falhou: ${(stderr || err.message).toString().slice(-600)}`)));
    resolve(String(stdout));
  });
});
const shell = (cmdline, cwd, timeout) => new Promise((resolve) => {
  exec(cmdline, { cwd, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ ok: !err, out: scrub(`${stdout}\n${stderr}`) }));
});

const readIf = (p, max) => { try { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n').slice(0, max); } catch { return ''; } };

// Notas do vault mais relacionadas ao pedido (pontuação simples por palavras).
function relevantNotes(root, pedido, n = 2) {
  const dir = path.join(root, 'vault', 'Sistema');
  let files = []; try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')); } catch { return []; }
  const words = `${pedido.titulo} ${pedido.descricao || ''} ${pedido.area || ''}`.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '').match(/[a-z0-9]{4,}/g) || [];
  const uniq = [...new Set(words)];
  return files.map(f => {
    const txt = readIf(path.join(dir, f), 6000);
    const hay = (f + ' ' + txt).toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
    const score = uniq.reduce((s, w) => s + (hay.includes(w) ? (f.includes(w) ? 3 : 1) : 0), 0);
    return { f, score, txt };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, n)
    .map(x => `### ${x.f}\n${x.txt.replace(/^---[\s\S]*?---\n/, '').slice(0, 700)}`);
}

function systemPrompt(root, pedido) {
  const regras = readIf(path.join(root, 'vault', 'Regras da IA.md'), 1500).replace(/^---[\s\S]*?---\n/, '');
  const conv = readIf(path.join(root, 'vault', 'Convenções.md'), 1800).replace(/^---[\s\S]*?---\n/, '');
  const notas = relevantNotes(root, pedido).join('\n\n');
  return `Você é o agente de manutenção do sistema Uniko (React + Vite). Faz PEQUENAS mudanças pedidas pelo dono, que não é programador.
Trabalhe assim: 1) use search/list_dir para achar o arquivo certo; 2) read_file só no trecho necessário; 3) replace_in_file com o menor trecho possível; 4) chame finish com um resumo simples em português.
Regras: mudança mínima; mantenha o estilo do código vizinho (estilos inline, tema T); textos da interface em português do Brasil; nunca invente arquivos ou funções que não viu; se o pedido for grande, perigoso ou ambíguo demais, chame finish explicando por que não fez.
Você só pode escrever em: ${G.WRITE_ROOTS.join(', ')}. Áreas de RH, ponto, login, permissões e conversas gravadas são proibidas.

# Regras do projeto
${regras}

# Convenções
${conv}
${notas ? `\n# Notas relacionadas\n${notas}` : ''}`;
}

function userPrompt(p) {
  let t = `Pedido #${p.id}: ${p.titulo}\n${p.descricao ? `Detalhes: ${p.descricao}\n` : ''}${p.area ? `Tela/módulo: ${p.area}\n` : ''}`;
  if (p.status === 'reaberto') t += `\nATENÇÃO — este pedido foi reaberto. Antes foi feito: ${p.nota_ia || '—'}\nO dono disse: ${p.comentario || '—'}\nCorrija levando isso em conta.`;
  return t;
}

// Mantém o histórico curto: resultados antigos de ferramentas viram uma linha.
function compact(messages) {
  const idxs = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter(i => i >= 0);
  for (const i of idxs.slice(0, Math.max(0, idxs.length - KEEP_FULL))) {
    if (messages[i].content.length > 300) messages[i] = { ...messages[i], content: messages[i].content.slice(0, 200) + ' …(resumido)' };
  }
}

async function prepareWorkspace({ root, github, branch, skipInstall, log }) {
  if (!fs.existsSync(path.join(root, '.git'))) {
    fs.mkdirSync(path.dirname(root), { recursive: true });
    log('📥 Clonando o repositório (1ª vez, demora)…');
    await sh('git', ['clone', github.cloneUrl, root], path.dirname(root), 600000);
  } else {
    await sh('git', ['remote', 'set-url', 'origin', github.cloneUrl], root);
  }
  await sh('git', ['fetch', 'origin', 'main', '--prune'], root, 300000);
  await sh('git', ['checkout', '-f', '-B', branch, 'origin/main'], root);
  await sh('git', ['clean', '-fd'], root);   // sem -x: node_modules (ignorado) fica
  if (skipInstall) return;
  const lockFile = path.join(root, 'package-lock.json');
  const hash = crypto.createHash('sha1').update(readIf(lockFile, 50 * 1024 * 1024)).digest('hex');
  const stamp = path.join(root, 'node_modules', '.agent-lock-hash');
  if (!fs.existsSync(path.join(root, 'node_modules')) || readIf(stamp, 100) !== hash) {
    log('📦 Instalando dependências (pode demorar)…');
    await sh('npm', ['ci', '--no-audit', '--no-fund'], root, 900000);
    fs.writeFileSync(stamp, hash);
  }
}

/**
 * deps: { llm, github, workdir, setStatus(id, patch), buildCmd, skipInstall?, log? }
 */
async function runPedido(pedido, deps) {
  const { llm, github, workdir, setStatus } = deps;
  const buildCmd = deps.buildCmd || 'npx vite build';
  const lines = [];
  let lastPush = 0;
  const flushLog = () => lines.join('\n').slice(-6000);
  // Cada linha do log vai pro banco quase em tempo real (a aba Pedidos de Ajuste mostra ao vivo).
  const log = (m, force = false) => {
    const l = `[${new Date().toISOString().slice(11, 19)}] ${m}`;
    lines.push(l); (deps.log || console.log)(`[agent #${pedido.id}] ${m}`);
    if (force || Date.now() - lastPush > 1500) { lastPush = Date.now(); Promise.resolve(setStatus(pedido.id, { agente_log: flushLog() })).catch(() => {}); }
  };
  const um = (t, n = 90) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n);
  // Descreve em português o que a ferramenta está fazendo (é o que o dono lê na tela).
  const descreve = (name, a, out) => {
    switch (name) {
      case 'list_dir': return `📁 Olhando a pasta ${a.path}`;
      case 'search': {
        const achou = out !== 'nenhum resultado';
        const n = String(out).split('\n').filter(Boolean).length;
        return `🔎 Procurando "${um(a.text, 50)}" — ${achou ? `${n} resultado(s), ex.: ${um(String(out).split('\n')[0], 70)}` : 'nada encontrado'}`;
      }
      case 'read_file': return `📖 Lendo ${a.path}${a.start_line ? ` (linhas ${a.start_line}–${a.end_line || a.start_line + 199})` : ''}`;
      case 'replace_in_file': return `✏️ EDITANDO ${a.path}\n     antes:  ${um(a.old_string)}\n     depois: ${um(a.new_string)}`;
      case 'create_file': return `🆕 CRIANDO ${a.path}`;
      case 'finish': return `🏁 Terminou: ${um(a.summary, 120)}`;
      default: return name;
    }
  };
  const branch = `ia/pedido-${pedido.id}-${Date.now().toString(36)}`;

  await setStatus(pedido.id, { status: 'em_andamento', agente_log: null, nota_ia: null });
  try {
    await prepareWorkspace({ root: workdir, github, branch, skipInstall: deps.skipInstall, log });
    const tools = makeTools(workdir);
    const messages = [{ role: 'system', content: systemPrompt(workdir, pedido) }, { role: 'user', content: userPrompt(pedido) }];
    if (llm.ready) await llm.ready();   // descobre o modelo disponível na conta
    log(`🤖 Agente iniciado (modelo ${llm.name}). Pedido: ${um(pedido.titulo, 80)}`, true);

    let summary = null, buildRetries = 0, formatErrors = 0;
    const mode = deps.mode || process.env.AGENT_MODE || 'plan';
    // Provedores pagos (OpenAI) contam os tokens: mostra no passo a passo quanto o pedido consumiu.
    const logUso = () => { const u = llm.usage; if (u && u.chamadas) log(`💲 Uso do modelo: ${u.entrada} tokens de entrada + ${u.saida} de saída em ${u.chamadas} chamada(s)`); };

    // 1º: o pedido é uma AÇÃO ADMINISTRATIVA (esconder/renomear módulo ou aba, tirar um Uniko de alguém)?
    // Então não mexe em código: o modelo só entende o pedido e quem executa é código validado (acoes.js).
    if (deps.supabase && mode !== 'tools') {
      const acao = await acoes.interpretar({ llm, root: workdir, pedido, supabase: deps.supabase });
      if (acao && (acao.duvida || acao.erro)) {
        const nota = acao.duvida ? `Preciso de uma informação pra continuar: ${acao.duvida}` : `Não consegui fazer essa ação: ${acao.erro}`;
        log(`❓ ${nota}`, true);
        await setStatus(pedido.id, { status: 'falhou', nota_ia: nota, agente_log: flushLog() });
        return { ok: false, reason: nota };
      }
      if (acao && acao.plano) {
        logUso();
        log(`🎯 Ação administrativa (não é mudança de código): ${acao.descricao}`, true);
        if (pedido.auto_publicar || deps.autoPublish) {
          const r = await acoes.executar(acao.plano, { supabase: deps.supabase, quem: 'Agente de IA' });
          log(`✅ ${r.resumo}`, true);
          await setStatus(pedido.id, { status: 'feito', nota_ia: r.resumo, acao: { plano: acao.plano, aplicada: true, undo: r.undo, resumo: r.resumo }, agente_log: flushLog() });
        } else {
          log('⏸️ Aguardando a sua aprovação pra aplicar.', true);
          await setStatus(pedido.id, { status: 'em_revisao', nota_ia: `Vou fazer: ${acao.descricao}. Clique em Aplicar pra confirmar.`, acao: { plano: acao.plano, aplicada: false }, agente_log: flushLog() });
        }
        return { ok: true, acao: true };
      }
      log('💡 Não é uma ação administrativa — vou resolver mexendo no código.');
    }

    const planLoop = async () => {
      const ctx = await buildContext(workdir, pedido);
      log(`🧭 Contexto montado sem gastar o modelo — arquivos prováveis: ${ctx.files.length ? ctx.files.join(', ') : 'nenhum óbvio'}`, true);
      const sistema = planSystem(workdir);
      let extra = '', feedback = '', badJson = 0;
      const aplicados = [];
      // Desfaz TODAS as edições já aplicadas: os números de linha mostrados no contexto voltam a valer
      // (sem isso, depois de uma edição os números mudam e o modelo erra o alvo na rodada seguinte).
      const desfazerTudo = async () => {
        await sh('git', ['checkout', '--', '.'], workdir).catch(() => {});
        await sh('git', ['clean', '-fd', '--', 'src', 'vault'], workdir).catch(() => {});
        tools.changed.clear(); aplicados.length = 0;
      };
      for (let round = 1; round <= MAX_PLAN_ROUNDS; round++) {
        log(`💬 Consultando o modelo (rodada ${round} de ${MAX_PLAN_ROUNDS})…`, true);
        const reply = await llm.chat({ messages: [{ role: 'system', content: sistema }, { role: 'user', content: planUser(userPrompt(pedido), ctx, extra, feedback, aplicados) }], tools: [], plain: true });
        const o = firstJsonObject(reply.content, x => x && (Array.isArray(x.edits) || x.need || x.give_up));
        if (!o) {
          badJson++;
          log(`⚠️ A resposta do modelo não veio em JSON válido (${badJson}ª vez): ${um(reply.content, 100)}`);
          if (badJson >= 2 && llm.switchModel) { const novo = await llm.switchModel(); if (novo) log(`🔄 Trocando de modelo para ${novo}`, true); }
          feedback = 'Sua resposta anterior não era um JSON válido (talvez tenha sido CORTADA por ser longa). Responda SOMENTE o objeto JSON e prefira operações POR LINHA (op/start/end/to/expect), que são curtas — não copie linhas longas.';
          continue;
        }
        feedback = '';
        if (o.give_up) return `Sem alterações: ${String(o.give_up).slice(0, 300)}`;
        if (o.need) {
          const partes = [];
          for (const q of (o.need.search || []).slice(0, 3)) {
            try { partes.push(`Busca "${q}":\n${await tools.impl.search({ text: String(q) })}`); log(descreve('search', { text: q }, partes[partes.length - 1])); }
            catch (e) { partes.push(`Busca "${q}": erro ${e.message}`); }
          }
          for (const f of (o.need.read || []).slice(0, 2)) {
            try { partes.push(await tools.impl.read_file({ path: f.path, start_line: f.start, end_line: f.end })); log(descreve('read_file', { path: f.path, start_line: f.start, end_line: f.end })); }
            catch (e) { partes.push(`Leitura de ${f.path}: erro ${e.message}`); }
          }
          extra += (extra ? '\n' : '') + partes.join('\n');
          continue;
        }
        const erros = [];
        // Operações por linha do MESMO arquivo vão juntas (valem contra a numeração original).
        const porLinha = new Map(), outras = [];
        for (const e of o.edits) { if (e && e.op) { if (!porLinha.has(e.path)) porLinha.set(e.path, []); porLinha.get(e.path).push(e); } else outras.push(e); }
        for (const [p, ops] of porLinha) {
          try {
            const antes = readIf(path.join(workdir, p), 5e6).split('\n');
            await tools.impl.edit_lines({ path: p, ops });
            aplicados.push(p);
            for (const op of ops) {
              const alvo = um(antes.slice(op.start - 1, (op.end || op.start)).join(' '), 80);
              const quando = op.op === 'move' ? `movendo as linhas ${op.start}${op.end && op.end !== op.start ? `-${op.end}` : ''} para antes da linha ${op.to}` : op.op === 'delete' ? `apagando as linhas ${op.start}-${op.end || op.start}` : op.op === 'replace' ? `trocando as linhas ${op.start}-${op.end || op.start}` : `inserindo ${op.op === 'insert_after' ? 'depois' : 'antes'} da linha ${op.start}`;
              log(`✏️ EDITANDO ${p} — ${quando}\n     linha: ${alvo}`, true);
            }
          } catch (err) { erros.push(`${p}: ${err.message}`); log(`⚠️ ${p} não deu: ${um(err.message, 200)}`); }
        }
        for (const e of outras) {
          try {
            if (e.create) await tools.impl.create_file({ path: e.path, content: e.content });
            else await tools.impl.replace_in_file({ path: e.path, old_string: e.old_string, new_string: e.new_string });
            aplicados.push(e.path);
            log(descreve(e.create ? 'create_file' : 'replace_in_file', e), true);
          } catch (err) { erros.push(`${e.path}: ${err.message}`); log(`⚠️ ${e.path} não deu: ${um(err.message, 160)}`); }
        }
        if (erros.length) {
          await desfazerTudo();
          log('↩️ Houve erro em alguma edição — desfiz todas pra recomeçar com os números de linha originais', true);
          feedback = `Estas edições FALHARAM: ${erros.join(' | ')}. TODAS as suas edições desta resposta foram DESFEITAS (nada foi alterado), então os números de linha são os do código mostrado. Envie de novo o conjunto COMPLETO de edições, corrigido (ou use "need" para ver mais código).`;
          continue;
        }
        if (!tools.changed.size) { feedback = 'Nenhuma edição foi aplicada. Envie "edits" com old_string e new_string, ou "give_up".'; continue; }
        log('🔨 Conferindo se o site continua montando (build)…', true);
        const b = await shell(buildCmd, workdir, 300000);
        if (b.ok) { log('✅ Build passou — o site monta normalmente', true); return o.summary || 'Ajuste feito.'; }
        if (++buildRetries > MAX_BUILD_RETRIES) throw new Error(`o build falhou mesmo após ${MAX_BUILD_RETRIES} correções:\n${b.out.slice(-500)}`);
        log(`❌ O build falhou — mostrando o erro ao modelo pra corrigir (tentativa ${buildRetries})`, true);
        await desfazerTudo();
        log('↩️ Desfiz as edições (o build quebrou) para tentar de novo com os números de linha originais', true);
        feedback = `O BUILD FALHOU com as suas edições, então elas foram DESFEITAS (o código voltou ao original e os números de linha são os do código mostrado). Provável causa: um número de linha errado deixou a sintaxe quebrada (ex.: "to" caiu numa linha que abre ou fecha a lista, e não entre os itens dela). Envie o conjunto COMPLETO corrigido. Erro do build:\n${b.out.slice(-1000)}`;
      }
      throw new Error(`não consegui concluir em ${MAX_PLAN_ROUNDS} rodadas`);
    };
    if (mode === 'plan') summary = await planLoop();

    for (let step = 1; mode !== 'plan' && step <= MAX_STEPS && summary === null; step++) {
      compact(messages);
      const reply = await llm.chat({ messages, tools: DEFINITIONS });
      if (reply.formatError) {
        formatErrors++;
        log(`⚠️ O modelo errou o formato de uma ação (${formatErrors}ª vez): ${um(reply.formatError, 120)}`);
        // 2º erro: passa pro modo JSON (ferramentas descritas em texto, funciona com qualquer modelo).
        // 4º, 6º…: troca de modelo (outro da conta).
        if (formatErrors === 2 && llm.enableJsonMode && !llm.jsonMode) {
          llm.enableJsonMode();
          log('🔁 Mudando a forma de falar com o modelo (modo JSON)', true);
        } else if (formatErrors >= 4 && formatErrors % 2 === 0 && llm.switchModel) {
          const novo = await llm.switchModel();
          if (novo) log(`🔄 Trocando de modelo para ${novo}`, true);
        }
        if (formatErrors > 8) throw new Error('os modelos não conseguiram usar as ferramentas direito (formato inválido)');
        messages.push({ role: 'user', content: 'Sua última chamada de ferramenta veio com formato inválido. Tente de novo, com argumentos em JSON válido.' });
        continue;
      }
      if (!reply.toolCalls.length) {
        // Respondeu só texto: se já mexeu em algo, conta como fim; senão, empurra pra agir.
        if (tools.changed.size) { summary = reply.content || 'Ajuste feito.'; break; }
        messages.push({ role: 'assistant', content: reply.content || '' });
        messages.push({ role: 'user', content: 'Use as ferramentas para fazer a mudança, ou chame finish explicando por que não dá.' });
        continue;
      }
      messages.push({ role: 'assistant', content: reply.content || null, tool_calls: reply.toolCalls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: JSON.stringify(tc.args) } })) });
      for (const tc of reply.toolCalls) {
        let out;
        try {
          if (!tools.impl[tc.name]) throw new Error(`ferramenta desconhecida: ${tc.name}`);
          if (tc.args.__parse_error !== undefined) throw new Error('argumentos não são JSON válido');
          out = await tools.impl[tc.name](tc.args);
          log(descreve(tc.name, tc.args, out), tc.name === 'replace_in_file' || tc.name === 'create_file');
          if (tc.name === 'finish') {
            // Antes de aceitar o fim: o build precisa passar.
            if (!tools.changed.size) { summary = `Sem alterações: ${out || 'o agente decidiu não mexer.'}`; break; }
            log('🔨 Conferindo se o site continua montando (build)…', true);
            const b = await shell(buildCmd, workdir, 300000);
            if (!b.ok) {
              if (++buildRetries > MAX_BUILD_RETRIES) throw new Error(`o build falhou mesmo após ${MAX_BUILD_RETRIES} correções:\n${b.out.slice(-500)}`);
              log(`❌ O build falhou — mostrando o erro ao agente pra ele corrigir (tentativa ${buildRetries})`, true);
              out = `O BUILD FALHOU. Corrija e chame finish de novo. Erro:\n${b.out.slice(-1500)}`;
            } else { log('✅ Build passou — o site monta normalmente', true); summary = out || 'Ajuste feito.'; }
          }
        } catch (e) { out = `ERRO: ${e.message}`; log(`⚠️ ${tc.name}${tc.args?.path ? ' em ' + tc.args.path : ''} não deu: ${um(e.message, 160)}`); }
        messages.push({ role: 'tool', tool_call_id: tc.id, content: String(out).slice(0, 14000) });
      }
    }
    if (summary === null) throw new Error(`passou de ${MAX_STEPS} passos sem terminar`);

    if (!tools.changed.size) {
      await setStatus(pedido.id, { status: 'falhou', nota_ia: summary, agente_log: flushLog() });
      return { ok: false, reason: summary };
    }
    if (tools.totalLines() > G.MAX_CHANGED_LINES) throw new Error(`mudança grande demais (${tools.totalLines()} linhas, máx. ${G.MAX_CHANGED_LINES}) — peça em partes menores`);

    // Defesa em profundidade: revisa o que de fato vai no commit.
    await sh('git', ['add', '-A', '--', 'src', 'vault'], workdir);
    const files = (await sh('git', ['diff', '--cached', '--name-only'], workdir)).split('\n').filter(Boolean);
    for (const f of files) G.assertWritable(f);
    if (!files.length) throw new Error('nenhuma diferença no git');
    await sh('git', ['-c', 'user.name=Uniko IA', '-c', 'user.email=ia@uniko.local', 'commit', '-m', `IA: ${pedido.titulo}\n\nPedido de ajuste #${pedido.id}.\n${summary}`], workdir);
    await sh('git', ['push', 'origin', `HEAD:refs/heads/${branch}`], workdir, 180000);
    logUso();
    log(`📤 Mudança enviada para a branch ${branch}`, true);

    const pr = await github.createPR({ head: branch, title: `IA: ${pedido.titulo}`, body: `Pedido de ajuste #${pedido.id}\n\n${summary}\n\nArquivos:\n${files.map(f => `- ${f}`).join('\n')}\n\n_Gerado pelo agente do Uniko. Revise antes de aprovar._` });
    // Modo automático: publica direto na versão definitiva assim que o build passou (o dono pediu
    // "troca assim que estiver tudo pronto"). Se não conseguir mesclar, cai no fluxo de aprovação.
    if (pedido.auto_publicar || deps.autoPublish) {
      log('🚀 Publicando direto na versão definitiva (modo automático)…', true);
      try {
        let merged = null, lastErr = null;
        for (let i = 0; i < 6 && !merged; i++) {
          try { merged = await github.mergePR(pr.number, `IA: ${pedido.titulo} (#${pedido.id})`); }
          catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 3000)); }   // o GitHub leva uns segundos pra calcular se dá pra mesclar
        }
        if (!merged) throw lastErr || new Error('não consegui mesclar');
        await Promise.resolve(github.deleteBranch(branch)).catch(() => {});
        log('✅ Publicado! A Vercel atualiza o site em ~1 minuto.', true);
        await setStatus(pedido.id, { status: 'feito', nota_ia: summary, pr_url: pr.url, pr_number: pr.number, branch: null, merge_sha: merged.sha || null, agente_log: flushLog() });
        return { ok: true, pr, files, summary, published: true };
      } catch (e) {
        log(`⚠️ Não consegui publicar sozinho (${um(scrub(e.message), 120)}) — ficou aguardando a sua aprovação.`, true);
      }
    }
    await setStatus(pedido.id, { status: 'em_revisao', nota_ia: summary, pr_url: pr.url, pr_number: pr.number, branch, agente_log: flushLog() });
    log(`🔀 Pull request aberto: ${pr.url}`, true);
    return { ok: true, pr, files, summary };
  } catch (e) {
    log(`💥 Falhou: ${um(scrub(e.message), 200)}`, true);
    await setStatus(pedido.id, { status: 'falhou', nota_ia: scrub(e.message).slice(0, 600), agente_log: flushLog() }).catch(() => {});
    return { ok: false, reason: e.message };
  }
}

// Desfaz uma mudança já publicada: cria um commit de reversão na main (não apaga histórico).
async function undoMerge({ workdir, github, sha }) {
  await prepareWorkspace({ root: workdir, github, branch: 'ia/desfazer-tmp', skipInstall: true, log: () => {} });
  const cfg = ['-c', 'user.name=Uniko IA', '-c', 'user.email=ia@uniko.local'];
  try { await sh('git', [...cfg, 'revert', '--no-edit', sha], workdir); }
  catch (e) { await sh('git', ['revert', '--abort'], workdir).catch(() => {}); throw new Error('não consegui desfazer sozinho (a main mudou depois dessa alteração) — peça um novo ajuste para reverter'); }
  await sh('git', ['push', 'origin', 'HEAD:refs/heads/main'], workdir, 180000);
}

module.exports = { runPedido, undoMerge, scrub };
