# Imagen base ligera de Node 20
FROM node:20-slim

# Variables para no tener preguntas en apt
ENV DEBIAN_FRONTEND=noninteractive

# Dependencias del sistema necesarias para Chromium/Puppeteer
RUN apt-get update && apt-get install -y \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libexpat1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    wget \
  && rm -rf /var/lib/apt/lists/*

# Carpeta de trabajo
WORKDIR /usr/src/app

# Copia package.json y package-lock (si existe)
COPY package*.json ./

# Instala dependencias (incluye descarga de Chromium de Puppeteer)
RUN npm install --omit=dev

# Copia el resto del código
COPY . .

# Puerto que usará la app (Render asigna PORT, pero dejamos por defecto 10000)
EXPOSE 10000

# Comando de arranque
CMD ["node", "index.js"]
