#!/bin/bash

# Quick Arbitrage Injection - Simple Version
# Creates a clear BTC arbitrage opportunity

echo "Creating Test Arbitrage Opportunity..."
echo ""

# Create a BTC_USD arbitrage: Buy low on Coinbase, Sell high on Kraken
docker exec arbitrage-postgres psql -U postgres -d arbitrage_db <<'EOF'
-- Create a clear 1.5% arbitrage opportunity for BTC_USD
INSERT INTO prices (exchange_id, trading_pair_id, price, bid, ask, volume_24h, timestamp)
VALUES
  -- Coinbase (exchange_id=2): Lower price - BUY HERE
  (2, 3, 67000.00, 66999.00, 67001.00, 1000.00, NOW()),
  
  -- Kraken (exchange_id=3): Higher price - SELL HERE  
  (3, 3, 68000.00, 67999.00, 68001.00, 2000.00, NOW())

ON CONFLICT (exchange_id, trading_pair_id, timestamp) DO UPDATE
SET price = EXCLUDED.price, bid = EXCLUDED.bid, ask = EXCLUDED.ask;

SELECT 'Test arbitrage opportunity created!' as status;
EOF

echo ""
echo "Injected BTC_USD arbitrage opportunity:"
echo "   Buy on Coinbase @ \$67,001 (ask price)"
echo "   Sell on Kraken @ \$67,999 (bid price)"
echo "   Expected profit: ~1.4% after fees"
echo ""

# Wait a moment for the data to be available
sleep 1

echo "Checking for opportunities..."
echo ""

# Show the arbitrage opportunity
curl -s "http://localhost:3001/api/arbitrage/opportunities?minProfit=0.1" | jq -r '
if .count > 0 then
  "FOUND " + (.count | tostring) + " OPPORTUNITY(IES):\n" +
  (.opportunities[] |
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
    "Pair: " + .trading_pair + "\n" +
    "Buy:  " + .buy_exchange + " @ $" + .buy_price + "\n" +
    "Sell: " + .sell_exchange + " @ $" + .sell_price + "\n" +
    "Profit: " + .profit_after_fees + "% (after fees)\n" +
    "Spread: " + .spread_percentage + "%\n" +
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  )
else
  "No opportunities found (try lowering minProfit threshold)"
end
'

echo ""
echo "View all latest prices:"
echo "   curl http://localhost:3001/api/prices/latest | jq"
echo ""
echo "To inject more opportunities, run this script again!"
echo "Real live prices will continue updating from exchanges"
echo ""
