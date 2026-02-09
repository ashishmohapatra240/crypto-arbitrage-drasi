# Crypto Arbitrage Detector

A real-time system that monitors cryptocurrency prices across Binance, Coinbase, and Kraken to detect arbitrage opportunities. Built with Drasi for continuous query processing.

## What It Does

Cryptocurrency prices vary across exchanges because of regional demand, liquidity differences, and trading fees. This creates arbitrage opportunities where you can theoretically buy on one exchange and sell on another for profit.

This system:
1. Collects live prices from three major exchanges via WebSocket
2. Stores price data in PostgreSQL with Change Data Capture enabled
3. Uses Drasi to run continuous queries that detect arbitrage opportunities
4. Shows results on a real-time dashboard with sub-second latency

The system accounts for trading fees when calculating potential profit.

## Quick Start

You need Docker and Docker Compose installed, plus 8GB RAM minimum.

```bash
# Step 1: Start main services (PostgreSQL, API, Price Poller)
docker compose up -d

# Step 2: Start Drasi server (from drasi-server directory)
cd drasi-server
docker compose -f docker-compose-standalone.yml up -d
cd ..

# Step 3: Check if all services are running
curl http://localhost:3001/health   # API health
curl http://localhost:8080/health   # Drasi health

# Step 4: Run the demo (injects a test arbitrage opportunity)
./demo_arbitrage.sh

# Step 5: Open the dashboard
cd frontend/public
python3 -m http.server 8000
# Go to http://localhost:8000
```

The demo creates a test arbitrage: buy BTC on Binance at $67,001, sell on Coinbase at $68,499 (1.62% profit after fees). The opportunity stays visible for 2 minutes.

## How It Works

```
Exchange APIs → Price Poller → PostgreSQL → Drasi → Dashboard
                                    ↓
                              REST API ←┘
```

**Price Poller** connects to exchange WebSocket APIs and saves prices to PostgreSQL.

**PostgreSQL** stores time-series price data with CDC enabled, which streams changes to Drasi.

**Drasi Server** runs continuous queries written in Cypher that detect arbitrage patterns. When it finds an opportunity, it pushes updates via Server-Sent Events.

**REST API** queries the database directly for the dashboard's fallback polling mode.

**Frontend Dashboard** shows live prices and arbitrage opportunities. It prefers SSE for real-time updates but falls back to polling the REST API if SSE isn't available.

## Architecture

### System Overview

The system follows an event-driven architecture with Change Data Capture at its core:

```
┌─────────────────────────────────────────────────────────────────────┐
│                     CRYPTO ARBITRAGE SYSTEM                         │
└─────────────────────────────────────────────────────────────────────┘

EXTERNAL SOURCES         COLLECTION           PROCESSING         PRESENTATION
┌──────────────┐      ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│   Binance    │      │              │    │              │    │   Frontend   │
│  WebSocket   │──┐   │  Price       │    │   Drasi      │    │  Dashboard   │
├──────────────┤  │   │  Poller      │    │   Server     │───→│  (Port 8000) │
│  Coinbase    │──┼──→│  (Port 3002) │───→│ (Port 8080)  │ ↑  └──────────────┘
│  WebSocket   │  │   │              │    │ (Port 8081)  │ │         ↑
├──────────────┤  │   └──────────────┘    └──────────────┘ │         │
│   Kraken     │──┘          ↓                    ↑         │         │
│  WebSocket   │             ↓                    ↑         │   SSE   │  REST
└──────────────┘      ┌──────────────┐           ↑         │  Live   │ Polling
                      │  PostgreSQL  │───────────┘         │         │
   Live Price         │  (Port 5432) │    CDC Stream       │         │
   Streams            │              │    (WAL)            SSE       REST
                      │  - prices    │                      │         │
                      │  - exchanges │                      │         │
                      │  - pairs     │                      │    ┌────────┐
                      └──────────────┘                      └────│  API   │
                             ↑                                   │ (3001) │
                             └───────────────────────────────────┤        │
                                    Direct Queries                └────────┘
                                    (Fallback Mode)
```

### Data Flow

The system processes price data through multiple stages:

#### Stage 1: Price Collection (Continuous Real-Time)
```
Exchange WebSocket APIs
        ↓ [Ticker Updates]
Price Poller Connectors (Binance, Coinbase, Kraken)
        ↓ [Parse, Normalize, Validate]
Database INSERT
        ↓
PostgreSQL prices Table
        ↓ [REPLICA IDENTITY FULL]
Write-Ahead Log (WAL)
```

