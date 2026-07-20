#!/bin/sh
set -eu

: "${TURN_REST_SECRET:?TURN_REST_SECRET is required}"
: "${TURN_EXTERNAL_IP:?TURN_EXTERNAL_IP is required}"

if [ "$TURN_REST_SECRET" = "replace-with-64-random-hex-characters-before-deploying" ]; then
  echo "Replace the example TURN_REST_SECRET before deployment" >&2
  exit 1
fi

if [ "${#TURN_REST_SECRET}" -lt 43 ]; then
  echo "TURN_REST_SECRET must contain at least 32 random bytes" >&2
  exit 1
fi

case "$TURN_REST_SECRET" in
  *[!A-Za-z0-9_-]*)
    echo "TURN_REST_SECRET must be base64url or hexadecimal text" >&2
    exit 1
    ;;
esac

turn_realm=${TURN_REALM:-veilink}
case "$turn_realm" in
  *[!A-Za-z0-9._-]*)
    echo "TURN_REALM contains unsupported characters" >&2
    exit 1
    ;;
esac

turn_min_port=${TURN_MIN_PORT:-49160}
turn_max_port=${TURN_MAX_PORT:-49200}
case "$turn_min_port:$turn_max_port" in
  *[!0-9:]* | :* | *:)
    echo "TURN_MIN_PORT and TURN_MAX_PORT must be integers" >&2
    exit 1
    ;;
esac

if [ "$turn_min_port" -lt 1024 ] || [ "$turn_max_port" -gt 65535 ] || [ "$turn_min_port" -gt "$turn_max_port" ]; then
  echo "Invalid TURN relay port range" >&2
  exit 1
fi

case "$TURN_EXTERNAL_IP" in
  *[!0-9.]*)
    echo "TURN_EXTERNAL_IP must be an IPv4 address" >&2
    exit 1
    ;;
esac
if [ "$TURN_EXTERNAL_IP" = "203.0.113.10" ]; then
  echo "Replace the documentation TURN_EXTERNAL_IP before deployment" >&2
  exit 1
fi

turn_private_ip=${TURN_PRIVATE_IP:-}
if [ -z "$turn_private_ip" ]; then
  turn_private_ip=$(hostname -i)
  turn_private_ip=${turn_private_ip%% *}
fi
case "$turn_private_ip" in
  *[!0-9.]*)
    echo "TURN_PRIVATE_IP must be an IPv4 address" >&2
    exit 1
    ;;
esac

runtime_config=/tmp/turnserver.conf
umask 077
cp /etc/coturn/veilink.conf.template "$runtime_config"

{
  printf 'realm=%s\n' "$turn_realm"
  printf 'static-auth-secret=%s\n' "$TURN_REST_SECRET"
  printf 'external-ip=%s/%s\n' "$TURN_EXTERNAL_IP" "$turn_private_ip"
  printf 'min-port=%s\n' "$turn_min_port"
  printf 'max-port=%s\n' "$turn_max_port"
} >> "$runtime_config"

case "${TURN_TLS_ENABLED:-false}" in
true)
  : "${TURN_TLS_CERT_FILE:?TURN_TLS_CERT_FILE is required when TLS is enabled}"
  : "${TURN_TLS_KEY_FILE:?TURN_TLS_KEY_FILE is required when TLS is enabled}"
  case "$TURN_TLS_CERT_FILE:$TURN_TLS_KEY_FILE" in
    *[!A-Za-z0-9_./:-]*)
      echo "TURN TLS file paths contain unsupported characters" >&2
      exit 1
      ;;
  esac
  if [ ! -r "$TURN_TLS_CERT_FILE" ] || [ ! -r "$TURN_TLS_KEY_FILE" ]; then
    echo "TURN TLS certificate and key must be readable by uid 65534" >&2
    exit 1
  fi
  {
    printf 'tls-listening-port=5349\n'
    printf 'cert=%s\n' "$TURN_TLS_CERT_FILE"
    printf 'pkey=%s\n' "$TURN_TLS_KEY_FILE"
    printf 'no-dtls\n'
    printf 'no-tlsv1\n'
    printf 'no-tlsv1_1\n'
  } >> "$runtime_config"
  ;;
false)
  {
    printf 'no-tls\n'
    printf 'no-dtls\n'
  } >> "$runtime_config"
  ;;
*)
  echo "TURN_TLS_ENABLED must be true or false" >&2
  exit 1
  ;;
esac

exec /usr/local/bin/veilink-turnserver -c "$runtime_config"
