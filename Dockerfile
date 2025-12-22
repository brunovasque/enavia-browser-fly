FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:99
ENV PORT=8080

WORKDIR /app

# ================================
# SYSTEM DEPENDENCIES
# ================================
RUN apt-get update && apt-get install -y \
  curl \
  nodejs \
  npm \
  xvfb \
  x11vnc \
  novnc \
  websockify \
  openbox \
  xterm \
  && rm -rf /var/lib/apt/lists/*

# ================================
# APP FILES
# ================================
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

EXPOSE 8080 5900 6080

# ================================
# START
# ================================
# - openbox cria o desktop
# - xterm prova visualmente que o X está vivo
# - node sobe o servidor
CMD ["bash", "-lc", "openbox & xterm & node server.cjs"]
