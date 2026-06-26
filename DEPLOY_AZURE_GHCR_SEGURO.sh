#!/usr/bin/env bash
set -euo pipefail

RESOURCE_GROUP="rg-georural-wms-br"
ENVIRONMENT="georural-wms-br-env"
APP_NAME="georural-wms-proxy-br"
LOCATION="brazilsouth"
DEFAULT_REPO="georural-wms-proxy-br"

printf '\n=== GeoRural Proxy WMS - Deploy seguro via GHCR ===\n'
read -rp "Digite seu usuário do GitHub [codebykaua]: " GITHUB_USER
GITHUB_USER="${GITHUB_USER:-codebykaua}"
read -rp "Digite somente o nome do repositório [${DEFAULT_REPO}]: " GITHUB_REPO
GITHUB_REPO="${GITHUB_REPO:-$DEFAULT_REPO}"

# Aceita por engano URL completa e extrai apenas o último segmento.
GITHUB_REPO="${GITHUB_REPO%.git}"
GITHUB_REPO="${GITHUB_REPO##*/}"
GITHUB_USER="$(printf '%s' "$GITHUB_USER" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-')"
GITHUB_REPO="$(printf '%s' "$GITHUB_REPO" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9._-')"

if [[ -z "$GITHUB_USER" || -z "$GITHUB_REPO" ]]; then
  echo "Usuário ou repositório inválido." >&2
  exit 1
fi

IMAGE="ghcr.io/${GITHUB_USER}/${GITHUB_REPO}:latest"
printf '\nImagem selecionada: %s\n' "$IMAGE"
printf 'O token deve possuir somente read:packages. Ele não será exibido.\n'
read -rsp "Cole um NOVO token GitHub e pressione Enter: " GHCR_TOKEN
echo
if [[ -z "$GHCR_TOKEN" ]]; then
  echo "Token vazio. Deploy cancelado." >&2
  exit 1
fi

az extension add --name containerapp --upgrade --allow-preview true --yes >/dev/null
az provider register --namespace Microsoft.App --wait >/dev/null
az provider register --namespace Microsoft.OperationalInsights --wait >/dev/null
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" >/dev/null

if ! az containerapp env show --name "$ENVIRONMENT" --resource-group "$RESOURCE_GROUP" >/dev/null 2>&1; then
  az containerapp env create \
    --name "$ENVIRONMENT" \
    --resource-group "$RESOURCE_GROUP" \
    --location "$LOCATION" >/dev/null
fi

if ! az containerapp show --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" >/dev/null 2>&1; then
  echo "Criando Container App inicial..."
  az containerapp create \
    --name "$APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --environment "$ENVIRONMENT" \
    --image mcr.microsoft.com/k8se/quickstart:latest \
    --ingress external \
    --target-port 80 \
    --min-replicas 1 \
    --max-replicas 2 \
    --cpu 0.5 \
    --memory 1Gi >/dev/null
fi

echo "Atualizando credencial do GHCR..."
az containerapp registry set \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --server ghcr.io \
  --username "$GITHUB_USER" \
  --password "$GHCR_TOKEN" >/dev/null
unset GHCR_TOKEN

REVISION_SUFFIX="fix$(date +%H%M%S)"
echo "Publicando nova revisão: $REVISION_SUFFIX"
az containerapp update \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --image "$IMAGE" \
  --revision-suffix "$REVISION_SUFFIX" \
  --min-replicas 1 \
  --max-replicas 2 \
  --cpu 0.5 \
  --memory 1Gi \
  --set-env-vars \
    PORT=10000 \
    NODE_ENV=production \
    CORS_ORIGINS=https://georuralpro.vercel.app \
    WMS_PROXY_ALLOWED_HOSTS=geoserver.inema.ba.gov.br,geoserver.car.gov.br \
    WMS_PROXY_TIMEOUT_MS=60000 >/dev/null

az containerapp ingress update \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --type external \
  --target-port 10000 \
  --transport auto >/dev/null

FQDN="$(az containerapp show --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" --query properties.configuration.ingress.fqdn -o tsv)"
printf '\nProxy:  https://%s\n' "$FQDN"
printf 'Health: https://%s/health\n\n' "$FQDN"
printf 'Aguardando inicialização...\n'
for attempt in $(seq 1 30); do
  BODY="$(curl -fsS "https://${FQDN}/health" 2>/dev/null || true)"
  if printf '%s' "$BODY" | grep -q '"ok"'; then
    printf '%s\n' "$BODY"
    echo "DEPLOY CONCLUÍDO COM SUCESSO."
    exit 0
  fi
  sleep 5
done

echo "A revisão ainda não respondeu com JSON. Consulte as revisões e os logs." >&2
exit 2
