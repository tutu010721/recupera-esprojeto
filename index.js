// Importações
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcrypt'); // <-- 1. IMPORTAMOS O BCRYPT

// Cria uma instância do aplicativo Express
const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;

// Configuração da Conexão com o Banco de Dados
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// --- Rotas da API ---

app.get('/', (req, res) => {
  res.send('API do SaaS de Recuperação está funcionando!');
});

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

// Rota para Cadastrar um novo usuário (AGORA COM HASH DE SENHA)
app.post('/users', async (req, res) => {
  const { name, email, password, role } = req.body;

  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
  }

  try {
    // --- 2. LÓGICA DE HASHING DE SENHA ---
    const saltRounds = 10; // Custo do processamento do hash
    const password_hash = await bcrypt.hash(password, saltRounds); // Transforma a senha em hash

    // Agora salvamos o HASH no banco, e não a senha original
    const queryText = 'INSERT INTO users(name, email, password_hash, role) VALUES($1, $2, $3, $4) RETURNING id, name, email, role, created_at';
    const queryValues = [name, email, password_hash, role]; // Usamos a variável password_hash

    const result = await pool.query(queryText, queryValues);

    res.status(201).json(result.rows[0]);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao criar usuário. O email já pode estar em uso.' });
  }
});

// Inicia o servidor
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
