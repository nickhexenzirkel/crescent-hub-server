// Relatório de uso do Supabase pra aba "Armazenamento" do Dashboard RH (admin).
// Lê dos DOIS projetos: o principal do Portal (Uniko geral) e o do Safer/
// Security/Call. Cada um precisa da função uniko_storage_report()
// (supabase_storage_report.sql). Um projeto falhar não derruba o outro.
const { createClient } = require('@supabase/supabase-js');

let securitySb = null;
if (process.env.UNIKO_SECURITY_SUPABASE_URL && process.env.UNIKO_SECURITY_SUPABASE_SERVICE_KEY) {
  securitySb = createClient(process.env.UNIKO_SECURITY_SUPABASE_URL, process.env.UNIKO_SECURITY_SUPABASE_SERVICE_KEY);
}

module.exports = function registerStorageReport(app, { requireAdmin, supabase }) {
  const ler = async (client) => {
    if (!client) return { error: 'projeto não configurado no servidor' };
    try {
      const { data, error } = await client.rpc('uniko_storage_report');
      if (error) return { error: error.message };
      return data;
    } catch (e) { return { error: e.message }; }
  };
  app.get('/api/storage/report', requireAdmin, async (req, res) => {
    const [geral, security] = await Promise.all([ler(supabase), ler(securitySb)]);
    res.json({ geral, security, at: new Date().toISOString() });
  });
};
