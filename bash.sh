#!/bin/bash
# bash.sh - Deploy Node.js (Fastify/Telegraf) and Go backend on EC2
# Usage: bash bash.sh
set -e

# --- CONFIGURATION ---
NODE_PORT=5000
GO_PORT=8080
NODE_ENV=production

# --- SYSTEM UPDATE & BASIC TOOLS ---
echo "[1/7] Updating system and installing basic tools..."
sudo apt-get update -y
sudo apt-get install -y curl git build-essential

# --- NODE.JS & NPM ---
echo "[2/7] Installing Node.js (if not present)..."
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# --- PM2 PROCESS MANAGER ---
echo "[3/7] Installing PM2 globally..."
sudo npm install -g pm2

# --- GO (GOLANG) ---
echo "[4/7] Installing Go (if not present)..."
if ! command -v go >/dev/null 2>&1; then
  wget https://go.dev/dl/go1.21.6.linux-amd64.tar.gz
  sudo tar -C /usr/local -xzf go1.21.6.linux-amd64.tar.gz
  export PATH=$PATH:/usr/local/go/bin
  echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.profile
  source ~/.profile
fi

echo "Go version: $(go version)"

# --- REDIS (OPTIONAL, if not using managed Redis) ---
echo "[5/7] Installing Redis (if not present)..."
if ! command -v redis-server >/dev/null 2>&1; then
  sudo apt-get install -y redis-server
  sudo systemctl enable redis-server
  sudo systemctl start redis-server
fi

# --- PROJECT SETUP ---
echo "[6/7] Installing Node.js dependencies..."
npm install

echo "[7/7] Building Go backend..."
go mod tidy
go build -o attendance_server main.go

# --- ENVIRONMENT VARIABLES (edit as needed) ---
export NODE_ENV=$NODE_ENV
export PORT=$NODE_PORT
export ATTENDANCE_API_URL="http://localhost:$GO_PORT/attendance"
export REDIS_URL="redis://localhost:6379"
# export BOT_TOKEN=your_telegram_bot_token_here

# --- RUNNING SERVICES ---
echo "[RUN] Starting Go backend (port $GO_PORT)..."
nohup ./attendance_server > go_backend.log 2>&1 &

echo "[RUN] Starting Node.js bot server with PM2 (port $NODE_PORT)..."
# Stop any previous instance
pm2 delete ecap-bot || true
pm2 start index.js --name ecap-bot --env $NODE_ENV

pm2 save

# --- STATUS ---
echo "--- Deployment Complete ---"
echo "Node.js bot running on port $NODE_PORT (PM2 name: ecap-bot)"
echo "Go backend running on port $GO_PORT (binary: attendance_server)"
echo "Check logs: 'pm2 logs ecap-bot' and 'tail -f go_backend.log'" 