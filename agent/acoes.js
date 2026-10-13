// AÇÕES ADMINISTRATIVAS do agente — pedidos que NÃO são mudança de código, e sim de dados/configuração:
//   • esconder / mostrar um MÓDULO ou ABA, pra todos ou só pra algumas pessoas;
//   • renomear um módulo ou aba;
//   • remover um Uniko capturado de uma pessoa.
// O modelo só ENTENDE o pedido (escolhe a ação e os ids a partir de listas curtas de candidatos);
// quem executa é código determinístico e validado: o modelo nunca escreve no banco nem inventa ids.
// Toda ação guarda o "como desfazer" (undo) — o botão Desfazer da aba usa isso.
const fs = require('fs');
const path = require('path');
const { firstJsonObject } = require('./llm');

const norm = (s) => String(s || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
const palavras = (s) => norm(s).match(/[a-z0-9]{2,}/g) || [];
const STOP = new Set(['de', 'do', 'da', 'em', 'no', 'na', 'as', 'os', 'um', 'ao', 'uniko', 'unikos', 'para', 'todos', 'todas', 'tirar', 'remover', 'esconder', 'ocultar', 'trocar', 'nome', 'mudar', 'modulo', 'aba', 'tab', 'sidebar', 'portal', 'dashboard', 'colaborador', 'pessoa', 'quero', 'pedidos', 'ajuste', 'meu', 'minha', 'dos', 'das', 'que', 'com', 'uma', 'por', 'ficar', 'fique', 'seja', 'tudo']);
const PROTEGIDOS = new Set(['modulo:colaborador', 'modulo:dashboard', 'aba:inicio', 'rh_aba:pedidos_ajuste', 'rh_aba:modulos_abas', 'rh_aba:permissoes']);   // espelha shared/visibilidade.js
const TABELA_VIS = 'uniko_visibilidade';

const lerArquivo = (root, rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };

// ── Catálogos (lidos do código atual do repositório e do banco) ───────────────
function catalogoItens(root) {
  const itens = [];
  for (const l of lerArquivo(root, 'src/shared/ModuleSelector.jsx').split('\n')) {
    const m = /\{\s*id:\s*'([^']+)',\s*label:\s*'([^']+)'/.exec(l);
    if (m && /\bsub:/.test(l) && !/\bhex:/.test(l)) itens.push({ tipo: 'modulo', id: m[1], label: m[2] });
  }
  const sb = lerArquivo(root, 'src/modules/central-colaborador/Sidebar.jsx');
  const fim = sb.indexOf('const NAV_FOR');
  for (const l of (fim > 0 ? sb.slice(0, fim) : sb).split('\n')) {
    const m = /^\s*\{id:\s*'([^']+)',\s*label:\s*'([^']+)'/.exec(l);
    if (m) itens.push({ tipo: 'aba', id: m[1], label: m[2] });
  }
  // Abas do menu lateral do Dashboard RH (lista TABS do dashboard-rh/index.jsx).
  const rh = lerArquivo(root, 'src/modules/dashboard-rh/index.jsx');
  const ini = rh.indexOf('const TABS=[');
  if (ini > 0) {
    const fim = rh.indexOf('\n  ];', ini);
    for (const l of rh.slice(ini, fim > 0 ? fim : ini + 40000).split('\n')) {
      const m = /^\s*\{id:\s*'([^']+)',\s*label:\s*'([^']+)'/.exec(l);
      if (m) itens.push({ tipo: 'rh_aba', id: m[1], label: m[2] });
    }
  }
  return itens;
}
const rotuloTipo = (t) => (t === 'rh_aba' ? 'a aba do Dashboard RH' : t === 'aba' ? 'a aba do Portal' : 'o módulo');
function catalogoUnikos(root) {
  const out = [];
  const t = lerArquivo(root, 'src/shared/captureUniko.js');
  for (const m of t.matchAll(/id:\s*'([^']+)',\s*\n\s*name:\s*'([^']+)'/g)) out.push({ id: m[1], name: m[2] });
  return out;
}
async function catalogoPessoas(supabase) {
  try { const { data } = await supabase.from('employees').select('name').eq('active', true); return (data || []).map(e => e.name).filter(Boolean); }
  catch { return []; }
}
async function unikosCustom(supabase) {
  try { const { data } = await supabase.from('custom_unikos').select('id,name'); return (data || []).filter(u => u.id && u.name).map(u => ({ id: u.id, name: u.name })); }
  catch { return []; }
}

// ── Candidatos: só o que tem relação com o texto do pedido (prompt pequeno) ───
function pontuar(textoPedido, rotulo) {
  const todas = palavras(rotulo).filter(w => w.length > 1);
  const uteis = todas.filter(w => !STOP.has(w));
  const alvo = uteis.length ? uteis : todas.filter(w => !['de', 'do', 'da', 'em', 'no', 'na', 'as', 'os', 'um', 'ao'].includes(w));   // rótulo só de palavras comuns (ex.: "Dashboard RH"): usa todas
  if (!alvo.length) return 0;
  const set = new Set(palavras(textoPedido));
  return alvo.filter(w => set.has(w)).length / alvo.length;
}
function melhores(lista, rotulo, texto, n, minimo = 0.5) {
  return lista.map(x => ({ x, s: pontuar(texto, rotulo(x)) })).filter(a => a.s >= minimo).sort((a, b) => b.s - a.s).slice(0, n).map(a => a.x);
}
function pessoasCandidatas(pessoas, texto) {
  const set = new Set(palavras(texto));
  return pessoas.map(p => ({ p, s: palavras(p).filter(w => set.has(w) && !STOP.has(w)).length })).filter(a => a.s > 0).sort((a, b) => b.s - a.s).slice(0, 6).map(a => a.p);
}

// Pela RAIZ das palavras, pra pegar qualquer conjugação: "esconda", "oculte", "retire", "não apareça"…
const looksLikeAction = (texto) => /(escond|ocult|retir|remov|remo[cç]|\btir[aeo]|exclu|\bsum[aeio]|\bsome\b|desativ|mostr|reativ|devolv|renome|\bnome\b|chamar de|apare[cç]|vis[ií]vel|visibilidade|exib|libera|bloque)/i.test(texto);

// ── Triagem pelo modelo ───────────────────────────────────────────────────────
function promptTriagem(pedido, c) {
  const l = (arr, f) => (arr.length ? arr.map(f).join('\n') : '(nenhum)');
  return `Você classifica pedidos de ajuste do sistema Uniko. Responda SOMENTE com UM objeto JSON (sem texto fora dele).
Se o pedido é uma AÇÃO ADMINISTRATIVA (dados/configuração, sem mexer em código), responda em um destes formatos:
{"acao":"esconder","tipo":"modulo"|"aba"|"rh_aba","id":"<id>","para":"todos"}   ou   "para":["Nome completo exato", ...]
{"acao":"mostrar","tipo":"modulo"|"aba"|"rh_aba","id":"<id>","para":"todos"|["Nome completo exato"]}   (desfaz um esconder)
{"acao":"renomear","tipo":"modulo"|"aba"|"rh_aba","id":"<id>","nome":"Novo nome"}
{"acao":"remover_uniko","uniko":"<id>","pessoa":"Nome completo exato"}   (tira da coleção de capturados da pessoa)
Se NÃO for ação administrativa (é mudar visual, texto fixo, comportamento, posição): {"codigo":true}
Se for ação mas está ambíguo ou falta algo (qual módulo? qual das pessoas?): {"duvida":"pergunta curta em português"}
IMPORTANTE: o dono nem sempre usa o nome exato. Se existir UM item da lista com nome parecido ou que contém as palavras do pedido (ex.: "Ajuste Inteligente" ≈ "Pedidos de Ajuste"), USE esse item — só pergunte (duvida) se houver MAIS DE UM plausível ou NENHUM parecido, e cite as opções na pergunta.
Regras: use APENAS ids e nomes das listas abaixo, escritos exatamente assim. "Tirar/remover um Uniko DE uma pessoa": se o Uniko está em "Unikos capturáveis" é remover_uniko; se é um módulo ou aba da lista, é esconder PARA aquela pessoa. "Todos"/"para todos" = "todos". Se mais de uma pessoa serve (ex.: dois "Nicolas") e o pedido não diz qual, responda duvida.

Tipos: modulo = card da tela inicial; aba = aba do menu do Portal do Colaborador; rh_aba = aba do menu lateral do Dashboard RH.
Módulos e abas:
${l(c.itens, i => `- ${i.tipo} id="${i.id}" nome="${i.label}"`)}
Unikos capturáveis:
${l(c.unikos, u => `- id="${u.id}" nome="${u.name}"`)}
Pessoas (nomes completos):
${l(c.pessoas, p => `- ${p}`)}

Pedido: ${pedido.titulo}
${pedido.descricao ? `Detalhes: ${pedido.descricao}` : ''}`;
}

// ── Validação: tudo precisa bater com os candidatos ───────────────────────────
function validar(o, c) {
  const pessoaOk = (n) => c.pessoas.find(p => norm(p) === norm(n));
  const item = () => c.itens.find(i => i.tipo === o.tipo && i.id === o.id);
  if (o.acao === 'esconder' || o.acao === 'mostrar') {
    const it = item(); if (!it) return { erro: `não achei o ${o.tipo || 'item'} "${o.id}" entre os módulos/abas` };
    if (PROTEGIDOS.has(`${o.tipo}:${o.id}`) && o.acao === 'esconder') return { erro: `"${it.label}" é protegido e não pode ser escondido (evita trancar o admin pra fora)` };
    let para = o.para;
    if (para !== 'todos') {
      if (!Array.isArray(para) || !para.length) return { erro: 'não ficou claro pra quem esconder/mostrar' };
      const nomes = para.map(pessoaOk); if (nomes.some(n => !n)) return { erro: `pessoa não reconhecida em: ${para.join(', ')}` };
      para = nomes;
    }
    return { plano: { acao: o.acao, tipo: o.tipo, id: o.id, label: it.label, para } };
  }
  if (o.acao === 'renomear') {
    const it = item(); if (!it) return { erro: `não achei o ${o.tipo || 'item'} "${o.id}" entre os módulos/abas` };
    const nome = String(o.nome || '').trim();
    if (nome.length < 2 || nome.length > 40) return { erro: 'o novo nome precisa ter entre 2 e 40 caracteres' };
    return { plano: { acao: 'renomear', tipo: o.tipo, id: o.id, label: it.label, nome } };
  }
  if (o.acao === 'remover_uniko') {
    const u = c.unikos.find(x => x.id === o.uniko); if (!u) return { erro: `não achei o Uniko "${o.uniko}"` };
    const p = pessoaOk(o.pessoa); if (!p) return { erro: `pessoa não reconhecida: ${o.pessoa}` };
    return { plano: { acao: 'remover_uniko', uniko: u.id, unikoNome: u.name, pessoa: p } };
  }
  return { erro: 'ação desconhecida' };
}

const descreverPlano = (p) => {
  const quem = p.para === 'todos' ? 'para todos' : `para ${p.para?.join(', ')}`;
  const rot = rotuloTipo(p.tipo);
  switch (p.acao) {
    case 'esconder': return `Esconder ${rot} "${p.label}" ${quem}`;
    case 'mostrar': return `Mostrar de novo ${rot} "${p.label}" ${quem}`;
    case 'renomear': return `Renomear ${rot} "${p.label}" para "${p.nome}"`;
    case 'remover_uniko': return `Tirar o ${p.unikoNome} da coleção de ${p.pessoa}`;
    default: return p.acao;
  }
};

// ── Execução (com undo) ───────────────────────────────────────────────────────
async function lerLinha(supabase, tipo, id) {
  const { data, error } = await supabase.from(TABELA_VIS).select('*').eq('tipo', tipo).eq('item_id', id).maybeSingle();
  if (error) throw new Error(error.message.includes('does not exist') || error.message.includes('schema cache') ? 'A tabela uniko_visibilidade não existe — rode supabase_visibilidade.sql no Supabase principal.' : error.message);
  return data || null;
}
async function gravarLinha(supabase, linha) {
  const vazia = !linha.nome && !linha.oculto_todos && !(linha.ocultar_para || []).length;
  if (vazia) { const { error } = await supabase.from(TABELA_VIS).delete().eq('tipo', linha.tipo).eq('item_id', linha.item_id); if (error) throw new Error(error.message); return; }
  const { error } = await supabase.from(TABELA_VIS).upsert({ ...linha, updated_at: new Date().toISOString() }, { onConflict: 'tipo,item_id' });
  if (error) throw new Error(error.message);
}

async function executar(plano, { supabase, quem }) {
  if (plano.acao === 'remover_uniko') {
    const { data: rows, error } = await supabase.from('capture_uniko_captures').select('player,uniko_id,uniko_name,captured_at').eq('player', plano.pessoa).eq('uniko_id', plano.uniko);
    if (error) throw new Error(error.message);
    if (!rows?.length) return { resumo: `${plano.pessoa} não tem o ${plano.unikoNome} na coleção — nada a remover.`, undo: null, semEfeito: true };
    const { error: de } = await supabase.from('capture_uniko_captures').delete().eq('player', plano.pessoa).eq('uniko_id', plano.uniko);
    if (de) throw new Error(de.message);
    return { resumo: `Tirei o ${plano.unikoNome} da coleção de ${plano.pessoa}.`, undo: { tipo: 'recolocar_uniko', rows } };
  }
  const antes = await lerLinha(supabase, plano.tipo, plano.id);
  const base = antes ? { ...antes } : { tipo: plano.tipo, item_id: plano.id, nome: null, oculto_todos: false, ocultar_para: [] };
  base.ocultar_para = Array.isArray(base.ocultar_para) ? [...base.ocultar_para] : [];
  base.updated_by = quem || 'Agente';
  const rot = rotuloTipo(plano.tipo);
  let resumo;
  if (plano.acao === 'esconder') {
    if (plano.para === 'todos') { base.oculto_todos = true; resumo = `Escondi ${rot} "${plano.label}" para todos.`; }
    else { for (const n of plano.para) if (!base.ocultar_para.some(x => norm(x) === norm(n))) base.ocultar_para.push(n); resumo = `Escondi ${rot} "${plano.label}" para ${plano.para.join(', ')}.`; }
  } else if (plano.acao === 'mostrar') {
    if (plano.para === 'todos') { base.oculto_todos = false; base.ocultar_para = []; resumo = `${rot[0].toUpperCase() + rot.slice(1)} "${plano.label}" voltou a aparecer para todos.`; }
    else { const tira = new Set(plano.para.map(norm)); base.ocultar_para = base.ocultar_para.filter(x => !tira.has(norm(x))); resumo = `${rot[0].toUpperCase() + rot.slice(1)} "${plano.label}" voltou a aparecer para ${plano.para.join(', ')}.`; }
  } else if (plano.acao === 'renomear') {
    base.nome = plano.nome; resumo = `Renomeei ${rot} "${plano.label}" para "${plano.nome}".`;
  }
  await gravarLinha(supabase, base);
  return { resumo, undo: { tipo: 'restaurar_visibilidade', tipoItem: plano.tipo, id: plano.id, antes } };
}

async function desfazer(undo, { supabase }) {
  if (!undo) return;
  if (undo.tipo === 'recolocar_uniko') {
    const { error } = await supabase.from('capture_uniko_captures').insert(undo.rows.map(r => ({ player: r.player, uniko_id: r.uniko_id, uniko_name: r.uniko_name, captured_at: r.captured_at })));
    if (error) throw new Error(error.message);
  } else if (undo.tipo === 'restaurar_visibilidade') {
    if (undo.antes) await gravarLinha(supabase, undo.antes);
    else { const { error } = await supabase.from(TABELA_VIS).delete().eq('tipo', undo.tipoItem).eq('item_id', undo.id); if (error) throw new Error(error.message); }
  }
}

/**
 * Tenta resolver o pedido como ação administrativa.
 * → null (não é ação; segue pro modo de código) | { duvida } | { erro } | { plano, descricao }
 */
async function interpretar({ llm, root, pedido, supabase }) {
  const texto = `${pedido.titulo || ''} ${pedido.descricao || ''}`;
  if (!looksLikeAction(texto)) return null;                       // nem chama o modelo
  const itens = catalogoItens(root);
  const unikos = [...catalogoUnikos(root), ...(await unikosCustom(supabase))];
  const pessoas = await catalogoPessoas(supabase);
  const c = {
    itens: melhores(itens, i => i.label, texto, 6),
    unikos: melhores(unikos, u => u.name, texto, 4),
    pessoas: pessoasCandidatas(pessoas, texto),
  };
  if (!c.itens.length && !c.unikos.length) return null;           // nada do catálogo citado: é pedido de código
  const reply = await llm.chat({ messages: [{ role: 'user', content: promptTriagem(pedido, c) }], tools: [], plain: true });
  const o = firstJsonObject(reply.content, x => x && (x.acao || x.codigo || x.duvida));
  if (!o || o.codigo) return null;
  if (o.duvida) {
    const opcoes = [...c.itens.map(i => `${i.tipo === 'aba' ? 'aba' : 'módulo'} "${i.label}"`), ...c.unikos.map(u => `Uniko "${u.name}"`), ...c.pessoas].slice(0, 8);
    return { duvida: `${String(o.duvida).slice(0, 260)}${opcoes.length ? ` (Encontrei: ${opcoes.join('; ')}.)` : ''}` };
  }
  const v = validar(o, c);
  if (v.erro) return { erro: v.erro };
  return { plano: v.plano, descricao: descreverPlano(v.plano) };
}

module.exports = { interpretar, executar, desfazer, descreverPlano, catalogoItens, catalogoUnikos, validar, looksLikeAction };
