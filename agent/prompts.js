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
1) Editar POR LINHA (preferido: exato, sem copiar linhas longas) — use os NÚMEROS DE LINHA mostrados no código:
   {"edits":[{"path":"src/...","op":"move","start":2171,"end":2171,"to":2146,"expect":"pedidos_ajuste"}],"summary":"o que mudou, 1-2 frases simples em português"}
   Operações: "move" (move as linhas start..end para ANTES da linha "to"), "replace" (troca as linhas start..end por "text"), "delete" (apaga start..end), "insert_before"/"insert_after" (insere "text" antes/depois da linha start). "expect" é OBRIGATÓRIO: um pedaço curto de texto que existe nessas linhas (confere que é a linha certa). Todos os números se referem ao arquivo COMO MOSTRADO (não se preocupe com deslocamento: o sistema aplica tudo de uma vez).
   Para mudar só um trecho curto DENTRO de uma linha, use: {"path":"src/...","old_string":"trecho EXATO","new_string":"novo"} (old_string único no arquivo, sem os números de linha).
   Arquivo novo: {"path":"src/...","create":true,"content":"..."}.
2) Precisa ver mais código: {"need":{"search":["texto"],"read":[{"path":"src/...","start":1,"end":80}]}}
3) Não dá, é grande demais ou perigoso: {"give_up":"motivo curto"}
Ao MOVER um item de uma lista/array, "to" deve ser a linha de OUTRO item da mesma lista (o item vai ficar logo acima dele) — nunca a linha que abre a lista (ex.: "const X = [") nem a que a fecha. Confira os números olhando as linhas mostradas. Para CRIAR algo novo (tela, aba, jogo): crie o componente com create:true em um arquivo NOVO e registre-o nos arquivos existentes com operações por linha (insert_after) — nunca use old_string vazio. Mudança mínima, no estilo do código vizinho (estilos inline, tema T), textos em português do Brasil. Só pode escrever em: ${G.WRITE_ROOTS.join(', ')}. Mantenha a resposta CURTA. Em strings JSON escape aspas (\\") e quebras de linha (\\n).

# Regras do projeto
${regras}
# Convenções
${conv}`;
}

const BLOCO_CONSTRUCAO = `# MODO CONSTRUÇÃO — o pedido é CRIAR algo novo
- Implemente DE VERDADE e por completo, com TODAS as funcionalidades pedidas. Proibido: placeholder, "exemplo", TODO, texto fixo ou desenho no lugar da funcionalidade.
- Divida em arquivos pequenos (cada um com até ~120 linhas): a lógica pura em um (ex.: nomeLogic.js, sem React) e a interface em outro (ex.: TabNome.jsx, que importa a lógica).
- Mande UM ou DOIS arquivos por resposta. Se ainda faltar algo, inclua no JSON "falta":["próximo passo", ...] (lista curta); quando TUDO estiver pronto, omita "falta" (ou deixe []) e preencha "summary".
- Para escrever um arquivo em partes: {"path":"...","create":true,"append":true,"content":"..."} acrescenta ao final de um arquivo que VOCÊ já criou. Sem "append", o arquivo é reescrito por inteiro.
- Registre a tela/aba nos arquivos existentes com operações por linha (insert_after), conforme a nota do cofre.`;

function planUser(pedidoTexto, ctx, extra, feedback, aplicados, notas, cons) {
  const partes = [pedidoTexto];
  if (cons && cons.ativo) {
    partes.push(BLOCO_CONSTRUCAO);
    if (cons.resumo) partes.push(`# Já criado nesta tarefa (confira os nomes ao importar)\n${cons.resumo}`);
  }
  partes.push('# Código encontrado (o número e o TAB no começo de cada linha são só referência — NÃO fazem parte do código)');
  const tetoCodigo = cons && cons.ativo ? 4500 : 7500;
  partes.push((ctx.snippets || '(nenhum trecho óbvio encontrado — use "need" com search)').slice(0, tetoCodigo));
  if (notas) partes.push(`# Notas do cofre relacionadas ao pedido (siga as instruções delas)\n${String(notas).slice(0, 3000)}`);
  if (extra) partes.push(`# Informação extra que você pediu\n${extra.slice(-2500)}`);
  if (aplicados.length) partes.push(`# Já aplicado nesta tentativa: ${[...new Set(aplicados)].join(', ')}`);
  if (feedback) partes.push(`# ATENÇÃO\n${feedback}`);
  return partes.join('\n');
}

module.exports = { planSystem, planUser };
