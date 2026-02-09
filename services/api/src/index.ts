import express from 'express';
import cors from 'cors';
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Database connection
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME || 'arbitrage_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Get latest prices for all exchanges
app.get('/api/prices/latest', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        e.name AS exchange,
        tp.symbol AS trading_pair,
        p.price,
        p.bid,
        p.ask,
        p.volume_24h,
        p.timestamp,
        EXTRACT(EPOCH FROM (NOW() - p.timestamp)) AS age_seconds
      FROM prices p
      JOIN exchanges e ON p.exchange_id = e.id
      JOIN trading_pairs tp ON p.trading_pair_id = tp.id
      WHERE e.is_active = true
        AND tp.is_active = true
        AND p.id IN (
          SELECT DISTINCT ON (exchange_id, trading_pair_id) id
          FROM prices
          WHERE timestamp > NOW() - INTERVAL '30 seconds'
          ORDER BY exchange_id, trading_pair_id, timestamp DESC
        )
      ORDER BY tp.symbol, e.name
    `);

    res.json({
      count: result.rows.length,
      prices: result.rows,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching latest prices:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Detect arbitrage opportunities
app.get('/api/arbitrage/opportunities', async (req, res) => {
  try {
    const minProfitPercent = parseFloat(req.query.minProfit as string) || 0.1;

    const result = await pool.query(`
      SELECT
        tp.symbol AS trading_pair,
        tp.base_currency,
        tp.quote_currency,
        e1.name AS buy_exchange,
        e2.name AS sell_exchange,
        p1.ask AS buy_price,
        p2.bid AS sell_price,
        e1.trading_fee AS buy_fee,
        e2.trading_fee AS sell_fee,
        ((p2.bid - p1.ask) / p1.ask * 100.0) AS spread_percentage,
        ((p2.bid * (1.0 - e2.trading_fee) - p1.ask * (1.0 + e1.trading_fee)) /
         (p1.ask * (1.0 + e1.trading_fee)) * 100.0) AS profit_after_fees,
        p1.timestamp AS buy_timestamp,
        p2.timestamp AS sell_timestamp,
        GREATEST(
          EXTRACT(EPOCH FROM (NOW() - p1.timestamp)),
          EXTRACT(EPOCH FROM (NOW() - p2.timestamp))
        ) AS max_age_seconds
      FROM prices p1
      JOIN exchanges e1 ON p1.exchange_id = e1.id
      JOIN trading_pairs tp ON p1.trading_pair_id = tp.id
      JOIN prices p2 ON p2.trading_pair_id = p1.trading_pair_id
      JOIN exchanges e2 ON p2.exchange_id = e2.id
      WHERE e1.is_active = true
        AND e2.is_active = true
        AND tp.is_active = true
        AND e1.id < e2.id
        AND p1.ask IS NOT NULL
        AND p2.bid IS NOT NULL
        AND p2.bid > p1.ask
        AND p1.timestamp > NOW() - INTERVAL '2 minutes'
        AND p2.timestamp > NOW() - INTERVAL '2 minutes'
        AND p1.id IN (
          SELECT DISTINCT ON (exchange_id, trading_pair_id) id
          FROM prices
          WHERE timestamp > NOW() - INTERVAL '2 minutes'
          ORDER BY exchange_id, trading_pair_id, timestamp DESC
        )
        AND p2.id IN (
          SELECT DISTINCT ON (exchange_id, trading_pair_id) id
          FROM prices
          WHERE timestamp > NOW() - INTERVAL '2 minutes'
          ORDER BY exchange_id, trading_pair_id, timestamp DESC
        )
        AND ((p2.bid * (1.0 - e2.trading_fee) - p1.ask * (1.0 + e1.trading_fee)) /
             (p1.ask * (1.0 + e1.trading_fee)) * 100.0) > $1
      ORDER BY profit_after_fees DESC
      LIMIT 50
    `, [minProfitPercent]);

    res.json({
      count: result.rows.length,
      opportunities: result.rows,
      minProfitPercent,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error detecting arbitrage opportunities:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get price history for a specific trading pair
app.get('/api/prices/history/:tradingPair', async (req, res) => {
  try {
    const { tradingPair } = req.params;
    const limit = parseInt(req.query.limit as string) || 100;

    const result = await pool.query(`
      SELECT
        e.name AS exchange,
        p.price,
        p.bid,
        p.ask,
        p.volume_24h,
        p.timestamp
      FROM prices p
      JOIN exchanges e ON p.exchange_id = e.id
      JOIN trading_pairs tp ON p.trading_pair_id = tp.id
      WHERE tp.symbol = $1
        AND p.timestamp > NOW() - INTERVAL '1 hour'
      ORDER BY p.timestamp DESC
      LIMIT $2
    `, [tradingPair, limit]);

    res.json({
      tradingPair,
      count: result.rows.length,
      history: result.rows,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching price history:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get exchange statistics
app.get('/api/stats/exchanges', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        e.name AS exchange,
        e.trading_fee,
        COUNT(DISTINCT p.trading_pair_id) AS active_pairs,
        COUNT(p.id) AS total_updates,
        MAX(p.timestamp) AS last_update,
        EXTRACT(EPOCH FROM (NOW() - MAX(p.timestamp))) AS seconds_since_update
      FROM exchanges e
      LEFT JOIN prices p ON p.exchange_id = e.id
        AND p.timestamp > NOW() - INTERVAL '5 minutes'
      WHERE e.is_active = true
      GROUP BY e.id, e.name, e.trading_fee
      ORDER BY e.name
    `);

    res.json({
      exchanges: result.rows,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching exchange stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Arbitrage API server listening on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Latest prices: http://localhost:${PORT}/api/prices/latest`);
  console.log(`Arbitrage opportunities: http://localhost:${PORT}/api/arbitrage/opportunities`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down gracefully...');
  await pool.end();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  await pool.end();
  process.exit(0);
});
