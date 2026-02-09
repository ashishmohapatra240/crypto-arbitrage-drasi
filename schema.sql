-- Crypto Arbitrage Detector - Database Schema
-- PostgreSQL 16 with Change Data Capture (CDC) for Drasi

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- =====================================================
-- 1. EXCHANGES TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS exchanges (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(50) UNIQUE NOT NULL,
    trading_fee DECIMAL(5, 4) NOT NULL DEFAULT 0.001, -- Fee as decimal (0.001 = 0.1%)
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable CDC for exchanges table
ALTER TABLE exchanges REPLICA IDENTITY FULL;

-- =====================================================
-- 2. TRADING PAIRS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS trading_pairs (
    id BIGSERIAL PRIMARY KEY,
    symbol VARCHAR(20) UNIQUE NOT NULL, -- e.g., BTC_USDT, ETH_USD
    base_currency VARCHAR(10) NOT NULL, -- e.g., BTC, ETH
    quote_currency VARCHAR(10) NOT NULL, -- e.g., USDT, USD
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable CDC for trading_pairs table
ALTER TABLE trading_pairs REPLICA IDENTITY FULL;

-- =====================================================
-- 3. PRICES TABLE (Time-series data)
-- =====================================================
CREATE TABLE IF NOT EXISTS prices (
    id BIGSERIAL PRIMARY KEY,
    exchange_id BIGINT NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
    trading_pair_id BIGINT NOT NULL REFERENCES trading_pairs(id) ON DELETE CASCADE,
    price DECIMAL(20, 8) NOT NULL, -- Current/last traded price
    bid DECIMAL(20, 8), -- Best bid (buy) price
    ask DECIMAL(20, 8), -- Best ask (sell) price
    volume_24h DECIMAL(20, 8), -- 24-hour trading volume
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable CDC for prices table (CRITICAL for Drasi)
ALTER TABLE prices REPLICA IDENTITY FULL;

-- =====================================================
-- INDEXES FOR PERFORMANCE
-- =====================================================

-- Index for time-series queries (most recent prices)
CREATE INDEX idx_prices_timestamp ON prices(timestamp DESC);

-- Index for exchange + trading pair lookups
CREATE INDEX idx_prices_exchange_pair ON prices(exchange_id, trading_pair_id);

-- Composite index for latest price queries (most common query pattern)
CREATE INDEX idx_prices_lookup ON prices(exchange_id, trading_pair_id, timestamp DESC);

-- Index for active exchanges and pairs
CREATE INDEX idx_exchanges_active ON exchanges(is_active) WHERE is_active = true;
CREATE INDEX idx_trading_pairs_active ON trading_pairs(is_active) WHERE is_active = true;

-- =====================================================
-- SEED DATA: EXCHANGES
-- =====================================================
INSERT INTO exchanges (name, trading_fee, is_active) VALUES
    ('Binance', 0.001, true),   -- 0.1% trading fee
    ('Coinbase', 0.005, true),  -- 0.5% trading fee
    ('Kraken', 0.0026, true)    -- 0.26% trading fee
ON CONFLICT (name) DO UPDATE SET
    trading_fee = EXCLUDED.trading_fee,
    is_active = EXCLUDED.is_active,
    updated_at = NOW();

-- =====================================================
-- SEED DATA: TRADING PAIRS
-- =====================================================
-- Note: Normalized format (BTC_USDT, BTC_USD) - connectors handle exchange-specific formats
INSERT INTO trading_pairs (symbol, base_currency, quote_currency, is_active) VALUES
    ('BTC_USDT', 'BTC', 'USDT', true),
    ('ETH_USDT', 'ETH', 'USDT', true),
    ('BTC_USD', 'BTC', 'USD', true),
    ('ETH_USD', 'ETH', 'USD', true)
ON CONFLICT (symbol) DO UPDATE SET
    base_currency = EXCLUDED.base_currency,
    quote_currency = EXCLUDED.quote_currency,
    is_active = EXCLUDED.is_active,
    updated_at = NOW();

-- =====================================================
-- UTILITY FUNCTIONS
-- =====================================================

-- Function to clean up old prices (called by price-poller service)
CREATE OR REPLACE FUNCTION cleanup_old_prices(retention_hours INTEGER DEFAULT 24)
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    DELETE FROM prices
    WHERE timestamp < NOW() - (retention_hours || ' hours')::INTERVAL;

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Function to get latest price for an exchange-pair combination
CREATE OR REPLACE FUNCTION get_latest_price(
    p_exchange_name VARCHAR,
    p_trading_pair_symbol VARCHAR
)
RETURNS TABLE (
    price DECIMAL(20, 8),
    bid DECIMAL(20, 8),
    ask DECIMAL(20, 8),
    volume_24h DECIMAL(20, 8),
    price_timestamp TIMESTAMP WITH TIME ZONE
) AS $$
BEGIN
    RETURN QUERY
    SELECT p.price, p.bid, p.ask, p.volume_24h, p.timestamp
    FROM prices p
    JOIN exchanges e ON p.exchange_id = e.id
    JOIN trading_pairs tp ON p.trading_pair_id = tp.id
    WHERE e.name = p_exchange_name
      AND tp.symbol = p_trading_pair_symbol
      AND e.is_active = true
      AND tp.is_active = true
    ORDER BY p.timestamp DESC
    LIMIT 1;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- VIEWS FOR ANALYSIS
-- =====================================================

-- View: Latest prices across all exchanges
CREATE OR REPLACE VIEW v_latest_prices AS
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
    -- Get most recent price for each exchange-pair combination
    SELECT DISTINCT ON (exchange_id, trading_pair_id) id
    FROM prices
    ORDER BY exchange_id, trading_pair_id, timestamp DESC
  )
ORDER BY tp.symbol, e.name;

-- View: Current arbitrage opportunities (simplified SQL version)
CREATE OR REPLACE VIEW v_arbitrage_opportunities AS
SELECT
    tp.symbol AS trading_pair,
    e1.name AS buy_exchange,
    e2.name AS sell_exchange,
    p1.ask AS buy_price,
    p2.bid AS sell_price,
    ((p2.bid - p1.ask) / p1.ask * 100.0) AS spread_percentage,
    ((p2.bid * (1.0 - e2.trading_fee) - p1.ask * (1.0 + e1.trading_fee)) /
     (p1.ask * (1.0 + e1.trading_fee)) * 100.0) AS profit_after_fees,
    p1.timestamp AS buy_timestamp,
    p2.timestamp AS sell_timestamp
FROM prices p1
JOIN exchanges e1 ON p1.exchange_id = e1.id
JOIN trading_pairs tp ON p1.trading_pair_id = tp.id
JOIN prices p2 ON p2.trading_pair_id = p1.trading_pair_id
JOIN exchanges e2 ON p2.exchange_id = e2.id
WHERE e1.is_active = true
  AND e2.is_active = true
  AND tp.is_active = true
  AND e1.id < e2.id  -- Avoid duplicate pairs
  AND p1.ask IS NOT NULL
  AND p2.bid IS NOT NULL
  AND p2.bid > p1.ask  -- Arbitrage exists
  AND p1.timestamp > NOW() - INTERVAL '10 seconds'
  AND p2.timestamp > NOW() - INTERVAL '10 seconds'
  AND ((p2.bid * (1.0 - e2.trading_fee) - p1.ask * (1.0 + e1.trading_fee)) /
       (p1.ask * (1.0 + e1.trading_fee)) * 100.0) > 0.1  -- Min 0.1% profit
ORDER BY profit_after_fees DESC;

-- =====================================================
-- VERIFICATION QUERIES
-- =====================================================

-- Display schema information
DO $$
BEGIN
    RAISE NOTICE '=====================================================';
    RAISE NOTICE 'Database Schema Initialization Complete';
    RAISE NOTICE '=====================================================';
    RAISE NOTICE 'Tables created: exchanges, trading_pairs, prices';
    RAISE NOTICE 'CDC enabled: REPLICA IDENTITY FULL on all tables';
    RAISE NOTICE 'Indexes created: Performance optimized for time-series';
    RAISE NOTICE 'Seed data: 3 exchanges, 4 trading pairs';
    RAISE NOTICE '=====================================================';
END $$;

-- Show seed data counts
SELECT 'Exchanges' AS table_name, COUNT(*) AS row_count FROM exchanges
UNION ALL
SELECT 'Trading Pairs', COUNT(*) FROM trading_pairs;

-- Show replica identity status (should be 'f' for FULL)
SELECT
    c.relname AS table_name,
    CASE c.relreplident
        WHEN 'd' THEN 'DEFAULT'
        WHEN 'n' THEN 'NOTHING'
        WHEN 'f' THEN 'FULL'
        WHEN 'i' THEN 'INDEX'
    END AS replica_identity
FROM pg_class c
WHERE c.relname IN ('exchanges', 'trading_pairs', 'prices')
ORDER BY c.relname;
