# Stage 1: Build frontend
FROM node:22-alpine AS frontend
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY index.html ./
COPY src ./src
COPY public ./public
COPY vite.config.ts tsconfig*.json components.json ./
RUN npm run build

# Stage 2: Build Go binary (embeds dist/)
FROM golang:1.24-alpine AS server
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY --from=frontend /app/dist ./dist
COPY *.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o server .

# Stage 3: Minimal runtime image
FROM alpine:latest
RUN apk add --no-cache ca-certificates
COPY --from=server /app/server /server
EXPOSE 8080
CMD ["/server"]
