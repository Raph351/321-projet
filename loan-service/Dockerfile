FROM node:20-alpine

# Required for better-sqlite3 native build
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 8002

CMD ["node", "app.js"]
