#!/usr/bin/env bash
# Kills any leftover hardhat node, starts a fresh one, deploys, starts frontend

# 1. Kill any process already using port 8545
echo "Clearing port 8545..."
lsof -ti:8545 | xargs kill -9 2>/dev/null || true

# 2. Start hardhat node in background, log to file
echo "Starting Hardhat node..."
npx hardhat node > hardhat.log 2>&1 &
HARDHAT_PID=$!

# 3. Wait until port 8545 is accepting connections
echo "Waiting for node to be ready..."
npx wait-on tcp:8545 --timeout 30000

# 4. Deploy contract (nonce is always 0 now → always same address)
echo "Deploying contract..."
npx hardhat run scripts/deploy.js --network localhost

# 5. Start React frontend
echo "Starting frontend..."
cd frontend && npm start

# 6. On exit (Ctrl+C), kill the hardhat node too
trap "kill $HARDHAT_PID" EXIT
