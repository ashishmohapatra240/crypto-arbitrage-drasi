#!/bin/bash

# Demo: Inject Arbitrage Opportunity
# Stops price-poller, injects test data, shows opportunity

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "CRYPTO ARBITRAGE DEMO - Inject Test Opportunity"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Step 1: Stop price-poller
echo "Step 1: Stopping price-poller (to prevent real data interference)..."
docker stop arbitrage-price-poller > /dev/null 2>&1
sleep 1
echo "   Price-poller stopped"
echo ""

# Step 2: Clear old test data and recent prices
echo "Step 2: Clearing BTC_USD test data and recent prices..."
docker exec arbitrage-postgres psql -U postgres -d arbitrage_db -t -c \
  "DELETE FROM prices WHERE trading_pair_id = 3 AND (price IN (67000, 68500) OR timestamp > NOW() - interval '5 minutes');" > /dev/null 2>&1
echo "   Cleared test data and recent prices"
echo ""

# Step 3: Inject arbitrage opportunity
echo "Step 3: Injecting BTC_USD arbitrage opportunity..."
docker exec arbitrage-postgres psql -U postgres -d arbitrage_db -c \
  "INSERT INTO prices (exchange_id, trading_pair_id, price, bid, ask, volume_24h, timestamp)
   VALUES (1, 3, 67000.00, 66999.00, 67001.00, 1000.00, NOW()),
          (2, 3, 68500.00, 68499.00, 68501.00, 2000.00, NOW());" > /dev/null 2>&1

echo "   Buy on Binance @ \$67,001"
echo "   Sell on Coinbase @ \$68,499"
echo "   Expected profit: ~1.71% after fees"
echo "   Test data injected"
echo ""

# Step 4: Wait a moment
sleep 1

# Step 5: Query for opportunities
echo "Step 4: Querying for arbitrage opportunities..."
echo ""

result=$(curl -s "http://localhost:3001/api/arbitrage/opportunities?minProfit=0.1")
count=$(echo $result | jq -r '.count')

if [ "$count" -gt 0 ]; then
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "SUCCESS! Found $count arbitrage opportunity:"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo $result | jq -r '.opportunities[] |
"Trading Pair:     \(.trading_pair) (\(.base_currency)/\(.quote_currency))
BUY Exchange:     \(.buy_exchange) @ $\(.buy_price)
SELL Exchange:    \(.sell_exchange) @ $\(.sell_price)
Profit After Fees: \(.profit_after_fees)%
Raw Spread:        \(.spread_percentage)%
Data Age:          \(.max_age_seconds) seconds"'
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
else
    echo "No opportunities found"
fi

echo ""
echo "View on Dashboard:"
echo "   1. Serve frontend: cd frontend/public && python3 -m http.server 8080"
echo "   2. Open browser: http://localhost:8080"
echo ""
echo "Resume live data collection:"
echo "   docker start arbitrage-price-poller"
echo ""
echo "Note: The test opportunity will persist until new real prices arrive"
echo "Note: To see it on the dashboard, refresh the page"
echo ""
