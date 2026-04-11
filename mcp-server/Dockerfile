FROM node:20-alpine
WORKDIR /app

# Copy manifests first so npm install is cached when only source changes
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3001
CMD ["node", "server.js"]
