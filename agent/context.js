// Monta, SEM usar o modelo, o contexto de código relevante para um pedido.
// Em vez de deixar o modelo explorar o projeto passo a passo (cada passo gasta
// tokens do limite por minuto), buscamos os termos do pedido no código e já
// entregamos os trechos certos de uma vez. Um pedido simples vira 1–2 chamadas.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const G = require('./guard');

const run = (args, cwd) => new Promise((resolve) => {
  execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 30000 }, (err, stdout) => resolve(err && !stdout ? '' : String(stdout)));
});
const semAcento = (s) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '');
const STOP = new Set(['quero', 'trocar', 'mudar', 'colocar', 'fazer', 'deixar', 'queria', 'pode', 'favor', 'tela', 'agora', 'sempre', 'posição', 'posicao', 'posições']);
const chave = (t) => semAcento(t).toLowerCase().replace(/[\s_]+/g, '');   // "Pedidos de Ajuste" ≈ pedidos_de_ajuste

// Termos candidatos com peso: nomes entre aspas, frases com maiúsculas e a "tela" informada
// pesam 3 ("Pedidos de Ajuste", "Funcionários"); palavras soltas pesam 1 (último recurso).
function extractTerms(pedido) {
  const text = `${pedido.titulo || ''}. ${pedido.descricao || ''}. ${pedido.area || ''}`;
  const primarios = new Set(), soltas = new Set();
  for (const m of text.matchAll(/["“'‘`]([^"”'’`\n]{3,60})["”'’`]/g)) primarios.add(m[1].trim());
  for (const m of text.matchAll(/[A-ZÀ-Ú][\wÀ-ú]+(?:(?:\s+(?:d[aeo]s?|e)\s+|\s+)[A-ZÀ-Ú][\wÀ-ú]+)*/g)) primarios.add(m[0].trim());
  if (pedido.area) primarios.add(String(pedido.area).trim());
  for (const w of text.toLowerCase().match(/[a-zà-ú]{6,}/g) || []) soltas.add(w);
  const mapa = new Map();   // termo → peso
  const add = (t, w) => {
    if (t.length < 3 || STOP.has(t.toLowerCase())) return;
    for (const v of variantes(t)) mapa.set(v, Math.max(mapa.get(v) || 0, w));
  };
  const variantes = (t) => {
    const v = [t]; const sa = semAcento(t); if (sa !== t) v.push(sa);       // ids no código costumam ser sem acento
    const snake = sa.toLowerCase().replace(/\s+/g, '_'); if (snake.includes('_')) v.push(snake);
    return v;
  };
  for (const t of primarios) add(t, 3);
  for (const t of soltas) add(t, 1);
  return [...mapa.entries()].map(([t, w]) => ({ t, w })).slice(0, 16);
}

async function hitsDe(root, termo) {
  const out = await run(['grep', '-n', '-I', '-F', '-i', '-m', '300', '-e', termo, '--', 'src'], root);
  return out.split('\n').filter(Boolean).map(l => {
    const m = /^([^:]+):(\d+):/.exec(l);
    return m ? { file: m[1], line: Number(m[2]) } : null;
  }).filter(Boolean);
}

const fmt = (txt, a, b) => `…linhas ${a}-${b}:\n` + txt.slice(a - 1, b).map((l, i) => `${a + i}\t${l.length > 150 ? l.slice(0, 150) + '…' : l}`).join('\n');

/** → { snippets: string (texto pronto pro prompt), files: [..] , termos } */
async function buildContext(root, pedido, { maxChars = 7500, maxFiles = 2 } = {}) {
  const termos = extractTerms(pedido);
  const porTermo = new Map();
  for (const { t, w } of termos) { const h = await hitsDe(root, t); if (h.length && h.length <= 150) porTermo.set(t, { h, w }); }

  // 1) Arquivos: termo raro e de peso alto vale mais.
  const score = new Map(), hitsDoArquivo = new Map();
  for (const [t, { h: hs, w }] of porTermo) {
    const peso = w / hs.length, k = chave(t);
    for (const h of hs) {
      if (/\.(png|jpe?g|svg|lock)$/i.test(h.file) || h.file.startsWith('vault/')) continue;
      score.set(h.file, (score.get(h.file) || 0) + peso);
      if (!hitsDoArquivo.has(h.file)) hitsDoArquivo.set(h.file, []);
      hitsDoArquivo.get(h.file).push({ line: h.line, w, k });
    }
  }
  const top = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxFiles).map(([f]) => f);

  // 2) Dentro de cada arquivo: REGIÕES onde vários termos diferentes aparecem juntos
  //    (ex.: a lista de abas, com "Pedidos de Ajuste" e "Funcionários" a poucas linhas),
  //    ignorando imports e comentários. As melhores entram até o limite de caracteres.
  let usado = 0; const partes = [];
  for (const f of top) {
    let txt; try { txt = fs.readFileSync(path.join(root, f), 'utf8').split(/\r?\n/); } catch { continue; }
    const hs = hitsDoArquivo.get(f).filter(h => !/^\s*import\s/.test(txt[h.line - 1] || ''));
    const pontuadas = hs.map(h => {
      const perto = new Map();
      for (const o of hs) if (Math.abs(o.line - h.line) <= 30) perto.set(o.k, Math.max(perto.get(o.k) || 0, o.w));
      const comentario = /^\s*(\/\/|\/\*|\*)/.test(txt[h.line - 1] || '');
      return { line: h.line, s: [...perto.values()].reduce((a, b) => a + b, 0) * (comentario ? 0.3 : 1) };
    }).sort((a, b) => b.s - a.s);
    const centros = [];
    for (const p of pontuadas) { if (centros.every(c => Math.abs(c.line - p.line) > 14)) centros.push(p); if (centros.length >= 8) break; }
    const teto = Math.min(maxChars - usado, f === top[0] ? 5200 : 2400);
    if (teto < 600) break;
    let gasto = 0; const escolhidos = [];
    for (const c of centros) {                                    // melhores primeiro, até o teto
      const a = Math.max(1, c.line - 5), b = Math.min(txt.length, c.line + 5);
      const bloco = fmt(txt, a, b);
      if (gasto + bloco.length > teto) continue;
      escolhidos.push({ a, b, bloco }); gasto += bloco.length;
    }
    escolhidos.sort((x, y) => x.a - y.a);                          // exibe em ordem de linha
    partes.push(`## ${f}${G.WRITE_ROOTS.some(r => f.startsWith(r)) ? '' : '  (somente leitura)'}\n${escolhidos.map(e => e.bloco).join('\n')}`);
    usado += gasto;
  }
  return { snippets: partes.join('\n\n'), files: top, termos: [...porTermo.keys()] };
}

module.exports = { buildContext, extractTerms };
