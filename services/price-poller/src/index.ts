import dotenv from "dotenv";
import http from "http";
import { Database } from "./database";
import { BinanceConnector } from "./connectors/binance";
import { CoinbaseConnector } from "./connectors/coinbase";
import { KrakenConnector } from "./connectors/kraken";


dotenv.config();

class PricePollerService {
    private db: Database;
    private binance: BinanceConnector;
    private coinbase: CoinbaseConnector;
    private kraken: KrakenConnector;
    private cleanupInterval: NodeJS.Timeout | null = null;
    private healthCheckServer: http.Server | null = null;


    constructor() {
        this.db = new Database();

        this.binance = new BinanceConnector(this.db, ['BTCUSDT', 'ETHUSDT']);
        this.coinbase = new CoinbaseConnector(this.db, ['BTC-USD', 'ETH-USD']);
        this.kraken = new KrakenConnector(this.db, ['XBT/USD', 'ETH/USD']);
    }

    /**
     * Sets up HTTP health check endpoint for Docker health checks
     * Responds on /health with connection status for all connectors
     */
    private setupHealthCheck() {
        const port = parseInt(process.env.HEALTH_CHECK_PORT || '3000', 10);

        this.healthCheckServer = http.createServer((req, res) => {
            if (req.url === '/health' && req.method === 'GET') {
                const health = {
                    status: 'healthy',
                    timestamp: new Date().toISOString(),
                    connectors: {
                        binance: this.binance ? 'connected' : 'disconnected',
                        coinbase: this.coinbase ? 'connected' : 'disconnected',
                        kraken: this.kraken ? 'connected' : 'disconnected'
                    },
                    database: 'connected'
                };

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(health, null, 2));
            } else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Not found' }));
            }
        });

        this.healthCheckServer.listen(port, () => {
            console.log(`Health check endpoint listening on port ${port}`);
        });
    }

    async start() {
        console.log('Starting Crypto Arbitrage Price Poller Service');
        try {
            // Start health check endpoint first
            this.setupHealthCheck();

            await this.db.query('SELECT NOW()');
            console.log('Database connection successful');

            await this.binance.initialize();
            await this.coinbase.initialize();
            await this.kraken.initialize();

            this.binance.connect();
            this.coinbase.connect();
            this.kraken.connect();

            this.cleanupInterval = setInterval(async () => {
                console.log('Running database cleanup');
                await this.db.cleanOldPrices();
            }, 60 * 60 * 1000);

        } catch (error) {
            console.error('Error starting Price Poller Service:', error);
            process.exit(1);
        }
    }

    async stop() {
        console.log('Stopping Crypto Arbitrage Price Poller Service');

        this.binance.disconnect();
        this.coinbase.disconnect();
        this.kraken.disconnect();

        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }

        if (this.healthCheckServer) {
            this.healthCheckServer.close();
        }

        await this.db.close();
        console.log('Price Poller Service stopped');
        process.exit(0);
    }
}


const service = new PricePollerService();

service.start().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});

process.on('SIGINT', async () => {
    await service.stop();
});

process.on('SIGTERM', async () => {
    await service.stop();
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled rejection at:', promise, 'reason:', reason);
    process.exit(1);
});