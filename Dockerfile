# Usa una imagen oficial de Node como base
FROM node:20-slim

# Instala dependencias necesarias para Chromium
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libxss1 \
    libxtst6 \
    xdg-utils \
    --no-install-recommends

# Añade el repositorio oficial de Chromium y su clave (opcional)
RUN apt-get install -y chromium && apt-get clean && rm -rf /var/lib/apt/lists/*

# Establece variables de entorno para Puppeteer
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Crea y usa un directorio de trabajo
WORKDIR /usr/src/app

# Copia los archivos package.json y package-lock.json
COPY package*.json ./

# Instala las dependencias de la aplicación
RUN npm install

# Copia el resto del código de la aplicación
COPY . .

# Expone el puerto en el que corre la app
EXPOSE 3000

# Comando por defecto para ejecutar la app
CMD ["node", "index.js"]