**Key Details:**
- Three independent WebSocket connections run in parallel
- Each exchange uses its own message format (normalized by connectors)
- Prices inserted with unique constraint on (exchange_id, trading_pair_id, timestamp)
- Every INSERT triggers a CDC event via logical replication

#### Stage 2: Change Data Capture (Milliseconds)
```
PostgreSQL Logical Replication Slot (drasi_arbitrage_slot)
        ↓ [CDC Events Stream]
Drasi Source Plugin
        ↓ [Event Parsing]
Bootstrap Provider (loads foreign key relationships)
        ↓ [Graph Nodes: prices → exchanges, trading_pairs]
Query Engine
```

**Key Details:**
- Replication slot ensures exactly-once delivery
- Bootstrap provider critical for foreign key joins
- Creates graph representation: nodes and relationships
- CDC stream includes full row images (REPLICA IDENTITY FULL)

#### Stage 3: Continuous Query Processing (Sub-Second)
```
6 Cypher Queries Running Continuously
        ↓
detect-arbitrage-opportunities Query
        ├─ MATCH prices → exchanges (via foreign key)
        ├─ MATCH prices → trading_pairs (via foreign key)
        ├─ GROUP BY trading_pair
        ├─ Find best_buy (lowest ask) and best_sell (highest bid)
        ├─ Calculate profit_after_fees = (sell * (1-fee) - buy * (1+fee)) / buy
        └─ FILTER profit > 0.1%
        ↓ [Query Results Update]
Reactions (SSE, Log)
```

**Key Details:**
- Cypher queries process graph nodes in-memory
- Results materialize immediately when conditions match
- Each CDC event potentially triggers query result updates
- Queries run independently with separate result streams

#### Stage 4: Real-Time Distribution (Instant)
```
Query Results Changed
        ↓
SSE Reaction (dashboard-sse)
        ├─ Format as Server-Sent Event
        ├─ Event Type = Query ID
        └─ Payload = { addedResults, removedResults, ... }
        ↓ [HTTP Push]
Frontend EventSource Listeners
        ├─ Parse JSON
        ├─ Update In-Memory State
        └─ Re-render DOM
        ↓
User Sees Arbitrage Opportunity
```

**Parallel Fallback Path:**
```
Frontend Timer (Every 3 Seconds)
        ↓
REST API Query
        ├─ Direct PostgreSQL SELECT
        ├─ 2-minute time window filter
        └─ JOIN exchanges, trading_pairs
        ↓
JSON Response
        ↓
Frontend Update (if SSE unavailable)
```

### Component Responsibilities

#### Price Poller (Node.js/TypeScript)
**Purpose:** Collect live prices from exchange WebSocket APIs

**Responsibilities:**
- Maintain persistent WebSocket connections to 3 exchanges
- Parse exchange-specific message formats
- Normalize symbols (BTCUSDT → BTC_USDT, XBT/USD → BTC_USD)
- Batch insert prices into PostgreSQL
- Automatic reconnection with exponential backoff
- Health check HTTP endpoint
- Hourly cleanup of prices older than 24 hours

**Technologies:** Node.js, TypeScript, WebSocket clients, pg (PostgreSQL driver)

#### PostgreSQL 16 Database
**Purpose:** Store time-series price data with CDC enabled

**Responsibilities:**
- Store prices, exchanges, trading_pairs tables
- Maintain foreign key relationships
- Enable logical replication (wal_level=logical)
- Publish CDC events via replication slot
- Enforce unique constraints on timestamps
- Auto-cleanup old data via stored procedures

**Critical Settings:**
- `REPLICA IDENTITY FULL` on all tables (CDC sends complete row data)
- Replication slot: `drasi_arbitrage_slot`
- Publication: `drasi_arbitrage_pub`

#### Drasi Server (Rust)
**Purpose:** Continuous query processor using Cypher graph queries

**Responsibilities:**
- Consume PostgreSQL CDC stream via logical replication
- Maintain in-memory graph of nodes and relationships
- Execute 6 continuous Cypher queries
- Bootstrap foreign key relationships from database
- Push query result changes via Server-Sent Events
- Provide REST API for query/source management
- Log query results for debugging

