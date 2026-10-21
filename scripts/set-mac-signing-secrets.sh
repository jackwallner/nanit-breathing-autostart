#!/usr/bin/env bash
# Turns a Developer ID Application certificate into the repo secrets the Build workflow signs and
# notarises Mac builds with.
#
#   scripts/set-mac-signing-secrets.sh <private-key.pem> <developerID_application.cer> \
#       <AuthKey_XXXX.p8> <api key id> <api issuer id>
#
# The private key is the one the certificate request was made with; the .cer comes from
# developer.apple.com. The App Store Connect API key is used only for notarisation.
set -euo pipefail
key=${1:?private key}; cer=${2:?certificate}; p8=${3:?api key}; key_id=${4:?api key id}; issuer=${5:?issuer id}
repo=jackwallner/nanit-breathing-autostart
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
password=$(openssl rand -base64 24)
openssl x509 -inform DER -in "$cer" -out "$work/cert.pem" 2>/dev/null || cp "$cer" "$work/cert.pem"
openssl x509 -in "$work/cert.pem" -noout -subject | grep -q "Developer ID Application" || { echo "Not a Developer ID Application certificate." >&2; exit 1; }
openssl pkcs12 -export -legacy -inkey "$key" -in "$work/cert.pem" -out "$work/cert.p12" -passout "pass:$password" 2>/dev/null \
  || openssl pkcs12 -export -inkey "$key" -in "$work/cert.pem" -out "$work/cert.p12" -passout "pass:$password"
base64 < "$work/cert.p12" | tr -d '\n' | gh secret set MAC_CERT_P12 --repo "$repo"
printf '%s' "$password" | gh secret set MAC_CERT_PASSWORD --repo "$repo"
base64 < "$p8" | tr -d '\n' | gh secret set APPLE_API_KEY_BASE64 --repo "$repo"
printf '%s' "$key_id" | gh secret set APPLE_API_KEY_ID --repo "$repo"
printf '%s' "$issuer" | gh secret set APPLE_API_ISSUER --repo "$repo"
echo "Signing secrets set on $repo."
