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
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;
const JWT_SECRET = 'minha-chave-super-secreta-para-o-saas-123';


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
//          WEBHOOK PARSERS ("TRADUTORES")
// =================================================================

// Define um formato padrão para os dados de um lead dentro do nosso sistema
const parseGenericWebhook = (rawData) => {
  return {
    customer_name: rawData.customer?.name,
    customer_email: rawData.customer?.email,
    customer_phone: rawData.customer?.phone,
    product_name: rawData.product?.name,
    total_value: rawData.transaction?.value,
    currency: rawData.transaction?.currency,
    payment_method: rawData.transaction?.payment_method,
    status: rawData.event_type // Ex: 'ORDER_PAID', 'ABANDONED_CART'
  };
};

const parseHotmartWebhook = (rawData) => {
  // Exemplo hipotético de como os dados da Hotmart poderiam ser
  return {
    customer_name: rawData.buyer?.name,
    customer_email: rawData.buyer?.email,
    customer_phone: rawData.buyer?.phone_local_code ? `${rawData.buyer.phone_area_code}${rawData.buyer.phone_number}` : null,
    product_name: rawData.product?.name,
    total_value: rawData.purchase?.price?.value,
    currency: rawData.purchase?.price?.currency_code,
    payment_method: rawData.purchase?.payment?.type,
    status: rawData.event // Ex: 'PURCHASE_APPROVED'
  };
};

// Mapeia o nome da plataforma para a função de parser correspondente
const webhookParsers = {
  'generic': parseGenericWebhook,
  'hotmart': parseHotmartWebhook,
  // No futuro, adicionaremos outros aqui, como 'kiwify': parseKiwifyWebhook
};


// =================================================================
//                      MIDDLEWARES DE AUTENTICAÇÃO
// =================================================================
const authMiddleware = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token == null) return res.sendStatus(401);
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

const adminOnlyMiddleware = (req, res, next) => {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    res.status(403).json({ error: 'Acesso negado. Rota exclusiva for administradores.' });
  }
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
    if (!user) return res.status(401).json({ error: 'Credenciais inválidas.' });
    const isPasswordCorrect = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordCorrect) return res.status(401).json({ error: 'Credenciais inválidas.' });
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

// Rota de Webhook Inteligente
app.post('/webhook/:platform/:storeId', async (req, res) => {
  try {
    const { platform, storeId } = req.params;
    const rawData = req.body;

    const parser = webhookParsers[platform];

    if (!parser) {
      console.error(`Nenhum parser encontrado para a plataforma: ${platform}`);
      return res.status(400).send({ error: 'Plataforma de webhook não suportada.' });
    }
    
    const parsedData = parser(rawData);

    const queryText = 'INSERT INTO sales_leads (store_id, raw_data, parsed_data) VALUES ($1, $2, $3)';
    const queryValues = [storeId, rawData, parsedData];
    
    await pool.query(queryText, queryValues);

    res.status(200).send({ message: 'Webhook recebido com sucesso.' });
  } catch (err) {
    console.error("Erro no Webhook:", err);
    res.status(500).send({ error: 'Erro ao processar webhook.' });
  }
});


// =================================================================
//                           ROTAS PROTEGIDAS
// =================================================================

app.get('/api/me', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;
    const result = await pool.query('SELECT id, name, email, role FROM users WHERE id = $1', [userId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Erro em GET /api/me:", err);
    res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

app.post('/api/stores', authMiddleware, async (req, res) => {
  const ownerId = req.user.userId;
  const { name, platform } = req.body;
  if (!name) return res.status(400).json({ error: 'O nome da loja é obrigatório.' });
  const storePlatform = platform || 'generic';
  try {
    const queryText = 'INSERT INTO stores(name, owner_id, platform) VALUES($1, $2, $3) RETURNING *';
    const queryValues = [name, ownerId, storePlatform];
    const result = await pool.query(queryText, queryValues);
    const newStore = result.rows[0];
    const storeWithWebhook = {
      ...newStore,
      webhookUrl: `https://recupera-esprojeto.onrender.com/webhook/${newStore.platform}/${newStore.id}`
    };
    res.status(201).json(storeWithWebhook);
  } catch (err) {
    console.error("Erro em POST /api/stores:", err);
    res.status(500).json({ error: 'Erro ao criar a loja.' });
  }
});

app.get('/api/stores', authMiddleware, async (req, res) => {
  try {
    const ownerId = req.user.userId;
    const result = await pool.query('SELECT * FROM stores WHERE owner_id = $1', [ownerId]);
    const storesWithWebhook = result.rows.map(store => ({
      ...store,
      webhookUrl: `https://recupera-esprojeto.onrender.com/webhook/${store.platform}/${store.id}`
    }));
    res.json(storesWithWebhook);
  } catch (err) {
    console.error("Erro em GET /api/stores:", err);
    res.status(500).json({ error: 'Erro ao buscar lojas.' });
  }
});

app.get('/api/leads', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM sales_leads ORDER BY received_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error("Erro em GET /api/leads:", err);
    res.status(500).json({ error: 'Erro ao buscar os leads.' });
  }
});

app.patch('/api/leads/:leadId/status', authMiddleware, async (req, res) => {
  try {
    const { leadId } = req.params;
    const { status } = req.body;
    const validStatuses = ['new', 'contacted', 'recovered', 'lost'];
    if (!status || !validStatuses.includes(status)) return res.status(400).json({ error: 'Status inválido ou não fornecido.' });
    const queryText = 'UPDATE sales_leads SET status = $1 WHERE id = $2 RETURNING *';
    const queryValues = [status, leadId];
    const result = await pool.query(queryText, queryValues);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Lead não encontrado.' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Erro em PATCH /api/leads/:leadId/status:", err);
    res.status(500).json({ error: 'Erro ao atualizar o status do lead.' });
  }
});


// =================================================================
//                           ROTAS DE ADMIN
// =================================================================

app.get('/api/admin/users', authMiddleware, adminOnlyMiddleware, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, email, role, created_at FROM users ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error("Erro em GET /api/admin/users:", err);
    res.status(500).json({ error: 'Erro ao buscar usuários.' });
  }
});


// =================================================================
//                         INICIALIZAÇÃO DO SERVIDOR
// =================================================================
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
