import WebSocket from 'ws';
import { Database } from '../database';

export interface KrakenTickerData {
    a: [string, string, string]; // Ask [price, whole lot volume, lot volume]
    b: [string, string, string]; // Bid [price, whole lot volume, lot volume]
    c: [string, string]; // Close [price, lot volume]
    v: [string, string]; // Volume [today, last 24 hours]
    p: [string, string]; // Volume weighted average price [today, last 24 hours]
    t: [number, number]; // Number of trades [today, last 24 hours]
    l: [string, string]; // Low [today, last 24 hours]
    h: [string, string]; // High [today, last 24 hours]
    o: [string, string]; // Open [today, last 24 hours]
}

export class KrakenConnector {
    private ws: WebSocket | null = null;
    private db: Database;
    private exchangeId: number | null = null;
    private reconnectTimeout: NodeJS.Timeout | null = null;
    private pairs: string[];

    constructor(db: Database, pairs: string[] = ['XBT/USD', 'ETH/USD']) {
        this.db = db;
        this.pairs = pairs;
    }

    async initialize() {
        this.exchangeId = await this.db.getExchangeId('Kraken');
        if (!this.exchangeId) {
            throw new Error('Kraken exchange not found in database');
        }
        console.log('Kraken connector initialized with exchange ID:', this.exchangeId);
    }

    connect() {
        const wsUrl = 'wss://ws.kraken.com';

        console.log(`Connecting to Kraken: ${wsUrl}`);
        this.ws = new WebSocket(wsUrl);

        this.ws.on('open', () => {
            console.log('Connected to Kraken WebSocket');
            this.subscribe();
        });

        this.ws.on('message', async (data: WebSocket.Data) => {
            try {
                const message = JSON.parse(data.toString());

                if (Array.isArray(message)) {
                    if (message.length === 4 && message[2] === 'ticker') {
                        await this.handleTickerUpdate(message[3], message[1]);
                    }
                } else if (message.event === 'subscriptionStatus') {
                    console.log('Kraken subscription status:', message);
                }
            } catch (error) {
                console.error('Error processing Kraken message:', error);
            }
        });

        this.ws.on('error', (error) => {
            console.error('Kraken WebSocket error:', error);
        });

        this.ws.on('close', () => {
            console.log('Kraken WebSocket closed. Reconnecting in 5s');
            this.scheduleReconnect();
        });
    }

    private subscribe() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const subscribeMessage = {
            event: 'subscribe',
            pair: this.pairs,
            subscription: {
                name: 'ticker',
            },
        };

        this.ws.send(JSON.stringify(subscribeMessage));
        console.log('Subscribed to Kraken pairs:', this.pairs);
    }

    private async handleTickerUpdate(pair: string, data: KrakenTickerData) {
        try {
            if (!this.exchangeId) return;

            const tradingPair = this.convertPairToTradingPair(pair);

            const tradingPairId = await this.db.getTradingPairId(tradingPair);
            if (!tradingPairId) {
                console.warn(`Trading pair ${tradingPair} not found in database`);
                return;
            }

            const price = parseFloat(data.c[0]);
            const volume24h = parseFloat(data.v[1]);
            const bid = parseFloat(data.b[0]);
            const ask = parseFloat(data.a[0]);

            await this.db.insertPrice({
                exchangeId: this.exchangeId,
                tradingPairId,
                price,
                volume24h,
                bid,
                ask,
            });

            console.log(`[Kraken] ${tradingPair}: $${price.toFixed(2)} | Bid: $${bid.toFixed(2)} | Ask: $${ask.toFixed(2)}`);
        } catch (error) {
            console.error('Error handling Kraken ticker update:', error);
        }
    }

    private convertPairToTradingPair(pair: string): string {
        let normalized = pair.replace('XBT', 'BTC').replace('/', '_');
        return normalized;
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
            if (this.ws.readyState === WebSocket.OPEN) {
                const unsubscribeMessage = {
                    event: 'unsubscribe',
                    pair: this.pairs,
                    subscription: {
                        name: 'ticker',
                    },
                };
                this.ws.send(JSON.stringify(unsubscribeMessage));
            }
            this.ws.close();
            this.ws = null;
        }
    }
}