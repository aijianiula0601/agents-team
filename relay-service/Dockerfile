# ------------ 使用公共基础镜像构建中转站 ---------------
ARG GO_BASE_IMAGE=golang:1.26-alpine
ARG RUNTIME_BASE_IMAGE=alpine:3.23

FROM ${GO_BASE_IMAGE} AS builder

ENV GOPROXY=https://proxy.golang.org,direct
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/agents-team-relay ./cmd/server

FROM ${RUNTIME_BASE_IMAGE}

RUN apk add --no-cache ca-certificates tzdata \
  && addgroup -S app \
  && adduser -S -G app app
WORKDIR /app
COPY --from=builder /out/agents-team-relay /app/agents-team-relay

EXPOSE 8000
ENV RELAY_LISTEN_ADDR=:8000
USER app
CMD ["/app/agents-team-relay"]
