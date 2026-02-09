import WebSocket from 'ws';
import { Database } from '../database';

export interface CoinbaseTickerData {
    type: string;
    sequence: number;
    product_id: string;
    price: string;
    open_24h: string;
    volume_24h: string;
    low_24h: string;
    high_24h: string;
    volume_30d: string;
    best_bid: string;
    best_ask: string;
    side: string;
    time: string;
    trade_id: number;
    last_size: string;
}

export class CoinbaseConnector {
    private ws: WebSocket | null = null;
    private db: Database;
    private exchangeId: number | null = null;
    private reconnectTimeout: NodeJS.Timeout | null = null;
    private productIds: string[];

    constructor(db: Database, productIds: string[] = ['BTC-USD', 'ETH-USD']) {
        this.db = db;
        this.productIds = productIds;
    }

    async initialize() {
        this.exchangeId = await this.db.getExchangeId('Coinbase');
        if (!this.exchangeId) {
            throw new Error('Coinbase exchange not found in database');
        }
        console.log('Coinbase connector initialized with exchange ID:', this.exchangeId);
    }

    connect() {
        const wsUrl = 'wss://ws-feed.exchange.coinbase.com';

        console.log(`Connecting to Coinbase: ${wsUrl}`);
        this.ws = new WebSocket(wsUrl);

        this.ws.on('open', () => {
            console.log('Connected to Coinbase WebSocket');
            this.subscribe();
        });

        this.ws.on('message', async (data: WebSocket.Data) => {
            try {
                const message = JSON.parse(data.toString());

                if (message.type === 'ticker') {
                    await this.handleTickerUpdate(message as CoinbaseTickerData);
                } else if (message.type === 'subscriptions') {
                    console.log('Coinbase subscriptions confirmed:', message.channels);
                }
            } catch (error) {
                console.error('Error processing Coinbase message:', error);
            }
        });

        this.ws.on('error', (error) => {
            console.error('Coinbase WebSocket error:', error);
        });

        this.ws.on('close', () => {
            console.log('Coinbase WebSocket closed. Reconnecting in 5s');
            this.scheduleReconnect();
        });
    }

    private subscribe() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const subscribeMessage = {
            type: 'subscribe',
            product_ids: this.productIds,
            channels: ['ticker'],
        };

        this.ws.send(JSON.stringify(subscribeMessage));
        console.log('Subscribed to Coinbase products:', this.productIds);
    }

    private async handleTickerUpdate(data: CoinbaseTickerData) {
        try {
            if (!this.exchangeId) return;

            const productId = data.product_id;
            const tradingPair = this.convertProductIdToTradingPair(productId);

            const tradingPairId = await this.db.getTradingPairId(tradingPair);
            if (!tradingPairId) {
                console.warn(`Trading pair ${tradingPair} not found in database`);
                return;
            }

            const price = parseFloat(data.price);
            const volume24h = parseFloat(data.volume_24h);
            const bid = parseFloat(data.best_bid);
            const ask = parseFloat(data.best_ask);

            await this.db.insertPrice({
                exchangeId: this.exchangeId,
                tradingPairId,
                price,
                volume24h,
                bid,
                ask,
            });

            console.log(`[Coinbase] ${tradingPair}: $${price.toFixed(2)} | Bid: $${bid.toFixed(2)} | Ask: $${ask.toFixed(2)}`);
        } catch (error) {
            console.error('Error handling Coinbase ticker update:', error);
        }
    }

    private convertProductIdToTradingPair(productId: string): string {
        return productId.replace('-', '_');
    }

    private scheduleReconnect() {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
        }
        this.reconnectTimeout = setTimeout(() => {
            this.connect();
        }, 5000);
    }

    disconnect() {
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}