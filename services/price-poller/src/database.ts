import { Pool, PoolClient } from 'pg';

export class Database {
    private pool: Pool;

    constructor() {
        this.pool = new Pool({
            host: process.env.DB_HOST || 'localhost',
            port: parseInt(process.env.DB_PORT || '5432'),
            database: process.env.DB_NAME || 'arbitrage_db',
            user: process.env.DB_USER || 'postgres',
            password: process.env.DB_PASSWORD || 'postgres',
            max: 20,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 2000,
        });

        this.pool.on('error', (err) => {
            console.error('Unexpected database error:', err);
        });
    }

    async query(text: string, params?: any[]) {
        const start = Date.now();
        try {
            const res = await this.pool.query(text, params);
            const duration = Date.now() - start;
            console.log('Executed query', { text: text.substring(0, 50), duration, rows: res.rowCount });
            return res;
        } catch (error) {
            console.error('Database query error:', error);
            throw error;
        }
    }

    async getClient(): Promise<PoolClient> {
        return await this.pool.connect();
    }

    async close() {
        await this.pool.end();
    }

    async getExchangeId(exchangeName: string): Promise<number | null> {
        const result = await this.query(
            'SELECT id FROM exchanges WHERE name = $1',
            [exchangeName]
        );
        return result.rows.length > 0 ? result.rows[0].id : null;
    }

    async getTradingPairId(symbol: string): Promise<number | null> {
        const result = await this.query(
            'SELECT id FROM trading_pairs WHERE symbol = $1',
            [symbol]
        );
        return result.rows.length > 0 ? result.rows[0].id : null;
    }

    async insertPrice(data: {
        exchangeId: number;
        tradingPairId: number;
        price: number;
        volume24h?: number;
        bid?: number;
        ask?: number;
    }) {
        const query = `
      INSERT INTO prices (exchange_id, trading_pair_id, price, volume_24h, bid, ask, timestamp)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (exchange_id, trading_pair_id, timestamp) 
      DO UPDATE SET 
        price = EXCLUDED.price,
        volume_24h = EXCLUDED.volume_24h,
        bid = EXCLUDED.bid,
        ask = EXCLUDED.ask
      RETURNING id
    `;

        const values = [
            data.exchangeId,
            data.tradingPairId,
            data.price,
            data.volume24h || null,
            data.bid || null,
            data.ask || null,
        ];

        return await this.query(query, values);
    }

    async batchInsertPrices(prices: Array<{
        exchangeId: number;
        tradingPairId: number;
        price: number;
        volume24h?: number;
        bid?: number;
        ask?: number;
    }>) {
        if (prices.length === 0) return;

        const client = await this.getClient();
        try {
            await client.query('BEGIN');

            const query = `
        INSERT INTO prices (exchange_id, trading_pair_id, price, volume_24h, bid, ask, timestamp)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (exchange_id, trading_pair_id, timestamp) 
        DO UPDATE SET 
          price = EXCLUDED.price,
          volume_24h = EXCLUDED.volume_24h,
          bid = EXCLUDED.bid,
          ask = EXCLUDED.ask
      `;

            for (const price of prices) {
                await client.query(query, [
                    price.exchangeId,
                    price.tradingPairId,
                    price.price,
                    price.volume24h || null,
                    price.bid || null,
                    price.ask || null,
                ]);
            }

            await client.query('COMMIT');
            console.log(`Batch inserted ${prices.length} price records`);
        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Batch insert error:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    async cleanOldPrices() {
        const result = await this.query(
            "DELETE FROM prices WHERE timestamp < NOW() - INTERVAL '24 hours'"
        );
        console.log(`Cleaned ${result.rowCount} old price records`);
    }
}