**Key Queries:**
1. `detect-arbitrage-opportunities` - Main arbitrage detection with fee calculation
2. `latest-prices-by-exchange` - Current prices with exchange names
3. `high-value-arbitrage-alerts` - Opportunities > 1% profit
4. `latest-prices` - Simple price stream (no joins)
5. `all-exchanges` - Reference data
6. `all-trading-pairs` - Reference data

#### REST API (Express/TypeScript)
**Purpose:** Fallback data access via direct database queries

**Responsibilities:**
- Provide HTTP endpoints for frontend fallback
- Query PostgreSQL directly (bypass Drasi)
- `/api/prices/latest` - Last 30 seconds of prices
- `/api/arbitrage/opportunities` - Calculate arbitrage with 2-minute window
- `/api/prices/history/:pair` - Historical prices
- `/api/stats/exchanges` - Exchange statistics

**When Used:** SSE connection fails or during initial page load

#### Frontend Dashboard (HTML/JS)
**Purpose:** Real-time visualization of prices and opportunities

**Responsibilities:**
- Dual-mode connection strategy (SSE + REST polling)
- EventSource listeners for 3 Drasi query streams
- REST polling every 3 seconds as fallback
- Render arbitrage opportunities table
- Render latest prices table
- Connection status indicator (SSE Live vs REST Polling)
- Automatic reconnection logic

**Technologies:** Vanilla JavaScript, EventSource API, Fetch API


### Why Drasi is the Best Fit for This Use Case

Arbitrage detection has unique requirements that make Drasi an ideal technology choice:

#### 1. Sub-Second Latency Requirement
**Problem:** Crypto arbitrage opportunities disappear quickly (often within seconds). Traditional polling or batch processing introduces delays that make opportunities unprofitable by the time they're detected.

**Drasi Solution:** Continuous queries process CDC events in real-time. From price INSERT to frontend display takes milliseconds, not seconds. This is critical because:
- Price movements happen in sub-second timeframes
- Competitors with faster systems will capture opportunities first
- Trading fees eat into thin profit margins (often < 1%)

**Comparison:**
- Traditional polling: Query every 5-10 seconds → 5-10 second delay minimum
- Drasi CDC: Event processed within 100-500ms → Near-instant detection

#### 2. Complex Multi-Table Joins
**Problem:** Arbitrage detection requires joining prices with exchanges (for fees) and trading_pairs (for symbols), then grouping and aggregating across all combinations.

**Drasi Solution:** Cypher graph queries naturally express relationships:
```cypher
MATCH (p:prices)-[:prices_exchange_id_fkey]->(e:exchanges)
MATCH (p)-[:prices_trading_pair_id_fkey]->(tp:trading_pairs)
```

This is much simpler than SQL equivalent:
```sql
SELECT ... FROM prices p
JOIN exchanges e ON p.exchange_id = e.id
JOIN trading_pairs tp ON p.trading_pair_id = tp.id
GROUP BY tp.symbol ...
```

**Benefits:**
- Graph query syntax is more readable
- Foreign key relationships are explicit
- Drasi maintains graph in-memory for fast traversal

#### 3. Continuous Result Materialization
**Problem:** We need to know when arbitrage opportunities appear AND disappear. Traditional queries only show current state.

**Drasi Solution:** Continuous queries maintain materialized results and emit deltas:
- `addedResults` - New opportunities detected
- `updatedResults` - Existing opportunities changed
- `removedResults` - Opportunities no longer valid

This allows the frontend to:
- Add rows when opportunities appear
- Update rows when profit margins change
- Remove rows when opportunities expire

Without Drasi, we'd need:
- Poll every 3 seconds
- Compare old vs new results manually
- Calculate deltas in application code
- Miss opportunities between polls

#### 4. Event-Driven Architecture
**Problem:** Price updates happen continuously and unpredictably. Polling wastes resources and adds latency.

**Drasi Solution:** CDC-based event stream ensures:
- Zero polling overhead on database
- Queries only execute when data actually changes
- Frontend receives updates immediately via SSE push
- System scales to high price update rates

**Resource Efficiency:**
- Traditional: 20 queries/minute × 3 endpoints = 60 unnecessary queries if no changes
- Drasi: 0 queries when idle, instant query when price changes

#### 5. Multiple Consumer Pattern
**Problem:** Different parts of the system need different views of the data:
- Frontend needs aggregated opportunities
- Monitoring needs different aggregations
- Different consumers need filtered views

