// Força IPv4: a rota IPv6 pra Amazon está quebrada nesta rede e dá ETIMEDOUT no proxy
require('dns').setDefaultResultOrder('ipv4first');

const AlexaRemote = require('alexa-remote2');
const alexa = new AlexaRemote();

const PORT = 3456;

console.log('\n👉 Abra no navegador: http://localhost:' + PORT);
console.log('   Faça login com sua conta Amazon e aguarde...\n');

// O alexa-remote2 v8 entrega o cookie via evento, não pelo callback
alexa.on('cookie', (cookie, csrf, macDms) => {
  const reg = alexa.cookieData || alexa._options?.formerRegistrationData;

  console.log('\n✅ Cole no Render como ALEXA_REGISTRATION_DATA:\n');
  console.log(JSON.stringify(reg || { cookie, csrf, macDms }));
  process.exit(0);
});

alexa.init({
  proxyOnly:        true,
  proxyPort:        PORT,
  proxyOwnIp:       'localhost',
  proxyLogLevel:    'warn',
  // Conta brasileira: mirar amazon.com.br/pt-BR evita o bloqueio de "atividade incomum"
  // que acontecia ao logar via www.amazon.com (EUA)
  amazonPage:       'amazon.com.br',
  acceptLanguage:   'pt-BR',
  alexaServiceHost: 'alexa.amazon.com.br',
}, (err) => {
  if (err) {
    const msg = String(err.message || err);
    if (!msg.includes('Please open')) console.error('Erro:', msg);
  }
});

setTimeout(() => {
  console.log('\n⏰ Timeout de 10 minutos — rode novamente se necessário');
  process.exit(1);
}, 600000);
