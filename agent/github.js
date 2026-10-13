// Cliente mínimo da API do GitHub: abrir, mesclar e fechar pull requests.
// Token: fine-grained PAT (GITHUB_TOKEN) só do repositório do Uniko, com
// permissões Contents + Pull requests (read/write). Gratuito.
const axios = require('axios');

function makeGithub({ token, repo }) {
  const api = axios.create({
    baseURL: 'https://api.github.com',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    timeout: 30000,
  });
  const wrap = async (fn) => { try { return await fn(); } catch (e) { throw new Error(`GitHub: ${e.response?.data?.message || e.message}`); } };
  return {
    repo,
    cloneUrl: `https://x-access-token:${token}@github.com/${repo}.git`,
    createPR: ({ head, base = 'main', title, body }) => wrap(async () => {
      const r = await api.post(`/repos/${repo}/pulls`, { head, base, title, body });
      return { number: r.data.number, url: r.data.html_url };
    }),
    mergePR: (number, title) => wrap(async () => {
      const r = await api.put(`/repos/${repo}/pulls/${number}/merge`, { merge_method: 'squash', commit_title: title });
      return r.data;
    }),
    closePR: (number) => wrap(async () => { await api.patch(`/repos/${repo}/pulls/${number}`, { state: 'closed' }); }),
    // URL da prévia (a Vercel publica cada branch sozinha e avisa o GitHub). null = ainda não ficou pronta.
    previewUrl: (branch) => wrap(async () => {
      const ds = await api.get(`/repos/${repo}/deployments`, { params: { ref: branch, per_page: 5 } });
      for (const d of ds.data || []) {
        const ss = await api.get(`/repos/${repo}/deployments/${d.id}/statuses`, { params: { per_page: 5 } });
        const ok = (ss.data || []).find(s => s.state === 'success' && (s.environment_url || s.target_url));
        if (ok) return { state: 'pronta', url: ok.environment_url || ok.target_url };
        const falhou = (ss.data || []).find(s => s.state === 'failure' || s.state === 'error');
        if (falhou) return { state: 'falhou', url: falhou.log_url || falhou.target_url || null };
      }
      return { state: 'gerando', url: null };
    }),
    deleteBranch: (branch) => wrap(async () => { await api.delete(`/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`).catch(() => {}); }),
  };
}

module.exports = { makeGithub };
