// =================================================================
//                      IMPORTAÇÕES DE PACOTES
// =================================================================
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');


// =================================================================
//                      CONFIGURAÇÃO INICIAL DO APP
// =================================================================
const app = express();
app.use(express.json()); // Middleware para entender JSON
app.use(cors());         // Middleware para permitir requisições de outros domínios

const PORT = process.env.PORT || 3000;
const JWT_SECRET = 'minha-chave-super-secreta-para-o-saas-123'; // No futuro, idealmente virá de uma variável de ambiente.


// =================================================================
//                      CONFIGURAÇÃO DO BANCO DE DADOS
// =================================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});


// =================================================================
//                      MIDDLEWARE DE AUTENTICAÇÃO
// =================================================================
const authMiddleware = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Formato: "Bearer TOKEN"

  if (token == null) {
    return res.sendStatus(401); // 401 Não autorizado
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.sendStatus(403); // 403 Proibido (token inválido/expirado)
    }
    req.user = user; // Salva os dados do usuário (ex: id, role) na requisição
    next(); // Continua para a rota
  });
};


// =================================================================
//                           ROTAS PÚBLICAS
// =================================================================

app.get('/', (req, res) => {
  res.send('API do SaaS de Recuperação está funcionando!');
});

app.post('/users', async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
  }
  try {
    const saltRounds = 10;
    const password_hash = await bcrypt.hash(password, saltRounds);
    const queryText = 'INSERT INTO users(name, email, password_hash, role) VALUES($1, $2, $3, $4) RETURNING id, name, email, role, created_at';
    const queryValues = [name, email, password_hash, role];
    const result = await pool.query(queryText, queryValues);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Erro em POST /users:", err);
    res.status(500).json({ error: 'Erro ao criar usuário. O email já pode estar em uso.' });
  }
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email e senha são obrigatórios.' });
  }
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }
    const isPasswordCorrect = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordCorrect) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }
    const token = jwt.sign(
      { userId: user.id, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    res.json({ message: 'Login bem-sucedido!', token: token });
  } catch (err) {
    console.error("Erro em POST /login:", err);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});


// =================================================================
//                           ROTAS PROTEGIDAS
// =================================================================

// Rota para buscar os dados do próprio usuário logado
app.get('/api/me', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const result = await pool.query('SELECT id, name, email, role FROM users WHERE id = $1', [userId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Erro em GET /api/me:", err);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

// Rota para um usuário logado criar uma nova loja
app.post('/api/stores', authMiddleware, async (req, res) => {
  // O ID do dono da loja vem do token verificado pelo middleware
  const ownerId = req.user.userId;
  // O nome da loja vem do corpo da requisição
  const { name } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'O nome da loja é obrigatório.' });
  }

  try {
    const queryText = 'INSERT INTO stores(name, owner_id) VALUES($1, $2) RETURNING *';
    const queryValues = [name, ownerId];

    const result = await pool.query(queryText, queryValues);

    res.status(201).json(result.rows[0]);

  } catch (err) {
    console.error("Erro em POST /api/stores:", err);
    res.status(500).json({ error: 'Erro ao criar a loja.' });
  }
});


// =================================================================
//                         INICIALIZAÇÃO DO SERVIDOR
// =================================================================
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
