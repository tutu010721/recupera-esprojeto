// Importações
const express = require('express');
const { Pool } = require('pg'); // Importa o cliente de conexão do PostgreSQL

// --- Configuração da Conexão com o Banco de Dados ---
// O Pool vai usar automaticamente a variável de ambiente DATABASE_URL que configuramos no Render
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Adiciona configuração de SSL necessária para conexões remotas como a do Render
  ssl: {
    rejectUnauthorized: false
  }
});

// Cria uma instância do aplicativo Express
const app = express();
const PORT = process.env.PORT || 3000;

// --- Rotas da API ---

// Rota principal
app.get('/', (req, res) => {
  res.send('API do SaaS de Recuperação está funcionando!');
});

// Nova rota para testar a conexão com o banco de dados
app.get('/db-test', async (req, res) => {
  try {
    const client = await pool.connect(); // Tenta pegar uma conexão do pool
    const result = await client.query('SELECT NOW()'); // Faz uma query simples para pegar a hora atual do DB
    res.json({ success: true, time: result.rows[0].now }); // Retorna a hora como JSON
    client.release(); // Libera a conexão de volta para o pool
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Erro ao conectar ao banco de dados.' });
  }
});

// Rota para webhooks (ainda sem lógica de DB)
app.post('/webhook/:checkout', (req, res) => {
  const checkoutName = req.params.checkout;
  console.log(`Webhook recebido do checkout: ${checkoutName}`);
  res.status(200).send('Webhook recebido com sucesso.');
});

// Inicia o servidor
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
