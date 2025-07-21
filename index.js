// Importações
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors'); // <-- NOVA LINHA

// Cria uma instância do aplicativo Express
const app = express();

// --- Middlewares ---
// Adiciona a capacidade da API de entender JSON
app.use(express.json());
// Adiciona a capacidade da API de aceitar requisições de outros domínios (CORS)
app.use(cors()); // <-- NOVA LINHA

// Define a porta do servidor
const PORT = process.env.PORT || 3000;

// Configuração da Conexão com o Banco de Dados
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// --- Rotas da API ---

// Rota principal de teste
app.get('/', (req, res) => {
  res.send('API do SaaS de Recuperação está funcionando!');
});

// Rota para testar a conexão com o banco de dados
app.get('/db-test', async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    res.json({ success: true, time: result.rows[0].now });
    client.release();
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Erro ao conectar ao banco de dados.' });
  }
});

// Rota para Cadastrar um novo usuário
app.post('/users', async (req, res) => {
  const { name, email, password, role } = req.body;

  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: 'Todos os campos são obrigatórios: name, email, password, role.' });
  }

  // ATENÇÃO: Por enquanto, vamos salvar a senha como texto puro.
  // Este é um PASSO TEMPORÁRIO e INSEGURO. No futuro, vamos substituir por criptografia (hashing).
  const password_hash = password;

  try {
    const queryText = 'INSERT INTO users(name, email, password_hash, role) VALUES($1, $2, $3, $4) RETURNING id, name, email, role, created_at';
    const queryValues = [name, email, password_hash, role];

    const result = await pool.query(queryText, queryValues);

    res.status(201).json(result.rows[0]);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao criar usuário. O email já pode estar em uso.' });
  }
});

// Inicia o servidor para escutar por requisições na porta definida
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
