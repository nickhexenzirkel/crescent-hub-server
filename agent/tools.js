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
  { name: 'read_file', description: 'Lê um arquivo (com números de linha). Máximo 120 linhas por chamada: use start_line/end_line.',
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
      const lines = out.split('\n').filter(Boolean).slice(0, 25).map(l => clip(l, 180));
      return lines.length ? lines.join('\n') : 'nenhum resultado';
    },
    async read_file({ path: p, start_line, end_line }) {
      const { rel, abs } = G.resolveSafe(root, p);
      G.assertReadable(rel);
      const st = fs.statSync(abs);
      if (st.size > 4 * 1024 * 1024) throw new Error('arquivo grande demais para ler inteiro — use search e start_line/end_line');
      const lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
      const a = Math.max(1, start_line || 1), b = Math.min(lines.length, end_line || a + 119, a + 119);
      const body = lines.slice(a - 1, b).map((l, i) => `${a + i}\t${l}`).join('\n');
      return clip(`[${rel}  linhas ${a}-${b} de ${lines.length}]\n${body}`, 7000);
    },
    async replace_in_file({ path: p, old_string, new_string }) {
      const { rel, abs } = G.resolveSafe(root, p);
      G.assertWritable(rel);
      G.assertContent(new_string);
      if (!old_string) throw new Error('old_string vazio');
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
    async create_file({ path: p, content }) {
      const { rel, abs } = G.resolveSafe(root, p);
      G.assertWritable(rel);
      G.assertContent(content);
      if (fs.existsSync(abs)) throw new Error('arquivo já existe — use replace_in_file');
      if (Buffer.byteLength(content) > G.MAX_FILE_BYTES) throw new Error('arquivo grande demais');
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      changed.set(rel, content.split('\n').length);
      if (changed.size > G.MAX_FILES) throw new Error(`mexeu em arquivos demais (máx. ${G.MAX_FILES})`);
      return 'ok';
    },
    async finish({ summary }) { return summary || ''; },
  };

  const totalLines = () => [...changed.values()].reduce((a, b) => a + b, 0);
  return { impl, changed, totalLines };
}

module.exports = { DEFINITIONS, makeTools };
