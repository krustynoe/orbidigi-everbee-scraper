FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /app

# Copiamos sólo package.json para cachear instalación
COPY package.json ./
# Si tienes package-lock.json lo puedes omitir; no es obligatorio
# COPY package-lock.json ./

RUN npm install --omit=dev

# Copiamos el código
COPY index.js ./

# Render suele asignar PORT=10000 en Node, respetamos el env var
ENV PORT=10000
EXPOSE 10000

CMD ["node","index.js"]
