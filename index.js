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
//                           ROTAS PROTEGIDAS e DE ADMIN
// =================================================================
// (Todas as suas rotas /api/... e /api/admin/... continuam aqui)
app.get('/api/me', authMiddleware, async (req, res) => { /* ...código completo daqui... */ });
// ... e assim por diante para todas as outras ...


// =================================================================
//                         INICIALIZAÇÃO DO SERVIDOR
// =================================================================
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