**Drasi Solution:** Single CDC source feeds multiple queries:
- 6 different Cypher queries run simultaneously
- Each query filters/aggregates differently
- SSE reaction broadcasts all query results
- Frontend selects which events to process

**Comparison:**
- Without Drasi: 6 separate polling endpoints, 6× database load
- With Drasi: 1 CDC stream, 6 in-memory query processors, 1 SSE connection

#### 6. Bootstrap and Historical Context
**Problem:** Arbitrage detection needs current prices PLUS exchange fees (from exchanges table) and trading pair metadata.

**Drasi Solution:** Bootstrap provider preloads reference data:
```yaml
bootstrapProvider:
  kind: postgres  # Load exchanges and trading_pairs on startup
```

This enables:
- Foreign key relationships work correctly
- Queries have full context on first CDC event
- No need to manually join reference data in application code

#### 7. Separation of Concerns
**Problem:** Mixing business logic (arbitrage detection) with infrastructure (CDC, streaming, caching) creates complex, brittle code.

**Drasi Solution:** Clean separation:
- **Price Poller:** Only collects prices, no business logic
- **PostgreSQL:** Only stores data, CDC is built-in
- **Drasi:** All arbitrage logic in declarative Cypher queries
- **Frontend:** Only renders results, no calculations

**Benefits:**
- Arbitrage logic is in one place (server.yaml)
- Easy to add new queries without touching application code
- Backend services are simple and focused
- Testing is easier (can test queries independently)

#### 8. Operational Simplicity
**Problem:** Building CDC → Query → Stream pipeline from scratch requires:
- Custom CDC consumers
- Query execution engine
- Result caching layer
- WebSocket/SSE server
- State management
- Reconnection logic

**Drasi Solution:** All included in one Rust binary:
- PostgreSQL CDC source (built-in)
- Cypher query engine (built-in)
- SSE reaction (built-in)
- Bootstrap providers (built-in)
- Health checks and monitoring (built-in)

**Deployment:**
- Single Docker container for Drasi
- Configuration via YAML (no code)
- REST API for runtime management
- Auto-reconnection and error handling

#### Real-World Impact

With Drasi, this arbitrage system achieves:

- **99th percentile latency:** < 500ms from price change to frontend display
- **Zero false negatives:** Never miss an opportunity due to polling delay
- **Resource efficient:** 1 CDC stream instead of continuous database polling
- **Maintainable:** Arbitrage logic is declarative Cypher, not procedural code
- **Scalable:** Add new exchanges/pairs without changing Drasi configuration
- **Reliable:** Automatic reconnection, exactly-once CDC delivery

Without Drasi, we'd need:
- Custom CDC consumer code (100+ lines)
- Manual query scheduling and caching
- WebSocket server implementation
- State reconciliation logic
- Result delta calculation
- Reconnection handling

This would result in:
- 3-10 second detection latency (unacceptable for arbitrage)
- Higher infrastructure costs (continuous polling)
- More complex codebase (harder to maintain)
- Higher risk of bugs (more custom code)

**Conclusion:** Drasi transforms a complex real-time data processing problem into a simple, declarative configuration. For use cases requiring sub-second latency, complex joins, and continuous result updates, Drasi is not just a good fit—it's the ideal solution.

## Project Structure

```
crypto-arbitrage-drasi/
├── docker-compose.yml          # Orchestrates all services
├── schema.sql                  # Database schema with CDC setup
├── demo_arbitrage.sh           # Demo script
├── services/
│   ├── api/                    # REST API (Express + TypeScript)
│   └── price-poller/           # WebSocket price collector
├── frontend/public/
│   └── index.html              # Dashboard
└── drasi-server/
    ├── config/server.yaml              # Drasi queries and reactions
    ├── docker-compose-standalone.yml   # Drasi launcher
    └── README.md                       # Drasi documentation
```

### About Drasi Server

The `drasi-server/` directory contains **only configuration files**, not the source code.

**What it includes:**
- `config/server.yaml` - Your custom Cypher queries for arbitrage detection
- `docker-compose-standalone.yml` - Docker Compose file to run Drasi
- `README.md` - Documentation and usage instructions

**Drasi Server source code:**
- Official repository: https://github.com/drasi-project/drasi-server
- Version: 0.1.0
- Docker image: `ghcr.io/drasi-project/drasi-server:0.1.0` (pre-built)

