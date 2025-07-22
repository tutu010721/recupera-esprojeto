// =================================================================
//                      IMPORTAÇÕES DE PACOTES
// =================================================================
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { Queue } = require('bullmq');
const Redis = require('ioredis');


// =================================================================
//                      CONFIGURAÇÃO INICIAL DO APP
// =================================================================
const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;
const JWT_SECRET = 'minha-chave-super-secreta-para-o-saas-123';


// =================================================================
//                      CONFIGURAÇÃO DAS CONEXÕES
// =================================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const redisConnection = new Redis(process.env.REDIS_URL);

const recoveryQueue = new Queue('recovery-queue', { connection: redisConnection });


// =================================================================
//          WEBHOOK PARSERS ("TRADUTORES")
// =================================================================
const parseAdooreiWebhook = (rawData) => {
  const resource = rawData.resource;
  return {
    customer_name: `${resource.customer?.first_name} ${resource.customer?.last_name}`,
    customer_email: resource.customer?.email,
    customer_phone: resource.customer?.phone,
    product_name: resource.items?.[0]?.name,
    total_value: resource.value_total,
    currency: 'BRL',
    payment_method: resource.payment_method,
    status: resource.status,
  };
};

const webhookParsers = {
  'adoorei': parseAdooreiWebhook,
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

app.post('/webhook/:platform/:storeId', async (req, res) => {
  try {
    const { platform, storeId } = req.params;
    const rawData = req.body;
    const transactionId = rawData.resource?.gateway_transaction_id;

    if (!transactionId) {
      return res.status(400).send({ error: 'ID da transação não encontrado no webhook.' });
    }

    if (rawData.event === 'order.approved') {
      console.log(`Recebido webhook de PAGAMENTO para transação: ${transactionId}`);
      await redisConnection.set(`paid:${transactionId}`, 'true', 'EX', 15 * 60);
      return res.status(200).send({ message: 'Webhook de pagamento recebido.' });
    }

    if (rawData.event === 'order.created' && rawData.resource.status === 'pending') {
      console.log(`Recebido webhook PENDENTE: ${transactionId}. Agendando verificação para 10 minutos.`);
      
      const parser = webhookParsers[platform];
      if (!parser) {
        return res.status(400).send({ error: `Plataforma '${platform}' não suportada.` });
      }
      const parsedData = parser(rawData);

      await recoveryQueue.add('check-order', {
        transactionId,
        storeId,
        rawData,
        parsedData
      }, {
        delay: 10 * 60 * 1000,
        jobId: transactionId,
        removeOnComplete: true,
        removeOnFail: true,
      });
      
      return res.status(202).send({ message: 'Pedido pendente recebido. Verificação agendada.' });
    }
    
    res.status(200).send({ message: 'Webhook recebido, mas sem ação necessária.' });

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

app.get('/api/leads', authMiddleware, async (req, res) => {
  try {
    const agentId = req.user.userId;
    const { status, storeId } = req.query;
    let queryText = `
      SELECT sl.id, sl.store_id, sl.status, sl.received_at, sl.parsed_data, s.name as store_name 
      FROM sales_leads sl
      JOIN stores s ON sl.store_id = s.id
      JOIN agent_store_assignments asa ON sl.store_id = asa.store_id
      WHERE asa.agent_id = $1
    `;
    const queryValues = [agentId];
    if (status && ['new', 'contacted', 'recovered', 'lost'].includes(status)) {
      queryValues.push(status);
      queryText += ` AND sl.status = $${queryValues.length}`;
    }
    if (storeId && storeId !== 'all') {
      queryValues.push(storeId);
      queryText += ` AND sl.store_id = $${queryValues.length}`;
    }
    queryText += ` ORDER BY sl.received_at DESC`;
    const result = await pool.query(queryText, queryValues);
    res.json(result.rows);
  } catch (err) {
    console.error("Erro em GET /api/leads:", err);
    res.status(500).json({ error: 'Erro ao buscar os leads.' });
  }
});

app.get('/api/agent/stores', authMiddleware, async (req, res) => {
  try {
    const agentId = req.user.userId;
    const queryText = `
      SELECT s.id, s.name 
      FROM stores s
      JOIN agent_store_assignments asa ON s.id = asa.store_id
      WHERE asa.agent_id = $1
      ORDER BY s.name;
    `;
    const result = await pool.query(queryText, [agentId]);
    res.json(result.rows);
  } catch (err) {
    console.error("Erro em GET /api/agent/stores:", err);
    res.status(500).json({ error: 'Erro ao buscar lojas do atendente.' });
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
