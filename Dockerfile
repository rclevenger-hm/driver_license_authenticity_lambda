FROM node:lts-alpine

WORKDIR /app

COPY lambda_function/ ./

RUN npm ci --only=production

CMD ["npm", "start"]
