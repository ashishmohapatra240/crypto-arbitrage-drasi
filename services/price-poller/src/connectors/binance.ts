import WebSocket from "ws";
import { Database } from "../database";

export interface BinanceTickerData {
    e: string; // Event type
    E: number; // Event time
    s: string; // Symbol
    c: string; // Close price
    o: string; // Open price
    h: string; // High price
    l: string; // Low price
    v: string; // Total traded base asset volume
    q: string; // Total traded quote asset volume
    b: string; // Best bid price
    a: string; // Best ask price
}

export class BinanceConnector {
    private ws: WebSocket | null = null;
    private db: Database;
    private exchangeId: number | null = null;
    private reconnectTimeout: NodeJS.Timeout | null = null;
    private pingInterval: NodeJS.Timeout | null = null;
    private symbols: string[];

    constructor(db: Database, symbols: string[] = ['btcusdt', 'ethusdt']) {
        this.db = db;
        this.symbols = symbols;
    }

    async initialize() {
        this.exchangeId = await this.db.getExchangeId('Binance');
        if (!this.exchangeId) {
            throw new Error('Binance exchange not found');
        }

        for (const symbol of this.symbols) {
            const tradingPair = this.convertSymbolToTradingPair(symbol);
            const tradingPairId = await this.db.getTradingPairId(tradingPair);
            if (!tradingPairId) {
                throw new Error(`Trading pair ${tradingPair} not found for symbol ${symbol}`);
            }
        }
        console.log('Binance connector initialized with exchange ID:', this.exchangeId);
    }


    connect() {
        const streams = this.symbols.map(s => `${s.toLowerCase()}@ticker`).join('/');
        const wsUrl = `wss://stream.binance.com:9443/stream?streams=${streams}`;
        console.log(`Connecting to Binance: ${wsUrl}`);
        this.ws = new WebSocket(wsUrl);

        this.ws.on('open', () => {
            console.log('Connected to Binance WebSocket');
            this.startPingInterval();
        });

        this.ws.on('message', async (data: WebSocket.Data) => {
            try {
                const message = JSON.parse(data.toString());

                if (message.stream && message.data) {
                    await this.handleTickerUpdate(message.data);
                }
            } catch (error) {
                console.error('Error processing Binance message:', error);
            }
        });

        this.ws.on('error', (error) => {
            console.error('Binance WebSocket error:', error);
        });


        this.ws.on('close', () => {
            console.log('Binance WebSocket closed. Reconnecting in 5s');
            this.stopPingInterval();
            this.scheduleReconnect();
        });

        this.ws.on('ping', () => {
            this.ws?.pong();
        });
    }

    private async handleTickerUpdate(data: BinanceTickerData) {
        try {
            if (!this.exchangeId) return;

            const symbol = data.s;
            const tradingPair = this.convertSymbolToTradingPair(symbol);

            const tradingPairId = await this.db.getTradingPairId(tradingPair);
            if (!tradingPairId) {
                console.warn(`Trading pair ${tradingPair} not found in database`);
                return;
            }

            const price = parseFloat(data.c);
            const volume24h = parseFloat(data.v);
            const bid = parseFloat(data.b);
            const ask = parseFloat(data.a);

            await this.db.insertPrice({
                exchangeId: this.exchangeId,
                tradingPairId,
                price,
                volume24h,
                bid,
                ask,
            });

            console.log(`[Binance] ${tradingPair}: $${price.toFixed(2)} | Bid: $${bid.toFixed(2)} | Ask: $${ask.toFixed(2)}`);
        } catch (error) {
            console.error('Error handling Binance ticker update:', error);
        }
    }

    private convertSymbolToTradingPair(symbol: string): string {
        const base = symbol.slice(0, -4);
        const quote = symbol.slice(-4);
        return `${base}_${quote}`;
    }

    private startPingInterval() {
        this.pingInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.ping();
            }
        }, 30000);
    }

    private stopPingInterval() {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
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
        this.stopPingInterval();
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