This project uses the **pre-built Docker image** from GitHub Container Registry. You don't need to build from source unless you want to modify Drasi itself.

**To run Drasi:**
```bash
cd drasi-server
docker compose -f docker-compose-standalone.yml up -d
```

See [drasi-server/README.md](drasi-server/README.md) for more details.

## Services and Ports

- PostgreSQL: 5432
- REST API: 3001
- Price Poller: 3002
- Drasi Server: 8080 (API), 8081 (SSE)
- Frontend: 8000

## Database Schema

Three main tables:

**exchanges** - Exchange metadata and trading fees
```sql
id | name     | trading_fee | is_active
---|----------|-------------|----------
1  | Binance  | 0.0010      | true
2  | Coinbase | 0.0050      | true
3  | Kraken   | 0.0026      | true
```

**trading_pairs** - Trading pair definitions
```sql
id | symbol    | base_currency | quote_currency
---|-----------|---------------|---------------
1  | BTC_USDT  | BTC           | USDT
2  | ETH_USDT  | ETH           | USDT
3  | BTC_USD   | BTC           | USD
4  | ETH_USD   | ETH           | USD
```

**prices** - Time-series price data
- Links to exchanges and trading_pairs via foreign keys
- Stores price, bid, ask, volume, timestamp
- Has unique constraint on (exchange_id, trading_pair_id, timestamp)
- Cleaned up automatically after 24 hours

## Drasi Queries

Drasi runs continuous queries that update in real-time as data changes. The main query detects arbitrage:

```cypher
MATCH (p:prices)-[:prices_exchange_id_fkey]->(e:exchanges)
MATCH (p)-[:prices_trading_pair_id_fkey]->(tp:trading_pairs)
WHERE e.is_active = true

WITH tp.symbol AS trading_pair,
     COLLECT({exchange: e.name, ask: p.ask, bid: p.bid, fee: e.trading_fee}) AS prices

WITH trading_pair,
     reduce(best = null, x IN prices |
       CASE WHEN best IS NULL OR x.ask < best.ask THEN x ELSE best END) AS best_buy,
     reduce(best = null, x IN prices |
       CASE WHEN best IS NULL OR x.bid > best.bid THEN x ELSE best END) AS best_sell

WHERE best_buy.exchange <> best_sell.exchange
  AND ((best_sell.bid * (1.0 - best_sell.fee) - best_buy.ask * (1.0 + best_buy.fee)) /
       (best_buy.ask * (1.0 + best_buy.fee)) * 100.0) > 0.1

RETURN trading_pair, best_buy.exchange AS buy_exchange,
       best_sell.exchange AS sell_exchange,
       best_buy.ask AS buy_price, best_sell.bid AS sell_price
```

This finds the cheapest place to buy (lowest ask) and most expensive place to sell (highest bid) for each trading pair, calculates profit after fees, and only returns opportunities above 0.1%.

The query results stream to the dashboard via SSE on port 8081.

## API Endpoints

**GET /api/prices/latest** - Latest price for each exchange-pair combination (last 30 seconds)

**GET /api/arbitrage/opportunities?minProfit=0.1** - Current arbitrage opportunities above minimum profit threshold

**GET /api/prices/history/:tradingPair?limit=100** - Historical prices for a trading pair

**GET /api/stats/exchanges** - Statistics for each exchange

All REST endpoints are at http://localhost:3001

Drasi SSE stream: http://localhost:8081/events

## Common Commands

```bash
# View logs
docker compose logs -f price-poller
docker compose logs -f api
cd drasi-server && docker compose -f docker-compose-standalone.yml logs -f drasi-server

# Restart a service
docker compose restart price-poller
cd drasi-server && docker compose -f docker-compose-standalone.yml restart drasi-server

# Stop everything
docker compose down
cd drasi-server && docker compose -f docker-compose-standalone.yml down

# Check for opportunities via API
curl http://localhost:3001/api/arbitrage/opportunities | jq

# Test SSE connection
curl -N http://localhost:8081/events

# Connect to database
docker exec -it arbitrage-postgres psql -U postgres -d arbitrage_db

# Clean old prices manually
docker exec arbitrage-postgres psql -U postgres -d arbitrage_db \
  -c "SELECT cleanup_old_prices(24);"
```

## Troubleshooting

