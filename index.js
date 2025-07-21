// Importa o framework Express para criar o servidor
const express = require('express');

// Cria uma instância do aplicativo Express
const app = express();

// O Render define a porta através de uma variável de ambiente,
// então usamos ela ou a porta 3000 como padrão para testes locais.
const PORT = process.env.PORT || 3000;

// Define uma rota principal para testar se a API está no ar
app.get('/', (req, res) => {
  res.send('API do SaaS de Recuperação está funcionando!');
});

// A rota que receberá os webhooks dos checkouts
// Por enquanto, ela apenas registrará que recebeu algo.
app.post('/webhook/:checkout', (req, res) => {
  const checkoutName = req.params.checkout;
  console.log(`Webhook recebido do checkout: ${checkoutName}`);
  console.log('Corpo da requisição:', req.body);
  
  // Responde ao checkout com status 200 (OK) para confirmar o recebimento
  res.status(200).send('Webhook recebido com sucesso.');
});


// Inicia o servidor para escutar por requisições na porta definida
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
