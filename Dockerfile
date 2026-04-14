FROM node:22-alpine

WORKDIR /app

COPY lambda_function/ ./

RUN npm ci --omit=dev

EXPOSE 3000

CMD ["npm", "start"]
