// Prompts do modo PLANEJADOR (padrão). O contexto de código é montado SEM o
// modelo (context.js) e o modelo responde UM JSON com as edições: poucas
// chamadas, sem "chamada de ferramenta" nativa (que os modelos gratuitos
// erram) — cabe no limite de tokens/minuto do Groq grátis.
const fs = require('fs');
const path = require('path');
const G = require('./guard');

const readIf = (p, max) => { try { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n').slice(0, max); } catch { return ''; } };
const semFrontmatter = (t) => t.replace(/^---[\s\S]*?---\n/, '');

function planSystem(root) {
  const regras = semFrontmatter(readIf(path.join(root, 'vault', 'Regras da IA.md'), 1300));
  const conv = semFrontmatter(readIf(path.join(root, 'vault', 'Convenções.md'), 1500));
  return `Você é o agente de manutenção do Uniko (React + Vite). Faz PEQUENAS mudanças pedidas pelo dono, que não é programador.
Responda SOMENTE com UM objeto JSON (sem texto fora dele, sem cercas de código), em um destes formatos:
1) Editar: {"edits":[{"path":"src/...","old_string":"trecho EXATO atual do arquivo","new_string":"trecho novo"}],"summary":"o que mudou, 1-2 frases simples em português"}
   Arquivo novo: {"path":"src/...","create":true,"content":"..."} dentro de "edits".
2) Precisa ver mais código: {"need":{"search":["texto"],"read":[{"path":"src/...","start":1,"end":80}]}}
3) Não dá, é grande demais ou perigoso: {"give_up":"motivo curto"}
Regras: old_string é copiado EXATAMENTE do código mostrado (indentação e aspas iguais), sem os números de linha, e precisa aparecer UMA vez no arquivo (inclua uma linha vizinha se preciso). Mudança mínima, no estilo do código vizinho (estilos inline, tema T), textos em português do Brasil. Só pode escrever em: ${G.WRITE_ROOTS.join(', ')}. Em strings JSON escape aspas (\\") e quebras de linha (\\n).

# Regras do projeto
${regras}
# Convenções
${conv}`;
}

function planUser(pedidoTexto, ctx, extra, feedback, aplicados) {
  const partes = [pedidoTexto];
  partes.push('# Código encontrado (o número e o TAB no começo de cada linha são só referência — NÃO fazem parte do código)');
  partes.push(ctx.snippets || '(nenhum trecho óbvio encontrado — use "need" com search)');
  if (extra) partes.push(`# Informação extra que você pediu\n${extra.slice(-3500)}`);
  if (aplicados.length) partes.push(`# Já aplicado nesta tentativa: ${[...new Set(aplicados)].join(', ')}`);
  if (feedback) partes.push(`# ATENÇÃO\n${feedback}`);
  return partes.join('\n');
}

module.exports = { planSystem, planUser };
