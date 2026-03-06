FROM node:22-alpine AS web-builder

WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ .
RUN npm run build

FROM golang:1.25.7-alpine AS builder

WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .
COPY --from=web-builder /src/web/dist web/dist
RUN go build -o /strata ./cmd/strata

FROM alpine:3.21

COPY --from=builder /strata /strata

EXPOSE 8080

CMD ["/strata"]
