FROM golang:1.25-alpine AS builder
RUN apk add --no-cache git
RUN CGO_ENABLED=0 go install github.com/minio/minio@latest
FROM alpine:3.22
RUN apk add --no-cache ca-certificates
COPY --from=builder /go/bin/minio /usr/local/bin/minio
ENTRYPOINT ["minio"]
