// worker.js - Nosso trabalhador de segundo plano

const { Worker } = require('bullmq');
const { Pool } = require('pg');
const Redis = require('ioredis');

// Configuração das conexões
const redisConnection = new Redis(process.env.REDIS_URL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

console.log('Worker iniciado e esperando por tarefas...');

// O Worker escuta por tarefas na fila 'recovery-queue'
const worker = new Worker('recovery-queue', async job => {
  const { transactionId, storeId, rawData, parsedData } = job.data;
  console.log(`Processando job para a transação: ${transactionId}`);

  // 1. Verifica se o pedido foi pago nesse meio tempo
  const isPaid = await redisConnection.get(`paid:${transactionId}`);

  if (isPaid) {
    console.log(`Transação ${transactionId} foi paga. Job cancelado.`);
    // Se foi pago, não fazemos nada.
    return;
  }

  // 2. Se não foi pago, cria o lead para recuperação
  console.log(`Transação ${transactionId} não foi paga. Criando lead...`);
  try {
    const queryText = 'INSERT INTO sales_leads (store_id, raw_data, parsed_data, status) VALUES ($1, $2, $3, $4)';
    const queryValues = [storeId, rawData, parsedData, 'new'];
    await pool.query(queryText, queryValues);
    console.log(`Lead para a transação ${transactionId} criado com sucesso.`);
  } catch (err) {
    console.error(`Erro ao salvar lead para a transação ${transactionId}:`, err);
  }
}, { connection: redisConnection });

worker.on('failed', (job, err) => {
  console.error(`Job ${job.id} falhou com o erro: ${err.message}`);
});
