// Ferramentas que o modelo pode chamar. Todas operam DENTRO da cópia de
// trabalho do repositório (root), passando pelos trilhos de guard.js.
// Saídas são curtas de propósito: modelos gratuitos têm limite de tokens/minuto.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const G = require('./guard');

const run = (cmd, args, cwd) => new Promise((resolve) => {
  execFile(cmd, args, { cwd, maxBuffer: 4 * 1024 * 1024, timeout: 30000 }, (err, stdout) => resolve(err && !stdout ? '' : String(stdout)));
});
const clip = (s, n) => (s.length > n ? s.slice(0, n) + `\n… (cortado, ${s.length - n} caracteres a mais)` : s);

// Definições no formato OpenAI/Groq (function calling).
const DEFINITIONS = [
  { name: 'list_dir', description: 'Lista arquivos e pastas de um diretório do projeto.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'ex.: src/shared' } }, required: ['path'] } },
  { name: 'search', description: 'Procura um texto (literal) nos arquivos de src/ e vault/. Devolve arquivo:linha:trecho. Use para achar onde algo está.',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'read_file', description: 'Lê um arquivo (com números de linha). Máximo 80 linhas por chamada: use start_line/end_line.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } }, required: ['path'] } },
  { name: 'replace_in_file', description: 'Troca um trecho EXATO do arquivo por outro. old_string precisa existir uma única vez (inclua linhas vizinhas para ficar único). Copie o texto exatamente como está, com a indentação.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] } },
  { name: 'create_file', description: 'Cria um arquivo novo (só em pastas permitidas). Não sobrescreve arquivo existente.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'finish', description: 'Termina o trabalho. Chame quando a mudança estiver feita. summary = 1-2 frases simples, em português, do que mudou (o dono não é programador).',
    parameters: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } },
];

function makeTools(root) {
  const changed = new Map(); // rel → linhas alteradas (aprox.)
  const created = new Set(); // arquivos NOVOS criados nesta execução (podem ser continuados/reescritos)
  const eolOf = (t) => (t.includes('\r\n') ? '\r\n' : '\n');

  const impl = {
    async list_dir({ path: p }) {
      const { rel, abs } = G.resolveSafe(root, p || '.');
      G.assertReadable(rel);
      const ents = fs.readdirSync(abs, { withFileTypes: true })
        .filter(e => !/^(node_modules|\.git|dist|\.env.*)$/.test(e.name))
        .map(e => (e.isDirectory() ? e.name + '/' : e.name)).sort();
      return clip(ents.slice(0, 80).join('\n') + (ents.length > 80 ? `\n… (+${ents.length - 80})` : ''), 3000);
    },
    async search({ text }) {
      if (!text || text.length < 2) throw new Error('texto muito curto');
      const out = await run('git', ['grep', '-n', '-I', '-F', '--max-count=3', '-e', text, '--', 'src', 'vault'], root);
      const lines = out.split('\n').filter(Boolean).slice(0, 15).map(l => clip(l, 140));
      return lines.length ? lines.join('\n') : 'nenhum resultado';
    },
    async read_file({ path: p, start_line, end_line }) {
      const { rel, abs } = G.resolveSafe(root, p);
      G.assertReadable(rel);
      const st = fs.statSync(abs);
      if (st.size > 4 * 1024 * 1024) throw new Error('arquivo grande demais para ler inteiro — use search e start_line/end_line');
      const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
      const a = Math.max(1, start_line || 1), b = Math.min(lines.length, end_line || a + 79, a + 79);
      const body = lines.slice(a - 1, b).map((l, i) => `${a + i}\t${l}`).join('\n');
      return clip(`[${rel}  linhas ${a}-${b} de ${lines.length}]\n${body}`, 5000);
    },
    async replace_in_file({ path: p, old_string, new_string }) {
      const { rel, abs } = G.resolveSafe(root, p);
      G.assertWritable(rel);
      G.assertContent(new_string);
      if (!old_string) throw new Error('old_string vazio — para ACRESCENTAR código novo num arquivo existente use uma operação por linha (op:"insert_after" ou "insert_before", com start = número da linha e expect); para criar um arquivo novo use create:true com content');
      const raw = fs.readFileSync(abs, 'utf8');
      const eol = eolOf(raw);
      const text = raw.replace(/\r\n/g, '\n');
      const oldN = old_string.replace(/\r\n/g, '\n'), newN = new_string.replace(/\r\n/g, '\n');
      const n = text.split(oldN).length - 1;
      if (n === 0) throw new Error('old_string não encontrado — releia o arquivo e copie o trecho exatamente');
      if (n > 1) throw new Error(`old_string aparece ${n} vezes — inclua mais linhas ao redor para ficar único`);
      const next = text.replace(oldN, () => newN);
      if (next.length - text.length > 100 * 1024 || Buffer.byteLength(next) > 4 * 1024 * 1024) throw new Error('a edição aumentaria o arquivo demais — faça uma mudança menor');
      fs.writeFileSync(abs, eol === '\r\n' ? next.replace(/\n/g, '\r\n') : next);
      changed.set(rel, (changed.get(rel) || 0) + Math.max(oldN.split('\n').length, newN.split('\n').length));
      if (changed.size > G.MAX_FILES) throw new Error(`mexeu em arquivos demais (máx. ${G.MAX_FILES})`);
      return 'ok';
    },
    async create_file({ path: p, content, append = false }) {
      const { rel, abs } = G.resolveSafe(root, p);
      G.assertWritable(rel);
      G.assertContent(content);
      if (typeof content !== 'string' || !content.trim()) throw new Error('content vazio');
      const existe = fs.existsSync(abs);
      if (existe && !created.has(rel)) throw new Error('esse arquivo JÁ EXISTE — não recrie: escolha outro nome para o arquivo novo, ou altere o existente com operações por linha');
      if (Buffer.byteLength(content) > G.MAX_FILE_BYTES) throw new Error('arquivo grande demais');
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      // Arquivo criado por você nesta tarefa: "append":true acrescenta no final (para escrever em partes); sem append, reescreve inteiro.
      if (existe && append) fs.appendFileSync(abs, content.startsWith('\n') ? content : '\n' + content);
      else fs.writeFileSync(abs, content);
      created.add(rel);
      changed.set(rel, fs.readFileSync(abs, 'utf8').split('\n').length);
      if (changed.size > G.MAX_FILES) throw new Error(`mexeu em arquivos demais (máx. ${G.MAX_FILES})`);
      return 'ok';
    },
    // Edição POR LINHA (exata, sem o modelo reescrever trechos longos). Os números são os do
    // arquivo ATUAL (como mostrado no contexto). Várias operações por arquivo valem todas
    // contra a numeração original; o sistema ordena de baixo pra cima e recusa sobreposição.
    // `expect` é obrigatório: um pedaço de texto que precisa existir nas linhas alvo —
    // se a linha mudou de lugar, a operação é recusada em vez de alterar a linha errada.
    async edit_lines({ path: p, ops }) {
      const { rel, abs } = G.resolveSafe(root, p);
      G.assertWritable(rel);
      if (!Array.isArray(ops) || !ops.length) throw new Error('nenhuma operação');
      const raw = fs.readFileSync(abs, 'utf8');
      const eol = eolOf(raw);
      const linhas = raw.replace(/\r\n/g, '\n').split('\n');
      const N = linhas.length;
      const norm = ops.map((o, i) => {
        const op = String(o.op || '');
        const start = Number(o.start), end = o.end == null ? start : Number(o.end);
        const to = o.to == null ? null : Number(o.to);
        if (!['replace', 'delete', 'move', 'insert_before', 'insert_after'].includes(op)) throw new Error(`operação ${i + 1}: "${op}" desconhecida (use replace, delete, move, insert_before, insert_after)`);
        if (!Number.isInteger(start) || start < 1 || start > N || !Number.isInteger(end) || end < start || end > N) throw new Error(`operação ${i + 1}: linhas ${o.start}-${o.end} fora do arquivo (tem ${N} linhas)`);
        if (!o.expect || !String(o.expect).trim()) throw new Error(`operação ${i + 1}: falta "expect" (um trecho que existe nessas linhas)`);
        const alvo = linhas.slice(start - 1, end).join('\n');
        if (!alvo.includes(String(o.expect))) throw new Error(`operação ${i + 1}: o texto esperado "${String(o.expect).slice(0, 40)}" NÃO está nas linhas ${start}-${end} (lá está: ${alvo.replace(/\s+/g, ' ').slice(0, 90)}). Releia os números de linha.`);
        if (op === 'move') {
          if (!Number.isInteger(to) || to < 1 || to > N + 1) throw new Error(`operação ${i + 1}: "to" inválido`);
          if (to >= start && to <= end + 1) throw new Error(`operação ${i + 1}: "to" cai dentro do próprio bloco`);
        }
        if ((op === 'replace' || op === 'insert_before' || op === 'insert_after') && typeof o.text !== 'string') throw new Error(`operação ${i + 1}: falta "text"`);
        if (typeof o.text === 'string') G.assertContent(o.text);
        const lo = op === 'move' ? Math.min(start, to) : start, hi = op === 'move' ? Math.max(end, to - 1) : end;
        return { op, start, end, to, text: o.text, lo, hi };
      });
      const ord = [...norm].sort((a, b) => b.hi - a.hi);
      for (let i = 1; i < ord.length; i++) if (ord[i].hi >= ord[i - 1].lo) throw new Error('duas operações mexem na mesma região — envie em partes ou junte numa só');
      let removidas = 0, novas = 0;
      for (const o of ord) {                                        // de baixo pra cima: números das de cima não mudam
        const novoTxt = typeof o.text === 'string' ? o.text.replace(/\r\n/g, '\n').split('\n') : [];
        if (o.op === 'replace') { linhas.splice(o.start - 1, o.end - o.start + 1, ...novoTxt); removidas += o.end - o.start + 1; novas += novoTxt.length; }
        else if (o.op === 'delete') { linhas.splice(o.start - 1, o.end - o.start + 1); removidas += o.end - o.start + 1; }
        else if (o.op === 'insert_before') { linhas.splice(o.start - 1, 0, ...novoTxt); novas += novoTxt.length; }
        else if (o.op === 'insert_after') { linhas.splice(o.start, 0, ...novoTxt); novas += novoTxt.length; }
        else { // move: tira o bloco e põe antes da linha `to` (numeração original)
          const bloco = linhas.splice(o.start - 1, o.end - o.start + 1);
          const dest = o.to > o.end ? o.to - 1 - bloco.length : o.to - 1;
          linhas.splice(dest, 0, ...bloco); removidas += bloco.length; novas += bloco.length;
        }
      }
      const next = linhas.join('\n');
      if (next.length - raw.replace(/\r\n/g, '\n').length > 100 * 1024) throw new Error('a edição aumentaria o arquivo demais');
      fs.writeFileSync(abs, eol === '\r\n' ? next.replace(/\n/g, '\r\n') : next);
      changed.set(rel, (changed.get(rel) || 0) + Math.max(removidas, novas, 1));
      if (changed.size > G.MAX_FILES) throw new Error(`mexeu em arquivos demais (máx. ${G.MAX_FILES})`);
      return 'ok';
    },
    async finish({ summary }) { return summary || ''; },
  };

  const totalLines = () => [...changed.values()].reduce((a, b) => a + b, 0);
  return { impl, changed, created, totalLines };
}

module.exports = { DEFINITIONS, makeTools };