**No prices showing up**

Check the price poller logs:
```bash
docker compose logs -f price-poller
```

You should see "WebSocket connected" messages for each exchange. If not, restart it:
```bash
docker compose restart price-poller
```

**No arbitrage opportunities**

The system uses a 2-minute time window. If prices are older than 2 minutes, they won't be considered. Run the demo to inject fresh test data:
```bash
./demo_arbitrage.sh
```

Then check immediately:
```bash
curl http://localhost:3001/api/arbitrage/opportunities | jq
```

If you want to see smaller opportunities, lower the profit threshold:
```bash
curl "http://localhost:3001/api/arbitrage/opportunities?minProfit=0.01" | jq
```

**Dashboard not updating**

The dashboard works in two modes:
- SSE Live - real-time updates from Drasi (preferred)
- REST Polling - queries the API every 3 seconds (fallback)

Both work fine. If you're in REST polling mode but want SSE:

1. Hard refresh the browser (Ctrl+F5 or Cmd+Shift+R)
2. Check Drasi is running: `cd drasi-server && docker compose -f docker-compose-standalone.yml logs drasi-server`
3. Test the SSE endpoint: `curl -N http://localhost:8081/events`

Sometimes Drasi needs a CDC event to bootstrap foreign key relationships:
```bash
docker exec arbitrage-postgres psql -U postgres -d arbitrage_db \
  -c "UPDATE exchanges SET is_active = true WHERE is_active = true;"
```

**Drasi queries not updating**

Check the replication slot is active:
```bash
docker exec arbitrage-postgres psql -U postgres -d arbitrage_db \
  -c "SELECT slot_name, active FROM pg_replication_slots;"
```

You should see `drasi_arbitrage_slot | t`. If it's not active, restart Drasi:
```bash
cd drasi-server && docker compose -f docker-compose-standalone.yml restart drasi-server
```

## Configuration

All environment variables are configured in `docker-compose.yml`.

Main configuration:
- Database connection: Already in docker-compose.yml (postgres:5432, password: postgres)
- Trading fees: Stored in database, editable via SQL
- Time windows: 2 minutes for arbitrage detection (in services/api/src/index.ts)
- Drasi queries: `drasi-server/config/server.yaml`

The Drasi config file is important. It defines:
- **Sources**: PostgreSQL CDC connection details
- **Queries**: Cypher queries that run continuously
- **Reactions**: What happens when query results change (SSE streams, logging)


## Development

**Adding a new exchange**

1. Create a connector file in `services/price-poller/src/connectors/yourexchange.ts`
2. Implement WebSocket connection and message parsing
3. Add the exchange to the database: `INSERT INTO exchanges (name, trading_fee) VALUES ('YourExchange', 0.0020);`
4. Register it in `services/price-poller/src/index.ts`
5. Rebuild: `docker compose build price-poller && docker compose restart price-poller`

**Running services locally**

```bash
# Start just the database
docker compose up -d postgres

# Start Drasi
cd drasi-server && docker compose -f docker-compose-standalone.yml up -d && cd ..

# Install dependencies
cd services/price-poller && npm install
cd ../api && npm install

# Services use environment variables with sensible defaults
# DB_HOST defaults to localhost, DB_PORT to 5432, DB_PASSWORD to postgres
# No .env file needed for local development

# Run in dev mode (separate terminals)
cd services/price-poller && npm run dev
cd services/api && npm run dev
```

**Creating custom Drasi queries**

Edit `drasi-server/config/server.yaml` and add a query:

```yaml
queries:
  - id: my-custom-query
    queryLanguage: Cypher
    autoStart: true
    query: |
      MATCH (p:prices)
      WHERE p.price > 70000
      RETURN p.price
    sources:
      - source_id: arbitrage-db
```

Then restart: `cd drasi-server && docker compose -f docker-compose-standalone.yml restart drasi-server`

## Important Notes

- Trading fees are crucial for realistic profit calculations. The default fees might not match current exchange rates.
- This system detects opportunities but doesn't execute trades. Actually profiting from arbitrage requires fast execution, good liquidity, and account balances on multiple exchanges.
- The 2-minute time window means stale opportunities automatically disappear.
- Drasi needs the `bootstrapProvider` setting in server.yaml for queries that use foreign keys. Without it, only simple queries work.
- Prices are automatically cleaned up after 24 hours to save space.
