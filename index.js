// Importações
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken'); // <-- 1. IMPORTAMOS O JWT

// Cria uma instância do aplicativo Express
const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;

// UMA CHAVE SECRETA PARA ASSINAR NOSSOS TOKENS.
// No futuro, isso deve vir de uma variável de ambiente!
const JWT_SECRET = 'minha-chave-super-secreta-para-o-saas-123';

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

// ... (a rota /db-test continua aqui, se você quiser mantê-la)

// Rota para Cadastrar um novo usuário
app.post('/users', async (req, res) => {
  const { name, email, password, role } = req.body;

  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
  }

  try {
    const saltRounds = 10;
    const password_hash = await bcrypt.hash(password, saltRounds);

    const queryText = 'INSERT INTO users(name, email, password_hash, role) VALUES($1, $2, $3, $4) RETURNING id, name, email, role, created_at';
    const queryValues = [name, email, password_hash];

    const result = await pool.query(queryText, queryValues);

    res.status(201).json(result.rows[0]);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao criar usuário. O email já pode estar em uso.' });
  }
});

// --- 2. NOVA ROTA DE LOGIN ---
app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email e senha são obrigatórios.' });
  }

  try {
    // Acha o usuário no banco pelo email
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    // Se não achar o usuário, retorna erro
    if (!user) {
      return res.status(401).json({ error: 'Credenciais inválidas.' }); // Mensagem genérica por segurança
    }

    // Compara a senha enviada com o hash salvo no banco
    const isPasswordCorrect = await bcrypt.compare(password, user.password_hash);

    // Se a senha estiver incorreta, retorna erro
    if (!isPasswordCorrect) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    // Se tudo estiver certo, gera o token JWT
    const token = jwt.sign(
      { userId: user.id, role: user.role }, // O que vai dentro do token (o "crachá")
      JWT_SECRET,                             // A chave secreta para assinar
      { expiresIn: '24h' }                      // Duração do token
    );

    // Envia o token de volta para o cliente
    res.json({
      message: 'Login bem-sucedido!',
      token: token
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});


// Inicia o servidor
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
