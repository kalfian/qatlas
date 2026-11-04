#!/bin/sh
# Initialise the single-node Garage of deploy/docker-compose.yml (profile s3):
# layout, bucket, access key and bucket permissions. Idempotent; prints the
# QATLAS_S3_* lines for deploy/.env.
#
#   docker compose -f deploy/docker-compose.yml --profile s3 up -d garage
#   deploy/garage/init.sh [bucket] [key-name]        # defaults: qatlas qatlas-app
#
# QATLAS_COMPOSE overrides the compose command (default: docker compose -f
# <this repo>/deploy/docker-compose.yml). The secret key is printed only when
# the key is created; for an existing key use the Garage WebUI (Keys page) or
# `garage key info --secret-key <key-name>`.
set -eu

bucket=${1:-qatlas}
keyname=${2:-qatlas-app}
here=$(cd "$(dirname "$0")" && pwd)
compose=${QATLAS_COMPOSE:-"docker compose -f $here/../docker-compose.yml"}

garage() {
	# shellcheck disable=SC2086 # $compose is a command line
	$compose exec -T garage /garage "$@" 2>/dev/null
}

i=0
until garage status >/dev/null; do
	i=$((i + 1))
	if [ "$i" -ge 30 ]; then
		echo "garage is not running: $compose --profile s3 up -d garage" >&2
		exit 1
	fi
	sleep 1
done

if garage status | grep -q 'NO ROLE ASSIGNED'; then
	node=$(garage node id -q | cut -c1-16)
	version=$(garage layout show | sed -n 's/^Current cluster layout version: *//p')
	echo "assigning layout to node $node (capacity ${GARAGE_CAPACITY:-100G})"
	garage layout assign -z dc1 -c "${GARAGE_CAPACITY:-100G}" "$node" >/dev/null
	garage layout apply --version $((${version:-0} + 1)) >/dev/null
fi

if garage bucket info "$bucket" >/dev/null; then
	echo "bucket $bucket exists"
else
	garage bucket create "$bucket" >/dev/null
	echo "created bucket $bucket"
fi

secret=""
if garage key info "$keyname" >/dev/null; then
	echo "key $keyname exists"
else
	garage key create "$keyname" >/dev/null
	secret=$(garage key info --secret-key "$keyname" | tail -n 1)
	echo "created key $keyname"
fi
garage bucket allow --read --write "$bucket" --key "$keyname" >/dev/null
access=$(garage key info --key-id "$keyname" | tail -n 1)

cat <<ENV

# --- enter these in Admin → Storage (recommended: endpoint, region, bucket, access key ID,
# --- secret), or pin them via the environment: add to deploy/.env, then
# --- docker compose -f deploy/docker-compose.yml up -d
QATLAS_STORAGE=s3
QATLAS_S3_ENDPOINT=http://garage:3900
QATLAS_S3_REGION=garage
QATLAS_S3_BUCKET=$bucket
QATLAS_S3_ACCESS_KEY=$access
QATLAS_S3_SECRET_KEY=${secret:-<shown only when the key is created: Garage WebUI Keys page or garage key info --secret-key $keyname>}
ENV
