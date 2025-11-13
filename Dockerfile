FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /app

# cache de dependencias
COPY package.json ./
RUN npm install --omit=dev

# código
COPY index.js ./

# Render acostumbra a usar PORT=10000
ENV PORT=10000
EXPOSE 10000

CMD ["node","index.js"]
