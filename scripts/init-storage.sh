#!/bin/sh
set -eu
mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
mc mb --ignore-existing "local/$S3_BUCKET"
mc anonymous set none "local/$S3_BUCKET"
mc admin user add local "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" >/dev/null
cat > /tmp/kyc-policy.json <<EOF
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":["s3:ListBucket"],"Resource":["arn:aws:s3:::$S3_BUCKET"],"Condition":{"StringLike":{"s3:prefix":["kyc/*"]}}},
 {"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject"],"Resource":["arn:aws:s3:::$S3_BUCKET/kyc/*"]}
]}
EOF
mc admin policy create local finvault-kyc /tmp/kyc-policy.json >/dev/null
mc admin policy attach local finvault-kyc --user "$S3_ACCESS_KEY_ID" >/dev/null
echo 'Private KYC bucket and scoped service user ready.'
