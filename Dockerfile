# ✅ Trae Chromium ya instalado
FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /app

# Cachea la instalación
COPY package.json ./
RUN npm install --omit=dev

# Copia tu código
COPY index.js ./

# Render asigna PORT=10000 a servicios Node
ENV PORT=10000
EXPOSE 10000

CMD ["node","index.js"]
