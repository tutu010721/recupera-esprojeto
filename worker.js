const { Worker } = require('bullmq');
const { Pool } = require('pg');
const Redis = require('ioredis');

// Verificação de variáveis de ambiente, que o Render nos fornece
if (!process.env.REDIS_URL || !process.env.DATABASE_URL) {
  console.error('As variáveis de ambiente REDIS_URL e DATABASE_URL são obrigatórias.');
  process.exit(1);
}

// Configuração das conexões
const redisConnection = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

console.log('Worker iniciado. Conectado ao Redis e pronto para receber tarefas da "recovery-queue".');

const worker = new Worker('recovery-queue', async job => {
  const { transactionId, storeId, rawData, parsedData } = job.data;
  console.log(`[WORKER] Processando job para a transação: ${transactionId}`);

  // 1. Verifica no Redis se o pedido foi pago nesse meio tempo
  const isPaid = await redisConnection.get(`paid:${transactionId}`);

  if (isPaid) {
    console.log(`[WORKER] Transação ${transactionId} foi PAGA. O lead NÃO será criado.`);
    return { status: 'paid_and_skipped' };
  }

  // 2. Se não foi pago, cria o lead para recuperação
  console.log(`[WORKER] Transação ${transactionId} NÃO foi paga. Criando lead de recuperação...`);
  try {
    const queryText = 'INSERT INTO sales_leads (store_id, raw_data, parsed_data, status) VALUES ($1, $2, $3, $4)';
    const queryValues = [storeId, rawData, parsedData, 'new'];
    await pool.query(queryText, queryValues);
    console.log(`[WORKER] Lead para a transação ${transactionId} criado com sucesso no banco de dados.`);
    return { status: 'lead_created' };
  } catch (err) {
    console.error(`[WORKER] ERRO ao salvar lead para a transação ${transactionId}:`, err);
    throw err; // Lança o erro para que a BullMQ possa registrar a falha
  }
}, { connection: redisConnection });

worker.on('completed', (job, result) => {
  console.log(`[WORKER] Job ${job.id} (Transação: ${job.data.transactionId}) completado com status: ${result.status}`);
});

worker.on('failed', (job, err) => {
  console.error(`[WORKER] Job ${job.id} (Transação: ${job.data.transactionId}) falhou com o erro: ${err.message}`);
});
