#!/bin/sh
set -eu
chown rabbitmq:rabbitmq /var/lib/rabbitmq
if [ ! -f /var/lib/rabbitmq/.erlang.cookie ]; then
  umask 077
  head -c 32 /dev/urandom | base64 > /var/lib/rabbitmq/.erlang.cookie
fi
chown rabbitmq:rabbitmq /var/lib/rabbitmq/.erlang.cookie
chmod 600 /var/lib/rabbitmq/.erlang.cookie
