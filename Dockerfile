# Playwright LEVE (somente Chromium)
FROM mcr.microsoft.com/playwright:v1.41.2-jammy

WORKDIR /app

# Dependências de display + VNC + websocket
RUN apt-get update && apt-get install -y \
    xvfb \
    x11vnc \
    websockify \
    && rm -rf /var/lib/apt/lists/*

# Dependências Node
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Código
COPY . .

ENV PORT=8080

CMD ["node", "src/server.js"]
