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

const MAX_STEPS = 30;          // voltas do modelo por pedido
const MAX_BUILD_RETRIES = 2;   // quantas vezes devolve o erro do build pro modelo consertar
const KEEP_FULL = 6;           // últimas N mensagens de ferramenta ficam completas; as antigas são resumidas

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
function relevantNotes(root, pedido, n = 3) {
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
    .map(x => `### ${x.f}\n${x.txt.replace(/^---[\s\S]*?---\n/, '').slice(0, 1400)}`);
}

function systemPrompt(root, pedido) {
  const regras = readIf(path.join(root, 'vault', 'Regras da IA.md'), 2200).replace(/^---[\s\S]*?---\n/, '');
  const conv = readIf(path.join(root, 'vault', 'Convenções.md'), 2600).replace(/^---[\s\S]*?---\n/, '');
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
    log('clonando o repositório (1ª vez)…');
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
    log('instalando dependências (pode demorar)…');
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
  const log = (m) => { const l = `[${new Date().toISOString().slice(11, 19)}] ${m}`; lines.push(l); (deps.log || console.log)(`[agent #${pedido.id}] ${m}`); };
  const flushLog = () => lines.join('\n').slice(-6000);
  const branch = `ia/pedido-${pedido.id}-${Date.now().toString(36)}`;

  await setStatus(pedido.id, { status: 'em_andamento', agente_log: null });
  try {
    await prepareWorkspace({ root: workdir, github, branch, skipInstall: deps.skipInstall, log });
    const tools = makeTools(workdir);
    const messages = [{ role: 'system', content: systemPrompt(workdir, pedido) }, { role: 'user', content: userPrompt(pedido) }];
    log(`modelo: ${llm.name}`);

    let summary = null, buildRetries = 0, formatErrors = 0;
    for (let step = 1; step <= MAX_STEPS && summary === null; step++) {
      compact(messages);
      const reply = await llm.chat({ messages, tools: DEFINITIONS });
      if (reply.formatError) {
        if (++formatErrors > 3) throw new Error('o modelo não conseguiu usar as ferramentas direito (formato inválido)');
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
          log(`${tc.name}(${String(tc.args.path || tc.args.text || '').slice(0, 60)}) ok`);
          if (tc.name === 'finish') {
            // Antes de aceitar o fim: o build precisa passar.
            if (!tools.changed.size) { summary = `Sem alterações: ${out || 'o agente decidiu não mexer.'}`; break; }
            const b = await shell(buildCmd, workdir, 300000);
            if (!b.ok) {
              if (++buildRetries > MAX_BUILD_RETRIES) throw new Error(`o build falhou mesmo após ${MAX_BUILD_RETRIES} correções:\n${b.out.slice(-500)}`);
              log(`build falhou — devolvendo o erro ao modelo (tentativa ${buildRetries})`);
              out = `O BUILD FALHOU. Corrija e chame finish de novo. Erro:\n${b.out.slice(-1500)}`;
            } else { log('build ok'); summary = out || 'Ajuste feito.'; }
          }
        } catch (e) { out = `ERRO: ${e.message}`; log(`${tc.name} → ${e.message}`); }
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
    log(`branch enviada: ${branch}`);

    const pr = await github.createPR({ head: branch, title: `IA: ${pedido.titulo}`, body: `Pedido de ajuste #${pedido.id}\n\n${summary}\n\nArquivos:\n${files.map(f => `- ${f}`).join('\n')}\n\n_Gerado pelo agente do Uniko. Revise antes de aprovar._` });
    await setStatus(pedido.id, { status: 'em_revisao', nota_ia: summary, pr_url: pr.url, pr_number: pr.number, branch, agente_log: flushLog() });
    log(`PR aberto: ${pr.url}`);
    return { ok: true, pr, files, summary };
  } catch (e) {
    log(`FALHOU: ${e.message}`);
    await setStatus(pedido.id, { status: 'falhou', nota_ia: scrub(e.message).slice(0, 600), agente_log: flushLog() }).catch(() => {});
    return { ok: false, reason: e.message };
  }
}

module.exports = { runPedido, scrub };
